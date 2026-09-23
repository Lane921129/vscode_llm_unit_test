"""A dependency-free mutation-test fallback for Python environments without an engine.

It creates mutated copies in a temporary directory and runs the generated
unittest file against each copy.  Source files are never modified in place.
This is intentionally a small safety net; mutatest/mutmut remain preferred
when available.
"""

import ast
import copy
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from import_fixtures import mutation_environment, read_plan as import_fixture_plan


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
    # Division is common in calculations but was previously invisible to the
    # builtin fallback, which could overstate a suite's mutation score when no
    # native engine is available. Floor division is a portable syntax-level
    # replacement that callers can distinguish with a non-integral example.
    ast.Div: ast.FloorDiv,
}

BOOLEAN_OPERATOR_REPLACEMENTS = {
    ast.And: ast.Or,
    ast.Or: ast.And,
}


CALLABLE_SCOPE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)
NO_PATTERN_MUTATION = object()
OPERATOR_SET_VERSION = 'builtin-ast-v1'
FUNCTION_SCOPE_VERSION = 'selected-function-body-v1'
MODULE_SCOPE_VERSION = 'module-ast-v1'


def mutation_scope_walk(scope):
    """Walk only the selected function body, excluding nested callable scopes.

    Decorators, defaults and annotations execute outside this body scope.
    Nested helpers and classes remain separate callable responsibilities.
    Module-wide analysis intentionally keeps its existing full-tree behaviour.
    """
    exclude_nested_callables = isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef))

    def visit(node):
        if exclude_nested_callables and isinstance(node, CALLABLE_SCOPE_NODES):
            return
        yield node
        for child in ast.iter_child_nodes(node):
            yield from visit(child)

    if exclude_nested_callables:
        for statement in scope.body:
            yield from visit(statement)
    else:
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
    try:
        tree = ast.parse(test_text)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                module_name = node.module or ''
                if module_name.split('.')[-1] == source_stem:
                    modules.add(module_name)
                for alias in node.names:
                    if alias.name == source_stem:
                        modules.add(f'{module_name}.{source_stem}' if module_name else source_stem)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split('.')[-1] == source_stem:
                        modules.add(alias.name)
    except Exception:
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


def prepare_trial_directory(source_file, test_file, trial_root, source_text):
    """Create one import-isolated filesystem for a baseline or mutant trial.

    Each trial receives a fresh package tree. Reusing one directory lets
    Python reuse timestamp-based ``.pyc`` files when two AST variants have the
    same size and are written within one filesystem timestamp tick, producing
    nondeterministic mutation scores.
    """
    trial_root.mkdir(parents=True, exist_ok=False)
    test_copy = trial_root / test_file.name
    test_copy.write_text(test_file.read_text(encoding='utf-8'), encoding='utf-8')
    mirrored_targets = package_mutant_targets(source_file, test_file, trial_root)
    (trial_root / source_file.name).write_text(source_text, encoding='utf-8')
    for mirrored_target in mirrored_targets:
        mirrored_target.write_text(source_text, encoding='utf-8')
    return test_copy


def trial_environment(temp_root, source_file):
    python_path = os.pathsep.join([
        str(temp_root),
        str(source_file.parent),
        str(source_file.parent.parent),
        os.environ.get('PYTHONPATH', ''),
    ])
    return mutation_environment({
        **os.environ,
        'PYTHONPATH': python_path,
        'PYTHONIOENCODING': 'utf-8',
        # A mutation trial must execute its .py source, never bytecode left by
        # the baseline or another mutant.
        'PYTHONDONTWRITEBYTECODE': '1',
    }, temp_root, source_file)


