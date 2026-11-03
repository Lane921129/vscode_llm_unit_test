"""Versioned, deterministic single-site AST mutations; never evaluate source."""
import ast
import copy
import math

VERSION = 'builtin-ast-v2'
CALLABLES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
ARITHMETIC = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow)
COMPARISONS = (ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE)


def _walk(node, path=()):
    yield node, path
    for name, value in ast.iter_fields(node):
        if isinstance(value, ast.AST):
            yield from _walk(value, path + ((name, None),))
        elif isinstance(value, list):
            for index, child in enumerate(value):
                if isinstance(child, ast.AST):
                    yield from _walk(child, path + ((name, index),))


def _at(tree, path):
    node = tree
    for name, index in path:
        node = getattr(node, name)
        if index is not None:
            node = node[index]
    return node


def _replace(tree, path, value):
    parent = _at(tree, path[:-1])
    name, index = path[-1]
    if index is None:
        setattr(parent, name, value)
    else:
        getattr(parent, name)[index] = value


def _scoped_paths(tree, scope):
    paths = {id(node): path for node, path in _walk(tree)}
    if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
        def body_walk(node):
            if isinstance(node, CALLABLES):
                return
            yield node, paths[id(node)]
            for child in ast.iter_child_nodes(node):
                yield from body_walk(child)
        for statement in scope.body:
            yield from body_walk(statement)
    else:
        yield from _walk(tree)


def _alternatives(node):
    """Yield (kind, position, from, to, replacement AST) at exactly one site."""
    if isinstance(node, ast.Return) and node.value is not None:
        yield 'return_value', 0, 'return_value', 'None', ast.Return(value=ast.Constant(value=None))
    elif isinstance(node, (ast.If, ast.While, ast.IfExp)):
        changed = copy.deepcopy(node)
        changed.test = ast.UnaryOp(op=ast.Not(), operand=changed.test)
        kind = ('conditional_negation' if isinstance(node, ast.If) else
                'loop_condition_negation' if isinstance(node, ast.While) else 'conditional_expression_negation')
        yield kind, 0, 'condition', 'not_condition', changed
    elif isinstance(node, (ast.BinOp, ast.AugAssign)) and type(node.op) in ARITHMETIC:
        for replacement in ARITHMETIC:
            if type(node.op) is replacement:
                continue
            changed = copy.deepcopy(node)
            changed.op = replacement()
            yield ('binary' if isinstance(node, ast.BinOp) else 'augmented_assignment'), 0, type(node.op).__name__, replacement.__name__, changed
    elif isinstance(node, ast.Compare):
        for index, operator in enumerate(node.ops):
            choices = COMPARISONS if type(operator) in COMPARISONS else (
                (ast.In, ast.NotIn) if isinstance(operator, (ast.In, ast.NotIn)) else
                (ast.Is, ast.IsNot) if isinstance(operator, (ast.Is, ast.IsNot)) else ())
            for replacement in choices:
                if type(operator) is replacement:
                    continue
                changed = copy.deepcopy(node)
                changed.ops[index] = replacement()
                yield 'compare', index, type(operator).__name__, replacement.__name__, changed
    elif isinstance(node, ast.BoolOp):
        changed = copy.deepcopy(node)
        changed.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
        yield 'boolean_operator', 0, type(node.op).__name__, type(changed.op).__name__, changed
    elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.Not, ast.UAdd, ast.USub)):
        yield 'unary', 0, type(node.op).__name__, 'operand', copy.deepcopy(node.operand)
        if isinstance(node.op, (ast.UAdd, ast.USub)):
            replacement = ast.USub if isinstance(node.op, ast.UAdd) else ast.UAdd
            yield 'unary', 0, type(node.op).__name__, replacement.__name__, ast.UnaryOp(op=replacement(), operand=copy.deepcopy(node.operand))
    elif isinstance(node, getattr(ast, 'MatchSingleton', ())):
        replacement = not node.value if isinstance(node.value, bool) else True
        yield 'match_literal', 0, repr(node.value), repr(replacement), ast.MatchSingleton(value=replacement)
    elif isinstance(node, ast.Constant):
        value = node.value
        if isinstance(value, bool):
            yield 'boolean', 0, str(value), str(not value), ast.Constant(value=not value)
        elif type(value) in (int, float) and (type(value) is int or math.isfinite(value)):
            # Each literal contributes at most five candidates, regardless of
            # module size. Python arithmetic is only on the parsed literal.
            seen = {repr(value)}
            for changed in (0, 1, value - 1, value + 1, -value):
                if repr(changed) in seen or (type(changed) is float and not math.isfinite(changed)):
                    continue
                seen.add(repr(changed))
                yield 'numeric_constant', 0, repr(value), repr(changed), ast.Constant(value=changed)
        elif isinstance(value, complex) and math.isfinite(value.real) and math.isfinite(value.imag):
            replacement = 1 if value == 0 else 0
            yield 'numeric_constant', 0, repr(value), repr(replacement), ast.Constant(value=replacement)
        elif isinstance(value, str) and len(value) <= 1000:
            for changed in ('', value + '__mutated__'):
                if changed != value:
                    yield 'string_constant', 0, repr(value), repr(changed), ast.Constant(value=changed)
    elif isinstance(node, (ast.List, ast.Tuple, ast.Set)) and isinstance(getattr(node, 'ctx', ast.Load()), ast.Load):
        if 0 < len(node.elts) <= 16:
            for label, elements in [('empty', []), ('without_first', node.elts[1:]), ('without_last', node.elts[:-1])]:
                changed = copy.deepcopy(node)
                changed.elts = copy.deepcopy(elements)
                yield 'container', 0, type(node).__name__, label, changed
    elif isinstance(node, ast.Dict) and 0 < len(node.keys) <= 16:
        for label, indexes in [('empty', []), ('without_first', list(range(1, len(node.keys)))), ('without_last', list(range(len(node.keys) - 1)))]:
            changed = ast.Dict(keys=[copy.deepcopy(node.keys[i]) for i in indexes], values=[copy.deepcopy(node.values[i]) for i in indexes])
            yield 'container', 0, 'Dict', label, changed
    elif isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load):
        # Shift an index/boundary once, without duplicating source calls.
        indexes = [('slice', node.slice)] if not isinstance(node.slice, ast.Slice) else [
            (name, getattr(node.slice, name)) for name in ('lower', 'upper') if getattr(node.slice, name) is not None]
        for position, (name, expression) in enumerate(indexes):
            for operator, label in ((ast.Add, '+1'), (ast.Sub, '-1')):
                changed = copy.deepcopy(node)
                boundary = ast.BinOp(left=copy.deepcopy(expression), op=operator(), right=ast.Constant(value=1))
                if name == 'slice':
                    changed.slice = boundary
                else:
                    setattr(changed.slice, name, boundary)
                yield 'index_boundary', position, name, name + label, changed


def iter_mutations(tree, scope):
    docstrings = set()
    for owner, _ in _walk(tree):
        if isinstance(owner, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and owner.body:
            first = owner.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    for node, path in _scoped_paths(tree, scope):
        if not path or id(node) in docstrings:
            continue
        for kind, position, original, replacement, changed in _alternatives(node):
            variant = copy.deepcopy(tree)
            _replace(variant, path, ast.copy_location(changed, node))
            ast.fix_missing_locations(variant)
            yield ({'kind': kind, 'line': getattr(node, 'lineno', 0), 'column': getattr(node, 'col_offset', 0),
                    'position': position, 'from': original, 'to': replacement}, variant)
