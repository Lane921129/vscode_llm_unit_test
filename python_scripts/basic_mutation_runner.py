"""A dependency-free mutation-test fallback for Python environments without an engine.

It creates mutated copies in a temporary directory and runs the generated
unittest file against each copy.  Source files are never modified in place.
This is intentionally a small safety net; mutatest/mutmut remain preferred
when available.
"""

import ast
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


COMPARISON_REPLACEMENTS = {
    ast.Lt: ast.LtE,
    ast.LtE: ast.Lt,
    ast.Gt: ast.GtE,
    ast.GtE: ast.Gt,
    ast.Eq: ast.NotEq,
    ast.NotEq: ast.Eq,
}

BINARY_REPLACEMENTS = {
    ast.Add: ast.Sub,
    ast.Sub: ast.Add,
    ast.Mult: ast.FloorDiv,
    ast.FloorDiv: ast.Mult,
}

BOOLEAN_OPERATOR_REPLACEMENTS = {
    ast.And: ast.Or,
    ast.Or: ast.And,
}


CALLABLE_SCOPE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)
NO_PATTERN_MUTATION = object()


def mutation_scope_walk(scope):
    """Walk a selected function without charging its nested callables to it.

    When the user selected one function/method, mutations inside a locally
    declared helper or nested class are a different callable's responsibility.
    Module-wide analysis intentionally keeps its existing full-tree behaviour.
    """
    exclude_nested_callables = isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef))

    def visit(node):
        yield node
        for child in ast.iter_child_nodes(node):
            if exclude_nested_callables and isinstance(child, CALLABLE_SCOPE_NODES):
                continue
            yield from visit(child)

    yield from visit(scope)


def pattern_literal_replacement(node):
    """Return a safe replacement for scalar match patterns, if applicable."""
    match_value_type = getattr(ast, 'MatchValue', ())
    match_singleton_type = getattr(ast, 'MatchSingleton', ())
    if match_value_type and isinstance(node, match_value_type):
        value = getattr(node.value, 'value', NO_PATTERN_MUTATION)
        if isinstance(value, str):
            return value + '__mutated_case__'
    if match_singleton_type and isinstance(node, match_singleton_type):
        if node.value is None:
            return True
        if isinstance(node.value, bool):
            return not node.value
    return NO_PATTERN_MUTATION


def pattern_literal_value(node):
    """Return the source literal used for a match mutation report."""
    match_value_type = getattr(ast, 'MatchValue', ())
    if match_value_type and isinstance(node, match_value_type):
        return getattr(node.value, 'value', None)
    return getattr(node, 'value', None)


def find_target_scope(tree, function_name=None, class_name=None):
    """Return the exact function or method selected by the caller when known."""
    if not function_name:
        return tree

    if '.' in function_name:
        selected_class, function_name = function_name.rsplit('.', 1)
        if class_name and class_name != selected_class:
            return None
        class_name = selected_class

    if class_name:
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name == class_name:
                for member in node.body:
                    if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)) and member.name == function_name:
                        return member
        return None

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function_name:
            return node
    return None