def run_mutation_trials(source_path, test_path, max_mutations=30, timeout_seconds=10,
                        target_function=None, target_class=None, stage_timeout_seconds=None):
    """Measure selected mutants without treating incomplete execution as a kill.

    ``total``/``errors`` remain legacy display fields. Consumers must use the
    versioned counts and status: the candidate limit is not the full universe.
    """
    if type(max_mutations) is not int or max_mutations < 0:
        raise ValueError('max_mutations must be a non-negative integer (zero selects all candidates)')
    for label, value in [('timeout_seconds', timeout_seconds), ('stage_timeout_seconds', stage_timeout_seconds)]:
        if value is None and label == 'timeout_seconds':
            raise ValueError('timeout_seconds must be a finite positive number')
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value <= 0):
            raise ValueError(f'{label} must be a finite positive number')
    started = time.monotonic()
    deadline = started + stage_timeout_seconds if stage_timeout_seconds is not None else None
    source_file = Path(source_path).resolve()
    test_file = Path(test_path).resolve()
    original_source = source_file.read_bytes().decode('utf-8')
    original_test_bytes = test_file.read_bytes()
    source_hash = hashlib.sha256(original_source.encode('utf-8')).hexdigest()
    tree = ast.parse(original_source, filename=str(source_file))
    scope = find_target_scope(tree, target_function, target_class)
    scope_name = (target_function if target_function and '.' in target_function
                  else f'{target_class + "." if target_class else ""}{target_function or "module"}')
    result = {
        'schemaVersion': 1,
        'importFixtureId': (import_fixture_plan() or {}).get('id'),
        'engine': 'builtin',
        'operatorSetVersion': OPERATOR_SET_VERSION,
        'scopeVersion': FUNCTION_SCOPE_VERSION if target_function else MODULE_SCOPE_VERSION,
        'candidateSetId': None,
        'candidateIds': [],
        'status': 'failed',
        'sourceHash': source_hash,
        'testHash': hashlib.sha256(original_test_bytes).hexdigest(),
        'targetScope': {'kind': 'function' if target_function else 'module', 'qualifiedName': scope_name},
        'sourcePath': str(source_file),
        'timeoutSeconds': timeout_seconds,
        'stageTimeoutSeconds': stage_timeout_seconds,
        'counts': dict(available=0, selected=0, executed=0, notRun=0, killed=0, survived=0, timeout=0, error=0),
        'excluded': dict(noop=0, duplicate=0, invalid=0),
        'scoreAvailable': False,
        'total': 0,
        'killed': 0,
        'survived': 0,
        'errors': 0,
        'mutants': [],
        'scope_found': scope is not None,
        'scope': scope_name,
        'baseline_passed': False,
        'baselineStatus': 'not-run',
    }
    if scope is None:
        result['diagnostic'] = 'Selected mutation scope was not found'
        return result
    body_start = scope.body[0].lineno if target_function and scope.body else getattr(scope, 'lineno', 1)
    result['targetScope'].update(startLine=body_start, endLine=getattr(scope, 'end_lineno', len(original_source.splitlines())))
    candidates = []
    original_ast = ast.dump(tree, include_attributes=False)
    seen_variants = set()
    for index, candidate in enumerate(mutation_candidates(tree, scope)):
        if deadline is not None and time.monotonic() >= deadline:
            result['counts']['available'] = None
            result['diagnostic'] = 'Stage budget exhausted while enumerating mutation candidates; universe is unknown'
            return result
        variant = apply_mutation(tree, index, target_function, target_class)
        ast.fix_missing_locations(variant)
        variant_ast = ast.dump(variant, include_attributes=False)
        if variant_ast == original_ast:
            result['excluded']['noop'] += 1
            continue
        if variant_ast in seen_variants:
            result['excluded']['duplicate'] += 1
            continue
        try:
            compile(variant, str(source_file), 'exec')
        except (SyntaxError, TypeError, ValueError):
            result['excluded']['invalid'] += 1
            continue
        seen_variants.add(variant_ast)
        # Nested expressions can share the same start line/column and operator
        # description. Bind identity to the actual changed AST as well, without
        # changing the operator set or depending on the tests. This deliberately
        # replaces the old colliding IDs; old candidate sets are not reused.
        variant_hash = hashlib.sha256(variant_ast.encode('utf-8')).hexdigest()
        identity = json.dumps([OPERATOR_SET_VERSION, result['scopeVersion'], source_hash, scope_name, candidate, variant_hash],
                              sort_keys=True, separators=(',', ':'))
        candidates.append(({**candidate, 'id': hashlib.sha256(identity.encode('utf-8')).hexdigest()}, ast.unparse(variant) + '\n'))
    result['counts']['available'] = len(candidates)
    result['candidateIds'] = [candidate['id'] for candidate, _ in candidates]
    result['candidateSetId'] = hashlib.sha256('\n'.join(sorted(result['candidateIds'])).encode('ascii')).hexdigest()
    candidates = candidates[:max_mutations] if max_mutations else candidates
    result['total'] = result['counts']['selected'] = result['counts']['notRun'] = len(candidates)

    def trial_timeout():
        if deadline is None:
            return timeout_seconds
        return max(0.001, min(timeout_seconds, deadline - time.monotonic()))

    def budget_exhausted():
        return deadline is not None and time.monotonic() >= deadline

    with tempfile.TemporaryDirectory(prefix='llm_unit_mutation_') as temp_dir:
        temp_root = Path(temp_dir)
        snapshot_dir = temp_root / 'test_snapshot'
        snapshot_dir.mkdir()
        snapshot_test = snapshot_dir / test_file.name
        snapshot_test.write_bytes(original_test_bytes)
        # Run the unmodified target in exactly the same isolated import layout
        # used for every mutant. A failing baseline is infrastructure/test
        # failure, never evidence that every mutant was killed.
        baseline_root = temp_root / 'baseline'
        baseline_test = prepare_trial_directory(source_file, snapshot_test, baseline_root, original_source)
        baseline_environment = trial_environment(baseline_root, source_file)

        try:
            if budget_exhausted():
                result['baseline_output'] = 'Stage budget exhausted before baseline'
                return result
            baseline = subprocess.run(
                [sys.executable, '-B', str(Path(__file__).with_name('generated_test_runner.py')), baseline_test.stem],
                cwd=baseline_root,
                env=baseline_environment,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=trial_timeout(),
            )
            if baseline.returncode:
                result.update({
                    'total': 0,
                    'baseline_passed': False,
                    'baselineStatus': 'error' if baseline.returncode == 86 else 'failed',
                    'baseline_output': (baseline.stdout + baseline.stderr).strip()[-500:],
                    'mutants': [],
                })
                return result
        except subprocess.TimeoutExpired as error:
            result.update({
                'total': 0,
                'baseline_passed': False,
                'baselineStatus': 'timeout',
                'baseline_output': f'Baseline timed out after {timeout_seconds}s: {error}',
                'mutants': [],
            })
            return result
        except OSError as error:
            result.update({
                'total': 0,
                'baseline_passed': False,
                'baselineStatus': 'error',
                'baseline_output': str(error),
                'mutants': [],
            })
            return result

        result['baseline_passed'] = True
        result['baselineStatus'] = 'passed'
        result['mutants'] = [{**candidate, 'status': 'NOT_RUN', 'output': ''} for candidate, _ in candidates]

        for index, (candidate, mutant_source) in enumerate(candidates):
            if budget_exhausted():
                break
            mutant_root = temp_root / f'mutant_{index:04d}'
            mutant_test = prepare_trial_directory(source_file, snapshot_test, mutant_root, mutant_source)
            mutant_environment = trial_environment(mutant_root, source_file)

            try:
                completed = subprocess.run(
                    [sys.executable, '-B', str(Path(__file__).with_name('generated_test_runner.py')), mutant_test.stem],
                    cwd=mutant_root,
                    env=mutant_environment,
                    capture_output=True,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    timeout=trial_timeout(),
                )
                # A forbidden external operation is missing test isolation,
                # never proof that an assertion killed the mutant.
                status = 'SURVIVED' if completed.returncode == 0 else 'KILLED' if completed.returncode == 1 else 'ERROR'
                output = (completed.stdout + completed.stderr).strip()[-500:]
            except subprocess.TimeoutExpired as error:
                status = 'TIMEOUT'
                output = f'Mutant timed out (per-trial limit {timeout_seconds}s; shared stage budget applies): {error}'
            except OSError as error:
                status = 'ERROR'
                output = str(error)

            record = {**candidate, 'status': status, 'output': output}
            result['mutants'][index] = record
            result['counts']['executed'] += 1
            result['counts']['notRun'] -= 1
            result['counts'][{'KILLED': 'killed', 'SURVIVED': 'survived', 'TIMEOUT': 'timeout', 'ERROR': 'error'}[status]] += 1
    counts = result['counts']
    result.update(killed=counts['killed'], survived=counts['survived'], errors=counts['error'])
    result['scoreAvailable'] = bool(counts['selected'] and counts['notRun'] == 0 and counts['error'] == 0 and counts['timeout'] == 0)
    result['status'] = ('failed' if counts['error'] else 'no-candidates' if counts['available'] == 0
                        else 'complete' if result['scoreAvailable'] and counts['selected'] == counts['available'] else 'partial')
    return result


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'Usage: basic_mutation_runner.py <source.py> <test.py> [max_mutations] [timeout_seconds] [target_function] [target_class] [stage_timeout_seconds]'}))
        sys.exit(2)
    maximum = int(sys.argv[3]) if len(sys.argv) >= 4 else 30
    timeout = float(sys.argv[4]) if len(sys.argv) >= 5 else 10
    function_name = sys.argv[5] if len(sys.argv) >= 6 and sys.argv[5] else None
    class_name = sys.argv[6] if len(sys.argv) >= 7 and sys.argv[6] else None
    stage_timeout = float(sys.argv[7]) if len(sys.argv) >= 8 else None
    print(json.dumps(
        run_mutation_trials(sys.argv[1], sys.argv[2], maximum, timeout, function_name, class_name, stage_timeout),
        ensure_ascii=True
    ))
