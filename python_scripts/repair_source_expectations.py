"""Bounded, source-derived arithmetic correction of failed test expectations.

Interprets a deliberately small AST subset; never imports/executes submitted
source or changes inputs. Full-mode return/exception proposals require the
host's independent exact-input execution before adoption.
This verifies agreement with source, not independent business requirements.
"""
import ast
import copy
import json
import math
import operator
import re
import sys
from dataclasses import dataclass
from trace_value_codec import snapshot_value


class Unsupported(ValueError):
    pass


class PredictedArithmeticError(Exception):
    """A bounded builtin operation raised; still requires independent Trace."""
    pass


def bounded(value):
    if type(value) in (int, float):
        if not math.isfinite(value) or abs(value) > 1e15:
            raise Unsupported('numeric limit')
    elif type(value) is str:
        if len(value) > 256:
            raise Unsupported('string limit')
    elif type(value) in (tuple, list):
        if len(value) > 16:
            raise Unsupported('sequence limit')
        for item in value:
            bounded(item)
    elif value is not None and type(value) is not bool:
        raise Unsupported('value type')
    return value


def name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == 'self':
        return 'self.' + node.attr
    raise Unsupported('binding')


@dataclass
class Value:
    data: object
    origin: object = None


class Calculator:
    def __init__(self):
        self.steps = 0

    def expression(self, node, values, builtins=False):
        self.steps += 1
        if self.steps > 2000:
            raise Unsupported('step limit')
        if isinstance(node, ast.Constant):
            return Value(bounded(node.value))
        if isinstance(node, (ast.Name, ast.Attribute)):
            if name(node) not in values:
                raise Unsupported('unknown name')
            return values[name(node)]
        if isinstance(node, (ast.Tuple, ast.List)):
            items = [self.expression(item, values, builtins) for item in node.elts]
            if any(item.origin for item in items):
                raise Unsupported('mixed result')
            return Value(bounded(tuple(item.data for item in items) if isinstance(node, ast.Tuple) else [item.data for item in items]))
        if isinstance(node, ast.Subscript):
            base = self.expression(node.value, values, builtins)
            index = self.expression(node.slice, values, builtins)
            if type(base.data) not in (tuple, list) or type(index.data) is not int or index.origin:
                raise Unsupported('index')
            return Value(base.data[index.data], base.origin)
        if isinstance(node, ast.UnaryOp) and type(node.op) in (ast.UAdd, ast.USub, ast.Not):
            value = self.expression(node.operand, values, builtins)
            if value.origin or type(value.data) not in (int, float, bool):
                raise Unsupported('unary result')
            op = {ast.UAdd: operator.pos, ast.USub: operator.neg, ast.Not: operator.not_}[type(node.op)]
            return Value(bounded(op(value.data)))
        if isinstance(node, ast.BinOp):
            left, right = self.expression(node.left, values, builtins), self.expression(node.right, values, builtins)
            if left.origin or right.origin:
                raise Unsupported('arithmetic operands')
            ops = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
                   ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow}
            if type(left.data) not in (int, float, bool) or type(right.data) not in (int, float, bool):
                # These operators cannot format/repeat strings or invoke user code.
                # Unsupported syntax, custom objects and other operations are not exceptions.
                if builtins and type(node.op) in (ast.Sub, ast.Div, ast.FloorDiv, ast.Pow) and all(
                        type(item.data) in (int, float, bool, str, type(None)) for item in (left, right)):
                    try:
                        ops[type(node.op)](left.data, right.data)
                    except TypeError:
                        raise PredictedArithmeticError('TypeError') from None
                raise Unsupported('arithmetic operands')
            if type(node.op) not in ops or (isinstance(node.op, ast.Pow) and abs(right.data) > 8):
                raise Unsupported('operator limit')
            try:
                return Value(bounded(ops[type(node.op)](left.data, right.data)))
            except ZeroDivisionError:
                if builtins:
                    raise PredictedArithmeticError('ZeroDivisionError') from None
                raise
        if isinstance(node, ast.Compare):
            operands = [self.expression(item, values, builtins) for item in [node.left, *node.comparators]]
            if any(item.origin for item in operands):
                raise Unsupported('result comparison')
            ops = {ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Eq: operator.eq, ast.NotEq: operator.ne}
            if any(type(op) not in ops for op in node.ops):
                raise Unsupported('comparison')
            return Value(all(ops[type(op)](a.data, b.data) for op, a, b in zip(node.ops, operands, operands[1:])))
        if isinstance(node, ast.Call) and builtins and isinstance(node.func, ast.Name) and node.func.id in ('round', 'abs'):
            if node.func.id in values or node.keywords:
                raise Unsupported('shadowed builtin')
            args = [self.expression(arg, values, builtins) for arg in node.args]
            if any(arg.origin or type(arg.data) not in (int, float) for arg in args):
                raise Unsupported('builtin argument')
            if node.func.id == 'round' and len(args) == 2 and (type(args[1].data) is not int or abs(args[1].data) > 12):
                raise Unsupported('rounding limit')
            return Value(bounded({'round': round, 'abs': abs}[node.func.id](*(arg.data for arg in args))))
        raise Unsupported(type(node).__name__)