def mutation_candidates(tree, scope=None):
    """Return deterministic, generic AST mutation descriptions in the selected scope."""
    candidates = []
    target_scope = scope or tree
    for node in mutation_scope_walk(target_scope):
        if isinstance(node, ast.Return) and node.value is not None:
            candidates.append({
                'kind': 'return_value',
                'line': getattr(node, 'lineno', 0),
                'column': getattr(node, 'col_offset', 0),
                'position': 0,
                'from': 'return_value',
                'to': 'None',
            })
        elif isinstance(node, ast.If):
            candidates.append({
                'kind': 'conditional_negation',
                'line': getattr(node, 'lineno', 0),
                'column': getattr(node, 'col_offset', 0),
                'position': 0,
                'from': 'if_condition',
                'to': 'not_if_condition',
            })
        elif isinstance(node, ast.While):
            candidates.append({
                'kind': 'loop_condition_negation',
                'line': getattr(node, 'lineno', 0),
                'column': getattr(node, 'col_offset', 0),
                'position': 0,
                'from': 'while_condition',
                'to': 'not_while_condition',
            })
        elif isinstance(node, ast.IfExp):
            candidates.append({
                'kind': 'conditional_expression_negation',
                'line': getattr(node, 'lineno', 0),
                'column': getattr(node, 'col_offset', 0),
                'position': 0,
                'from': 'if_expression_condition',
                'to': 'not_if_expression_condition',
            })
        elif pattern_literal_replacement(node) is not NO_PATTERN_MUTATION:
            replacement = pattern_literal_replacement(node)
            candidates.append({
                'kind': 'match_literal',
                'line': getattr(node, 'lineno', 0),
                'column': getattr(node, 'col_offset', 0),
                'position': 0,
                'from': repr(pattern_literal_value(node)),
                'to': repr(replacement),
            })
        elif isinstance(node, ast.Compare):
            for position, operator in enumerate(node.ops):
                replacement = COMPARISON_REPLACEMENTS.get(type(operator))
                if replacement:
                    candidates.append({
                        'kind': 'compare',
                        'line': getattr(node, 'lineno', 0),
                        'column': getattr(node, 'col_offset', 0),
                        'position': position,
                        'from': type(operator).__name__,
                        'to': replacement.__name__,
                    })
        elif isinstance(node, ast.BinOp):
            replacement = BINARY_REPLACEMENTS.get(type(node.op))
            if replacement:
                candidates.append({
                    'kind': 'binary',
                    'line': getattr(node, 'lineno', 0),
                    'column': getattr(node, 'col_offset', 0),
                    'position': 0,
                    'from': type(node.op).__name__,
                    'to': replacement.__name__,
                    })
        elif isinstance(node, ast.AugAssign):
            replacement = BINARY_REPLACEMENTS.get(type(node.op))
            if replacement:
                candidates.append({
                    'kind': 'augmented_assignment',
                    'line': getattr(node, 'lineno', 0),
                    'column': getattr(node, 'col_offset', 0),
                    'position': 0,
                    'from': type(node.op).__name__,
                    'to': replacement.__name__,
                })
        elif isinstance(node, ast.BoolOp):
            replacement = BOOLEAN_OPERATOR_REPLACEMENTS.get(type(node.op))
            if replacement:
                candidates.append({
                    'kind': 'boolean_operator',
                    'line': getattr(node, 'lineno', 0),
                    'column': getattr(node, 'col_offset', 0),
                    'position': 0,
                    'from': type(node.op).__name__,
                    'to': replacement.__name__,
                })
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            candidates.append({
                'kind': 'boolean',
                'line': getattr(node, 'lineno', 0),
                'column': getattr(node, 'col_offset', 0),
                'position': 0,
                'from': str(node.value),
                'to': str(not node.value),
            })
        elif isinstance(node, ast.Constant) and isinstance(node.value, (int, float, complex)):
            replacement = 1 if node.value == 0 else 0
            candidates.append({
                'kind': 'numeric_constant',
                'line': getattr(node, 'lineno', 0),
                'column': getattr(node, 'col_offset', 0),
                'position': 0,
                'from': repr(node.value),
                'to': repr(replacement),
            })
    return candidates


