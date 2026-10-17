"""Builtin v3 adds standalone call omission without changing v2 reconstruction."""
import ast
import copy

from mutation_operators_v2 import iter_mutations as iter_mutations_v2, _replace, _scoped_paths

VERSION = 'builtin-ast-v3'


def iter_mutations(tree, scope):
    # Keep every historical v2 candidate and its order. The new version owns the
    # larger universe; callers must never compare it as the old candidate set.
    yield from iter_mutations_v2(tree, scope)
    for node, path in _scoped_paths(tree, scope):
        if not path or not isinstance(node, ast.Expr):
            continue
        expression = node.value.value if isinstance(node.value, ast.Await) else node.value
        if not isinstance(expression, ast.Call):
            continue
        variant = copy.deepcopy(tree)
        _replace(variant, path, ast.copy_location(ast.Pass(), node))
        ast.fix_missing_locations(variant)
        yield ({'kind': 'call_statement_omission', 'line': node.lineno,
                'column': node.col_offset, 'position': 0,
                'from': 'await_call' if isinstance(node.value, ast.Await) else 'call', 'to': 'pass'}, variant)
