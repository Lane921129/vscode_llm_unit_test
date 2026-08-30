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


def mutation_candidates(tree):
    """Return deterministic, generic AST mutation descriptions."""
    candidates = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
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
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            candidates.append({
                'kind': 'boolean',
                'line': getattr(node, 'lineno', 0),
                'column': getattr(node, 'col_offset', 0),
                'position': 0,
                'from': str(node.value),
                'to': str(not node.value),
            })
    return candidates


def apply_mutation(tree, candidate_index):
    """Mutate one candidate selected by the same traversal used for discovery."""
    copied = copy.deepcopy(tree)
    current = 0
    for node in ast.walk(copied):
        if isinstance(node, ast.Compare):
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
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            if current == candidate_index:
                node.value = not node.value
                return copied
            current += 1
    raise IndexError('Mutation candidate index was not found')


def run_mutation_trials(source_path, test_path, max_mutations=30, timeout_seconds=10):
    source_file = Path(source_path).resolve()
    test_file = Path(test_path).resolve()
    tree = ast.parse(source_file.read_text(encoding='utf-8'), filename=str(source_file))
    candidates = mutation_candidates(tree)[:max_mutations]
    result = {
        'engine': 'builtin',
        'total': len(candidates),
        'killed': 0,
        'survived': 0,
        'errors': 0,
        'mutants': [],
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
            mutant_tree = apply_mutation(tree, index)
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
                status = 'ERROR'
                output = f'Timeout after {timeout_seconds}s: {error}'
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
        print(json.dumps({'error': 'Usage: basic_mutation_runner.py <source.py> <test.py> [max_mutations] [timeout_seconds]'}))
        sys.exit(2)
    maximum = int(sys.argv[3]) if len(sys.argv) >= 4 else 30
    timeout = int(sys.argv[4]) if len(sys.argv) >= 5 else 10
    print(json.dumps(run_mutation_trials(sys.argv[1], sys.argv[2], maximum, timeout), ensure_ascii=False))