def apply_mutation(tree, candidate_index, target_function=None, target_class=None):
    """Mutate one candidate selected by the same traversal used for discovery."""
    copied = copy.deepcopy(tree)
    copied_scope = find_target_scope(copied, target_function, target_class)
    if copied_scope is None:
        raise IndexError('Mutation target scope was not found')
    current = 0
    for node in mutation_scope_walk(copied_scope):
        if isinstance(node, ast.Return) and node.value is not None:
            if current == candidate_index:
                node.value = ast.Constant(value=None)
                return copied
            current += 1
        elif isinstance(node, ast.If):
            if current == candidate_index:
                node.test = ast.UnaryOp(op=ast.Not(), operand=node.test)
                return copied
            current += 1
        elif isinstance(node, ast.While):
            if current == candidate_index:
                node.test = ast.UnaryOp(op=ast.Not(), operand=node.test)
                return copied
            current += 1
        elif isinstance(node, ast.IfExp):
            if current == candidate_index:
                node.test = ast.UnaryOp(op=ast.Not(), operand=node.test)
                return copied
            current += 1
        elif pattern_literal_replacement(node) is not NO_PATTERN_MUTATION:
            replacement = pattern_literal_replacement(node)
            if current == candidate_index:
                match_value_type = getattr(ast, 'MatchValue', ())
                if match_value_type and isinstance(node, match_value_type):
                    node.value = ast.Constant(value=replacement)
                else:
                    node.value = replacement
                return copied
            current += 1
        elif isinstance(node, ast.Compare):
            for position, operator in enumerate(node.ops):
                replacement = COMPARISON_REPLACEMENTS.get(type(operator))
                if replacement:
                    if current == candidate_index:
                        node.ops[position] = replacement()
                        return copied
                    current += 1
        elif isinstance(node, ast.BinOp):
            replacement = BINARY_REPLACEMENTS.get(type(node.op))
            if replacement:
                if current == candidate_index:
                    node.op = replacement()
                    return copied
                current += 1
        elif isinstance(node, ast.AugAssign):
            replacement = BINARY_REPLACEMENTS.get(type(node.op))
            if replacement:
                if current == candidate_index:
                    node.op = replacement()
                    return copied
                current += 1
        elif isinstance(node, ast.BoolOp):
            replacement = BOOLEAN_OPERATOR_REPLACEMENTS.get(type(node.op))
            if replacement:
                if current == candidate_index:
                    node.op = replacement()
                    return copied
                current += 1
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            if current == candidate_index:
                node.value = not node.value
                return copied
            current += 1
        elif isinstance(node, ast.Constant) and isinstance(node.value, (int, float, complex)):
            if current == candidate_index:
                node.value = 1 if node.value == 0 else 0
                return copied
            current += 1
    raise IndexError('Mutation candidate index was not found')


def package_mutant_targets(source_file, test_file, temp_root):
    """Mirror package imports from a test so they resolve to the mutant copy.

    A generated unittest may import either ``module`` or ``package.module``.
    Writing only ``temp_root/module.py`` handles the former, but silently loads
    the original source for the latter.  We copy just the matching package root
    into the isolated directory and return every mirrored target path.
    """
    source_stem = source_file.stem
    source_chain = list(source_file.parents)
    modules = set()
    test_text = test_file.read_text(encoding='utf-8')
    for raw_line in test_text.splitlines():
        from_match = re.match(r'^\s*from\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\s+(.+)$', raw_line)
        if from_match:
            module_name, imported = from_match.groups()
            names = [part.strip().split(' as ')[0].strip() for part in imported.split(',')]
            if module_name.split('.')[-1] == source_stem:
                modules.add(module_name)
            elif source_stem in names:
                modules.add(f'{module_name}.{source_stem}')
            continue
        import_match = re.match(r'^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)', raw_line)
        if import_match and import_match.group(1).split('.')[-1] == source_stem:
            modules.add(import_match.group(1))

    targets = []
    copied_roots = set()
    for module_name in modules:
        package_parts = module_name.split('.')[:-1]
        if not package_parts or len(package_parts) > len(source_chain):
            continue
        if any(source_chain[index].name != package_parts[-1 - index] for index in range(len(package_parts))):
            continue
        package_root = source_chain[len(package_parts) - 1]
        destination_root = temp_root / package_root.name
        root_key = str(package_root)
        if root_key not in copied_roots:
            shutil.copytree(
                package_root,
                destination_root,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns('__pycache__', '*.pyc')
            )
            copied_roots.add(root_key)
        targets.append(destination_root / source_file.relative_to(package_root))
    return targets


