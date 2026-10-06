"""Bounded AST arithmetic inversion proposes inputs, never assertion oracles.

No source import, eval or exec. Only complete numeric calls already observed are
used as seeds. Every proposed input must subsequently run through isolated Trace.
Conditional-equivalence notes do NOT exclude mutants or alter quality scores.
"""
import ast
import copy
import json
import math
import sys
from basic_mutation_runner import find_target_scope, mutation_scope_walk

VERSION = 'mutation-input-plan-v1'
LIMIT = 12


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and abs(value) <= 2 ** 53


def evaluate(node, values, depth=0):
    if depth > 16:
        raise ValueError('expression-depth')
    child = lambda n: evaluate(n, values, depth + 1)
    if isinstance(node, ast.Constant) and number(node.value):
        value = node.value
    elif isinstance(node, ast.Name):
        value = values[node.id]
    elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = child(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
    elif isinstance(node, ast.BinOp):
        left, right = child(node.left), child(node.right)
        if isinstance(node.op, ast.Add): value = left + right
        elif isinstance(node.op, ast.Sub): value = left - right
        elif isinstance(node.op, ast.Mult): value = left * right
        elif isinstance(node.op, ast.Div): value = left / right
        elif isinstance(node.op, ast.Pow) and abs(right) <= 4: value = left ** right
        else: raise ValueError('unsupported-operation')
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'round' and not node.keywords and len(node.args) in (1, 2):
        digits = child(node.args[1]) if len(node.args) == 2 else 0
        if type(digits) is not int or abs(digits) > 6: raise ValueError('round-digits')
        value = round(child(node.args[0]), digits)
    else:
        raise ValueError('unsupported-expression')
    if not number(value): raise ValueError('non-finite-or-large')
    return value


def occurrences(node, name):
    return sum(isinstance(n, ast.Name) and n.id == name for n in ast.walk(node))


def solve(node, name, desired, values, depth=0):
    if depth > 16 or not number(desired) or occurrences(node, name) != 1:
        raise ValueError('unsupported-inverse')
    if isinstance(node, ast.Name) and node.id == name: return desired
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        return solve(node.operand, name, desired * (-1 if isinstance(node.op, ast.USub) else 1), values, depth + 1)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'round' and not node.keywords and len(node.args) in (1, 2):
        # The centre of the rounding bin is only a candidate; execution decides.
        return solve(node.args[0], name, desired, values, depth + 1)
    if not isinstance(node, ast.BinOp): raise ValueError('unsupported-inverse')
    on_left = occurrences(node.left, name) == 1
    variable, fixed = (node.left, node.right) if on_left else (node.right, node.left)
    constant = evaluate(fixed, values)
    if isinstance(node.op, ast.Add): target = desired - constant
    elif isinstance(node.op, ast.Sub): target = desired + constant if on_left else constant - desired
    elif isinstance(node.op, ast.Mult): target = desired / constant
    elif isinstance(node.op, ast.Div): target = desired * constant if on_left else constant / desired
    elif isinstance(node.op, ast.Pow) and on_left and constant in (2, 3):
        target = abs(desired) ** (1 / constant) * (-1 if desired < 0 and constant == 3 else 1)
        if desired < 0 and constant == 2: raise ValueError('non-real-root')
    else: raise ValueError('unsupported-inverse')
    return solve(variable, name, target, values, depth + 1)


def expand(node, bindings):
    class Expand(ast.NodeTransformer):
        def visit_Name(self, item):
            return copy.deepcopy(bindings.get(item.id, item))
    result = Expand().visit(copy.deepcopy(node))
    if sum(1 for _ in ast.walk(result)) > 128: raise ValueError('expression-size')
    return result


def scalar(text):
    try:
        value = ast.literal_eval(text)
        return value if number(value) else None
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return None


def conditional_equivalence(scope, survivors):
    notes = []
    for root in scope.body:
        if not isinstance(root, ast.If): continue
        branch, lower, variable = root, None, None
        while isinstance(branch, ast.If):
            c = branch.test
            upper = None
            if isinstance(c, ast.Compare) and len(c.ops) == 1 and isinstance(c.left, ast.Name) and isinstance(c.comparators[0], ast.Constant) and isinstance(c.ops[0], ast.Lt):
                if number(c.comparators[0].value): variable, upper = c.left.id, c.comparators[0].value
            elif (isinstance(c, ast.Compare) and len(c.ops) == 2 and isinstance(c.ops[0], ast.LtE) and isinstance(c.ops[1], ast.Lt)
                  and isinstance(c.left, ast.Constant) and isinstance(c.comparators[0], ast.Name)
                  and c.comparators[0].id == variable and isinstance(c.comparators[1], ast.Constant)
                  and number(c.left.value) and number(c.comparators[1].value) and lower is not None and lower >= c.left.value):
                upper = c.comparators[1].value
                for m in survivors:
                    replacement = scalar(m.get('to', ''))
                    if (m.get('kind') == 'numeric_constant' and m.get('line') == c.left.lineno
                            and m.get('column') == c.left.col_offset and m.get('from') == repr(c.left.value)
                            and replacement is not None and replacement <= lower):
                        notes.append({'mutantId': m['id'], 'status': 'conditional-equivalence',
                                      'reasonCode': 'preceding-branches-imply-lower-bound', 'line': c.lineno,
                                      'assumption': 'stable builtin ordered numeric value; custom comparisons are not proven',
                                      'excludedFromScore': False})
            if upper is None: break
            lower = upper
            branch = branch.orelse[0] if len(branch.orelse) == 1 else None
    return notes


def plan(payload):
    result = {'version': VERSION, 'inputs': [], 'diagnostics': [], 'assertionOracle': False}
    source = payload.get('source', '')
    if not isinstance(source, str) or len(source) > 250000: return result
    try:
        tree = ast.parse(source)
        scope = find_target_scope(tree, payload.get('target'))
        if not isinstance(scope, ast.FunctionDef): return result
        survivors = [m for m in payload.get('mutants', [])[:256] if m.get('status') == 'SURVIVED']
        result['diagnostics'] = conditional_equivalence(scope, survivors)
        # Classes, variadic calls, unknown defaults and keyword-only signatures
        # require richer setup planning; do not infer an instance or its state.
        if '.' in payload.get('target', '') or scope.args.vararg or scope.args.kwarg or scope.args.kwonlyargs: return result
        names = [a.arg for a in scope.args.posonlyargs + scope.args.args]
        if not names or len(names) > 6: return result
        if any(isinstance(n, ast.Name) and n.id == 'round' and isinstance(n.ctx, ast.Store)
               or isinstance(n, ast.arg) and n.arg == 'round'
               or isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == 'round'
               or isinstance(n, ast.alias) and (n.asname or n.name.split('.')[0]) == 'round' for n in ast.walk(tree)): return result
        seeds = []
        for item in payload.get('observations', [])[:64]:
            if item.get('call_assertable') is False or item.get('constructor_args') or item.get('constructor_kwargs'): continue
            args = item.get('args', [])
            kwargs = item.get('kwargs', {})
            if len(args) > len(names) or any(k not in names[len(args):] for k in kwargs): continue
            values = dict(zip(names, [scalar(v) for v in args]))
            values.update({k: scalar(v) for k, v in kwargs.items()})
            if set(values) == set(names) and all(number(v) for v in values.values()): seeds.append(values)
        if not seeds: return result
        bindings = {}
        for statement in scope.body:
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant): continue
            if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name): break
            bindings[statement.targets[0].id] = expand(statement.value, bindings)
        comparisons = [n for n in mutation_scope_walk(scope) if isinstance(n, ast.Compare)]
        seen = {tuple(s[n] for n in names) for s in seeds}
        experiments = []
        for m in survivors:
            if m.get('kind', '').lower() != 'compare': continue
            matches = [c for c in comparisons if (c.lineno, c.col_offset) == (m.get('line'), m.get('column'))]
            if len(matches) != 1: continue
            c, pos = matches[0], m.get('position', -1)
            if type(pos) is not int or not 0 <= pos < len(c.ops) or type(c.ops[pos]).__name__ != m.get('from'): continue
            if not isinstance(c.ops[pos], (ast.Lt, ast.LtE, ast.Gt, ast.GtE)): continue
            operands = [c.left] + c.comparators
            left, right = [expand(n, bindings) for n in operands[pos:pos + 2]]
            for expression, boundary in [(left, right), (right, left)]:
                try: desired = evaluate(boundary, {})
                except (ValueError, KeyError, ArithmeticError): continue
                for seed in seeds[:4]:
                    for name in names:
                        try:
                            value = solve(expression, name, desired, seed)
                            values = {**seed, name: value}
                            if not number(value) or not math.isclose(evaluate(expression, values), desired, rel_tol=1e-10, abs_tol=1e-10): continue
                            key = tuple(values[n] for n in names)
                            if key in seen: continue
                            seen.add(key)
                            experiments.append({'args': list(key), 'kwargs': {}, 'mutantId': m['id']})
                            break
                        except (ValueError, KeyError, ArithmeticError): continue
                    if experiments and experiments[-1]['mutantId'] == m['id']: break
        result['inputs'] = experiments[:LIMIT]
    except (SyntaxError, ValueError, TypeError, KeyError, ArithmeticError, RecursionError):
        result['diagnostics'].append({'status': 'unsupported', 'reasonCode': 'bounded-planning-unavailable', 'excludedFromScore': False})
    return result


if __name__ == '__main__':
    print(json.dumps(plan(json.load(sys.stdin)), allow_nan=False))
