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


def find_target_scope(tree, function_name=None, class_name=None):
    """Return the exact function or method selected by the caller when known."""
    if not function_name:
        return tree

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
        if isinstance(node, ast.If):
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
        if isinstance(node, ast.If):
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
    }

    with tempfile.TemporaryDirectory(prefix='llm_unit_mutation_') as temp_dir:
        temp_root = Path(temp_dir)
        test_copy = temp_root / test_file.name
        test_copy.write_text(test_file.read_text(encoding='utf-8'), encoding='utf-8')
        python_path = os.pathsep.join([
            str(temp_root),
            str(source_file.parent),
            str(source_file.parent.parent),
            os.environ.get('PYTHONPATH', ''),
        ])
        environment = {**os.environ, 'PYTHONPATH': python_path, 'PYTHONIOENCODING': 'utf-8'}

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

            try:
                completed = subprocess.run(
                    [sys.executable, '-m', 'unittest', test_copy.stem],
                    cwd=temp_root,
                    env=environment,
                    capture_output=True,
                    text=True,
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
        ensure_ascii=False
    ))