def run_mutation_trials(source_path, test_path, max_mutations=30, timeout_seconds=10,
                        target_function=None, target_class=None):
    source_file = Path(source_path).resolve()
    test_file = Path(test_path).resolve()
    tree = ast.parse(source_file.read_text(encoding='utf-8'), filename=str(source_file))
    scope = find_target_scope(tree, target_function, target_class)
    if target_function and scope is None:
        return {
            'engine': 'builtin',
            'total': 0,
            'killed': 0,
            'survived': 0,
            'errors': 0,
            'mutants': [],
            'scope_found': False,
            'scope': f'{target_class + "." if target_class else ""}{target_function}',
        }
    candidates = mutation_candidates(tree, scope)[:max_mutations]
    result = {
        'engine': 'builtin',
        'total': len(candidates),
        'killed': 0,
        'survived': 0,
        'errors': 0,
        'mutants': [],
        'scope_found': True,
        'scope': f'{target_class + "." if target_class else ""}{target_function or "module"}',
        'baseline_passed': False,
    }

    with tempfile.TemporaryDirectory(prefix='llm_unit_mutation_') as temp_dir:
        temp_root = Path(temp_dir)
        test_copy = temp_root / test_file.name
        test_copy.write_text(test_file.read_text(encoding='utf-8'), encoding='utf-8')
        mirrored_targets = package_mutant_targets(source_file, test_file, temp_root)
        original_source = source_file.read_text(encoding='utf-8')
        # Run the unmodified target in exactly the same isolated import layout
        # used for every mutant. A failing baseline is infrastructure/test
        # failure, never evidence that every mutant was killed.
        (temp_root / source_file.name).write_text(original_source, encoding='utf-8')
        python_path = os.pathsep.join([
            str(temp_root),
            str(source_file.parent),
            str(source_file.parent.parent),
            os.environ.get('PYTHONPATH', ''),
        ])
        environment = {**os.environ, 'PYTHONPATH': python_path, 'PYTHONIOENCODING': 'utf-8'}

        try:
            baseline = subprocess.run(
                [sys.executable, '-m', 'unittest', test_copy.stem],
                cwd=temp_root,
                env=environment,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=timeout_seconds,
            )
            if baseline.returncode:
                result.update({
                    'total': 0,
                    'baseline_passed': False,
                    'baseline_output': (baseline.stdout + baseline.stderr).strip()[-500:],
                    'mutants': [],
                })
                return result
        except subprocess.TimeoutExpired as error:
            result.update({
                'total': 0,
                'baseline_passed': False,
                'baseline_output': f'Baseline timed out after {timeout_seconds}s: {error}',
                'mutants': [],
            })
            return result
        except OSError as error:
            result.update({
                'total': 0,
                'baseline_passed': False,
                'baseline_output': str(error),
                'mutants': [],
            })
            return result

        result['baseline_passed'] = True

        for index, candidate in enumerate(candidates):
            mutant_tree = apply_mutation(
                tree,
                index,
                target_function,
                target_class
            )
            ast.fix_missing_locations(mutant_tree)
            mutant_source = ast.unparse(mutant_tree) + '\n'
            (temp_root / source_file.name).write_text(mutant_source, encoding='utf-8')
            for mirrored_target in mirrored_targets:
                mirrored_target.write_text(mutant_source, encoding='utf-8')

            try:
                completed = subprocess.run(
                    [sys.executable, '-m', 'unittest', test_copy.stem],
                    cwd=temp_root,
                    env=environment,
                    capture_output=True,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    timeout=timeout_seconds,
                )
                status = 'KILLED' if completed.returncode else 'SURVIVED'
                output = (completed.stdout + completed.stderr).strip()[-500:]
            except subprocess.TimeoutExpired as error:
                # This timeout happened while exercising one mutated copy.
                # A mutant that makes a formerly terminating test hang is a
                # detected behavioral change, so mutation testing counts it
                # as killed rather than an infrastructure error.
                status = 'KILLED'
                output = f'Killed by timeout after {timeout_seconds}s: {error}'
            except OSError as error:
                status = 'ERROR'
                output = str(error)

            record = {**candidate, 'status': status, 'output': output}
            result['mutants'].append(record)
            if status == 'KILLED':
                result['killed'] += 1
            elif status == 'SURVIVED':
                result['survived'] += 1
            else:
                result['errors'] += 1
    return result


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'Usage: basic_mutation_runner.py <source.py> <test.py> [max_mutations] [timeout_seconds] [target_function] [target_class]'}))
        sys.exit(2)
    maximum = int(sys.argv[3]) if len(sys.argv) >= 4 else 30
    timeout = int(sys.argv[4]) if len(sys.argv) >= 5 else 10
    function_name = sys.argv[5] if len(sys.argv) >= 6 and sys.argv[5] else None
    class_name = sys.argv[6] if len(sys.argv) >= 7 and sys.argv[6] else None
    print(json.dumps(
        run_mutation_trials(sys.argv[1], sys.argv[2], maximum, timeout, function_name, class_name),
        ensure_ascii=True
    ))