def assign(dest, value, values):
    if isinstance(dest, (ast.Tuple, ast.List)):
        if type(value.data) not in (tuple, list) or len(dest.elts) != len(value.data):
            raise Unsupported('unpack shape')
        for child, item in zip(dest.elts, value.data):
            assign(child, Value(item, value.origin), values)
    else:
        values[name(dest)] = value


def source_result(function, args, kwargs, calculator):
    spec = function.args
    if function.decorator_list or spec.vararg or spec.kwarg or spec.kwonlyargs:
        raise Unsupported('signature')
    params = [arg.arg for arg in [*spec.posonlyargs, *spec.args]]
    if len(args) > len(params) or any(arg.origin for arg in [*args, *kwargs.values()]):
        raise Unsupported('inputs')
    values = dict(zip(params, args))
    for key, value in kwargs.items():
        if key not in params or key in values or key in params[:len(spec.posonlyargs)]:
            raise Unsupported('keyword binding')
        values[key] = value
    defaults = dict(zip(params[len(params) - len(spec.defaults):], spec.defaults)) if spec.defaults else {}
    for param in params:
        if param not in values:
            values[param] = calculator.expression(defaults[param], {})
    inputs = {key: value.data for key, value in values.items()}
    steps = []

    def visit(nodes):
        for statement in nodes:
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
                continue
            if isinstance(statement, ast.Assign) and all(isinstance(dest, ast.Name) for dest in statement.targets):
                value = calculator.expression(statement.value, values, True)
                for dest in statement.targets:
                    values[dest.id] = value
                steps.append({'line': statement.lineno, 'expression': ast.unparse(statement.value), 'value': value.data})
            elif isinstance(statement, ast.If):
                condition = calculator.expression(statement.test, values, True).data
                steps.append({'line': statement.lineno, 'condition': ast.unparse(statement.test), 'value': bool(condition)})
                found, result = visit(statement.body if condition else statement.orelse)
                if found:
                    return True, result
            elif isinstance(statement, ast.Return):
                return True, calculator.expression(statement.value, values, True).data
            else:
                raise Unsupported('source statement')
        return False, None

    call = snapshot_value({'args': tuple(arg.data for arg in args),
                           'kwargs': {key: value.data for key, value in kwargs.items()}})
    try:
        found, result = visit(function.body)
    except PredictedArithmeticError as error:
        return Value(None, {'inputs': inputs, 'steps': steps, 'call': call,
                           'exception': {'module': 'builtins', 'qualname': str(error)}})
    if not found:
        raise Unsupported('no explicit return')
    return Value(result, {'inputs': inputs, 'steps': steps, 'result': result,
        'call': call,
        'result_snapshot': snapshot_value(result)})


def repair(payload):
    code, source, failure = (payload.get(key, '') for key in ('code', 'source', 'failure'))
    empty = {'changed': False, 'reason': 'unsupported-or-no-proven-correction', 'corrections': []}
    numeric_skill = payload.get('numericSkill') is True
    if max(len(code), len(source), len(failure)) > 200000:
        return empty
    # ERROR is eligible only in full mode, with a source-supported exception
    # proposal that the host must independently verify for the identical inputs.
    failed = re.findall(r'^(?:FAIL|ERROR): (test_\w+) \(([^)\n]+)\)' if numeric_skill
                        else r'^FAIL: (test_\w+) \(([^)\n]+)\)', failure, re.M)
    if not failed:
        return empty
    tree, source_tree = ast.parse(code), ast.parse(source)
    if sum(1 for _ in ast.walk(tree)) > 5000 or sum(1 for _ in ast.walk(source_tree)) > 5000:
        return empty
    target, module = payload['target'], payload['module']
    functions = [node for node in source_tree.body if isinstance(node, ast.FunctionDef) and node.name == target]
    if len(functions) != 1:
        return empty
    function = functions[0]
    # Reject *all* unsupported source operations, even in unselected branches.
    permitted = (ast.FunctionDef, ast.arguments, ast.arg, ast.Expr, ast.Constant, ast.Assign, ast.Name, ast.Load, ast.Store,
        ast.If, ast.Return, ast.BinOp, ast.UnaryOp, ast.Compare, ast.Call, ast.Tuple, ast.List,
        ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.UAdd, ast.USub, ast.Not,
        ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Eq, ast.NotEq)
    if function.decorator_list or any(not isinstance(node, permitted) for node in ast.walk(function)):
        return empty
    if any(isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in ('round', 'abs')) for node in ast.walk(function)):
        return empty
    # Module-scope rebinding could change the meaning of a builtin or target.
    bound = []
    for node in source_tree.body:
        if node is function:
            continue
        if isinstance(node, ast.ClassDef) or (isinstance(node, ast.FunctionDef) and (
                node.decorator_list or any(isinstance(child, ast.Call) for value in [*node.args.defaults, *(item for item in node.args.kw_defaults if item)] for child in ast.walk(value)))):
            return empty
        if not isinstance(node, (ast.FunctionDef, ast.ClassDef)) and not (
                isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)) and not (
                isinstance(node, ast.If) and ast.unparse(node.test) == "__name__ == '__main__'"):
            return empty
        bound.extend(child.id for child in ast.walk(node) if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store))
        bound.extend(alias.asname or alias.name.split('.')[0] for child in ast.walk(node) if isinstance(child, (ast.Import, ast.ImportFrom)) for alias in child.names)
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            bound.append(node.name)
    if set(bound) & {target, 'round', 'abs'}:
        return empty
    aliases, unit_aliases = set(), {'unittest.TestCase'}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for item in node.names:
                if item.name == module:
                    aliases.add((item.asname or item.name) + '.' + target)
                if item.name == 'unittest':
                    unit_aliases.add((item.asname or item.name) + '.TestCase')
        if isinstance(node, ast.ImportFrom) and node.module == module and not node.level:
            aliases.update(item.asname or item.name for item in node.names if item.name == target)
        if isinstance(node, ast.ImportFrom) and node.module == 'unittest':
            unit_aliases.update(item.asname or item.name for item in node.names if item.name == 'TestCase')
    if not aliases:
        return empty
    builtin_names = {'type', 'int', 'float', 'str', 'bool', 'tuple', 'list', 'TypeError', 'ZeroDivisionError'}
    if numeric_skill and any(
            isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id in builtin_names
            or isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in builtin_names
            or isinstance(node, ast.arg) and node.arg in builtin_names
            or isinstance(node, (ast.Import, ast.ImportFrom)) and any(
                (item.asname or item.name.split('.')[0]) in builtin_names or item.name == '*' for item in node.names)
            for node in ast.walk(tree)):
        return empty
    if numeric_skill and (len({node.name for node in tree.body if isinstance(node, ast.ClassDef)})
            != len([node for node in tree.body if isinstance(node, ast.ClassDef)])):
        return empty
    # Reject target/builtin rebinding, alternate fixtures, module execution and decorators.
    for node in tree.body:
        if not isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef)):
            # A guarded unittest.main entrypoint has no effect during import.
            if not (isinstance(node, ast.If) and ast.unparse(node.test) in ("__name__ == '__main__'", "'__main__' == __name__")):
                return empty
    if any(isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id in {item.split('.')[0] for item in aliases} | {'round', 'abs'} for node in ast.walk(tree)):
        return empty
    replacements, corrections = [], []
    for cls in (node for node in tree.body if isinstance(node, ast.ClassDef)):
        if cls.decorator_list or cls.keywords or len(cls.bases) != 1 or ast.unparse(cls.bases[0]) not in unit_aliases:
            continue
        methods = [node for node in cls.body if isinstance(node, ast.FunctionDef)]
        if any(node.name not in ('setUp',) and not node.name.startswith('test_') for node in methods):
            continue
        if any(not isinstance(node, ast.FunctionDef) for node in cls.body):
            continue
        for method in methods:
            if method.decorator_list or not any(method.name == test and identifier.endswith('.' + cls.name + '.' + test) for test, identifier in failed):
                continue
            if len([m for m in methods if m.name == method.name]) != 1:
                continue
            calculator, values, pending = Calculator(), {}, []
            try:
                def target_value(call):
                    if not isinstance(call, ast.Call) or ast.unparse(call.func) not in aliases or any(item.arg is None for item in call.keywords):
                        raise Unsupported('target call')
                    if len({item.arg for item in call.keywords}) != len(call.keywords):
                        raise Unsupported('duplicate keywords')
                    value = source_result(function, [calculator.expression(arg, values) for arg in call.args],
                        {item.arg: calculator.expression(item.value, values) for item in call.keywords}, calculator)
                    if value.origin.get('exception') and not numeric_skill:
                        raise Unsupported('exception requires isolated verification')
                    return value

                def exception_edit(statement, call, value, tail):
                    # Preserve setup/inputs/passing assertions. Replace only the failed
                    # call and its unreachable return assertions, never unrelated work.
                    if statement not in method.body:
                        raise Unsupported('shared fixture exception')
                    if isinstance(statement, ast.Assign):
                        destinations = [node for dest in statement.targets for node in ast.walk(dest)
                                        if isinstance(node, ast.Name)]
                        if not destinations or any(not isinstance(node, (ast.Name, ast.Tuple, ast.List, ast.Store))
                                                  for dest in statement.targets for node in ast.walk(dest)):
                            raise Unsupported('exception result binding')
                        outputs = {node.id for node in destinations}
                        if not tail:
                            raise Unsupported('missing result assertions')
                        for item in tail:
                            assertion = item.value if isinstance(item, ast.Expr) else None
                            if not (isinstance(assertion, ast.Call) and ast.unparse(assertion.func)
                                    in ('self.assertEqual', 'self.assertAlmostEqual') and len(assertion.args) >= 2
                                    and isinstance(assertion.args[0], ast.Name) and assertion.args[0].id in outputs):
                                raise Unsupported('independent or compound exception tail')
                            for argument in [*assertion.args[1:], *(kw.value for kw in assertion.keywords)]:
                                if calculator.expression(argument, values).origin:
                                    raise Unsupported('target-derived expectation')
                    elif tail:
                        raise Unsupported('exception scope')
                    span = copy.copy(statement)
                    if tail:
                        span.end_lineno, span.end_col_offset = tail[-1].end_lineno, tail[-1].end_col_offset
                    exception = value.origin['exception']['qualname']
                    replacement = ('with self.assertRaises(' + exception + '):\n'
                                   + ' ' * (statement.col_offset + 4) + ast.get_source_segment(code, call))
                    return (span, {'method': cls.name + '.' + method.name, 'line': statement.lineno,
                                   'kind': 'return-to-exception', 'basis': value.origin}, replacement)

                fixture = [node for node in methods if node.name == 'setUp']
                if len(fixture) > 1 or any(node.decorator_list for node in fixture):
                    raise Unsupported('fixture')
                if numeric_skill and fixture:
                    for item in fixture[0].body:
                        if isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str):
                            continue
                        if not isinstance(item, ast.Assign) or any(
                                isinstance(dest, ast.Name) for target_node in item.targets for dest in ast.walk(target_node)
                                if isinstance(dest, ast.Name) and isinstance(dest.ctx, ast.Store)):
                            raise Unsupported('fixture must only assign instance data')
                statements = [*(fixture[0].body if fixture else []), *method.body]
                for index, statement in enumerate(statements):
                    if isinstance(statement, ast.Assign):
                        call = statement.value
                        if isinstance(call, ast.Call) and ast.unparse(call.func) in aliases:
                            value = target_value(call)
                            if value.origin.get('exception'):
                                pending.append(exception_edit(statement, call, value, statements[index + 1:]))
                                break
                        else:
                            value = calculator.expression(statement.value, values)
                        for dest in statement.targets:
                            if numeric_skill and any(isinstance(child, ast.Attribute) and child.attr.startswith('assert') for child in ast.walk(dest)):
                                raise Unsupported('assertion rebinding')
                            assign(dest, value, values)
                    elif numeric_skill and isinstance(statement, ast.With):
                        # Only a single, side-effect-free target call. Never remove a
                        # compound exception test or a context variable used later.
                        if len(statement.items) != 1 or statement.items[0].optional_vars is not None or len(statement.body) != 1:
                            raise Unsupported('exception scope')
                        context = statement.items[0].context_expr
                        body = statement.body[0]
                        if not (isinstance(context, ast.Call) and ast.unparse(context.func) == 'self.assertRaises'
                                and len(context.args) == 1 and isinstance(context.args[0], ast.Name) and not context.keywords
                                and isinstance(body, ast.Expr)):
                            raise Unsupported('exception assertion')
                        value = target_value(body.value)
                        if value.origin.get('exception'):
                            exception = value.origin['exception']
                            if (exception.get('module') == 'builtins'
                                    and context.args[0].id == exception.get('qualname')
                                    and context.args[0].id in ('TypeError', 'ZeroDivisionError')):
                                # Keep the proven exception block verbatim and inspect
                                # later statements. The whole candidate still reexecutes.
                                continue
                            raise Unsupported('existing exception assertion')
                        # This is a proposal only. Full mode must independently
                        # observe this exact call returning before adopting it.
                        pending.append((statement, {'method': cls.name + '.' + method.name, 'line': statement.lineno,
                            'previous': {'exception': context.args[0].id}, 'calculated': value.data,
                            'basis': value.origin, 'kind': 'exception-to-return'},
                            'self.assertEqual(' + ast.get_source_segment(code, body.value) + ', ' + repr(value.data) + ')'))
                    elif isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
                        continue
                    elif isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
                        call = statement.value
                        if numeric_skill and ast.unparse(call.func) in ('self.assertEqual', 'self.assertIs', 'self.assertIsInstance') and len(call.args) == 2 and not call.keywords:
                            actual_node, expected_type = call.args
                            type_call = (isinstance(actual_node, ast.Call) and ast.unparse(actual_node.func) == 'type'
                                         and len(actual_node.args) == 1 and not actual_node.keywords)
                            if type_call or ast.unparse(call.func) == 'self.assertIsInstance':
                                types = {'int': int, 'float': float, 'str': str, 'bool': bool, 'tuple': tuple, 'list': list}
                                actual = calculator.expression(actual_node.args[0] if type_call else actual_node, values)
                                if not isinstance(expected_type, ast.Name) or expected_type.id not in types or type(actual.data) is not types[expected_type.id]:
                                    raise Unsupported('unproven type assertion')
                                continue  # Keep the original type assertion verbatim.
                        if not (isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == 'self'
                                and call.func.attr in ('assertEqual', 'assertAlmostEqual') and len(call.args) >= 2):
                            raise Unsupported('assertion')
                        actual = target_value(call.args[0]) if numeric_skill and isinstance(call.args[0], ast.Call) else calculator.expression(call.args[0], values)
                        expected = calculator.expression(call.args[1], values)
                        # No target-derived expected values, hidden calls in messages/delta, or weakened asserts.
                        extras = [*call.args[2:], *(item.value for item in call.keywords)]
                        if any(calculator.expression(item, values).origin for item in extras) or expected.origin:
                            raise Unsupported('oracle')
                        if actual.origin and actual.origin.get('exception'):
                            pending.append(exception_edit(statement, call.args[0], actual, statements[index + 1:]))
                            break
                        if actual.origin and actual.data != expected.data:
                            if call.func.attr == 'assertAlmostEqual' and (type(actual.data) not in (int, float) or type(expected.data) not in (int, float)):
                                raise Unsupported('numeric assertion')
                            pending.append((call.args[1], {'method': cls.name + '.' + method.name, 'line': call.lineno,
                                'previous': expected.data, 'calculated': actual.data, 'basis': actual.origin}, repr(actual.data)))
                    else:
                        raise Unsupported('test statement')
                for node, proof, replacement in pending:
                    replacements.append((node, replacement))
                    corrections.append(proof)
            except (Unsupported, ArithmeticError, KeyError, IndexError, TypeError):
                continue
    if not replacements:
        return empty
    if numeric_skill and len(corrections) > 32:
        return empty
    raw_lines = code.encode('utf-8').splitlines(keepends=True)
    edits = [(sum(map(len, raw_lines[:node.lineno - 1])) + node.col_offset,
              sum(map(len, raw_lines[:node.end_lineno - 1])) + node.end_col_offset, text.encode('utf-8')) for node, text in replacements]
    data = code.encode('utf-8')
    for start, end, text in sorted(edits, reverse=True):
        data = data[:start] + text + data[end:]
    candidate = data.decode('utf-8')
    ast.parse(candidate)
    return {'changed': True, 'code': candidate, 'basis': 'source-derived-arithmetic-v1',
            'limitation': 'Agreement with source, not independent requirement verification.', 'corrections': corrections}


if __name__ == '__main__':
    try:
        result = repair(json.load(sys.stdin))
    except (ValueError, TypeError, KeyError, ArithmeticError, RecursionError):
        result = {'changed': False, 'reason': 'unsupported-or-invalid-input', 'corrections': []}
    print(json.dumps(result, ensure_ascii=False))
