"""Read-only, bounded unittest facts. Never import or execute submitted code.

Unknown scopes remain unknown. Observations are supplied by the host after its
source/run identity and isolation checks; source expressions are not oracles.
"""
import ast
import hashlib
import json
import sys
from trace_value_codec import snapshot_value, restore_value


class Unknown(Exception):
    pass


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = dotted(node.value)
        return prefix + '.' + node.attr if prefix else ''
    return ''


def same_call(left, right):
    """The outer args transport may be list/tuple; nested input types/order stay exact."""
    if not left or not right:
        return False
    try:
        def normalize(snapshot):
            fields = restore_value(snapshot)
            if type(fields) is dict and set(fields) == {'args', 'kwargs', 'constructor_args', 'constructor_kwargs'}:
                if type(fields['constructor_args']) not in (tuple, list) or fields['constructor_args'] or fields['constructor_kwargs'] != {}:
                    raise ValueError('constructor unsupported')
                fields = {'args': fields['args'], 'kwargs': fields['kwargs']}
            if type(fields) is not dict or set(fields) != {'args', 'kwargs'} or type(fields['args']) not in (list, tuple) or type(fields['kwargs']) is not dict:
                raise ValueError('unsupported call')
            return snapshot_value({'args': tuple(fields['args']), 'kwargs': fields['kwargs']})
        return normalize(left) == normalize(right)
    except (ValueError, TypeError, KeyError):
        return False


def build_review_facts(payload):
    code = payload['code']
    if len(code) > 120000:
        raise ValueError('test-facts-budget')
    tree = ast.parse(code)
    if sum(1 for _ in ast.walk(tree)) > 12000:
        raise ValueError('test-facts-budget')
    aliases = {}
    imports = []
    rebound = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for item in node.names:
                binding = item.asname or item.name.split('.')[0]
                aliases[binding] = item.name if item.asname else binding
                imports.append({'line': node.lineno, 'binding': binding, 'origin': item.name})
        elif isinstance(node, ast.ImportFrom) and not node.level:
            for item in node.names:
                if item.name != '*':
                    binding = item.asname or item.name
                    aliases[binding] = (node.module or '') + '.' + item.name
                    imports.append({'line': node.lineno, 'binding': binding, 'origin': aliases[binding]})
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            rebound.add(node.name)
        else:
            rebound.update(item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Store))
    for binding in rebound:
        aliases.pop(binding, None)
    latest_import = {item['binding']: item for item in imports}
    imports = [item for item in imports if item['binding'] not in rebound and latest_import[item['binding']] is item]

    def resolve(node, local):
        text = dotted(node)
        root, _, tail = text.partition('.')
        if not root or root in local or root not in aliases:
            return ''
        return aliases[root] + ('.' + tail if tail else '')

    target = payload['module'] + '.' + payload['target']
    observations = payload.get('observations', [])
    classes, methods = [], []
    # A custom loader means static test discovery cannot establish execution.
    custom_loader = any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'load_tests' for node in tree.body)
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef) or cls.decorator_list or cls.keywords:
            continue
        if len(cls.bases) != 1 or resolve(cls.bases[0], {}) not in ('unittest.TestCase', 'unittest.IsolatedAsyncioTestCase'):
            continue
        classes.append({'line': cls.lineno, 'name': cls.name, 'kind': 'unittest-harness'})
        overrides = {node.name for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith('test_')}
        for node in cls.body:
            if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                overrides.update(item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Store))
        for method in cls.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith('test_') or method.decorator_list:
                continue
            params = method.args.posonlyargs + method.args.args
            if len(params) != 1 or method.args.vararg or method.args.kwarg or method.args.kwonlyargs:
                continue
            receiver = params[0].arg
            facts = {'line': method.lineno, 'endLine': method.end_lineno, 'name': cls.name + '.' + method.name,
                     'assertions': [], 'calls': [], 'exceptionGuards': [], 'scalarBindings': []}
            # All assigned local names shadow module aliases, including assignments later in the method.
            local = {node.id: None for node in ast.walk(method) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)}
            local[receiver] = None

            def literal(node):
                if isinstance(node, ast.Name) and node.id in local and isinstance(local[node.id], tuple) and local[node.id][0] == 'literal':
                    return local[node.id][1]
                try:
                    result = ast.literal_eval(node)
                except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
                    raise Unknown() from None
                snap = snapshot_value(result)
                if not snap['replayable']:
                    raise Unknown()
                return result

            def expression(node):
                if isinstance(node, ast.Await):
                    return expression(node.value)
                if isinstance(node, ast.Name) and isinstance(local.get(node.id), tuple):
                    return local[node.id]
                if isinstance(node, ast.Subscript):
                    base = expression(node.value)
                    index = literal(node.slice)
                    if base[0] == 'result' and type(index) is int:
                        return ('result', base[1], base[2] + [index])
                if isinstance(node, ast.Call) and resolve(node.func, local) == target:
                    if any(isinstance(arg, ast.Starred) for arg in node.args) or any(item.arg is None for item in node.keywords):
                        return ('result', None, [])
                    try:
                        args = [literal(arg) for arg in node.args]
                        kwargs = {item.arg: literal(item.value) for item in node.keywords}
                    except Unknown:
                        return ('result', None, [])
                    call = snapshot_value({'args': args, 'kwargs': kwargs})
                    facts['calls'].append({'line': node.lineno, 'call': call})
                    return ('result', call, [])
                return ('literal', literal(node))

            def assign(binding, value, line):
                if isinstance(binding, ast.Name):
                    local[binding.id] = value
                    if value and value[0] == 'literal' and type(value[1]) in (int, float, bool, str, type(None)):
                        facts['scalarBindings'].append({'line': line, 'name': binding.id, 'type': type(value[1]).__name__})
                elif isinstance(binding, (ast.Tuple, ast.List)):
                    for index, child in enumerate(binding.elts):
                        part = ('result', value[1], value[2] + [index]) if value and value[0] == 'result' else None
                        assign(child, part, line)

            def assertion(node):
                if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or dotted(node.func.value) != receiver:
                    return
                kind = node.func.attr
                if not kind.startswith('assert') or kind in overrides:
                    return
                fact = {'line': node.lineno, 'kind': kind}
                facts['assertions'].append(fact)
                if kind not in ('assertEqual', 'assertAlmostEqual', 'assertTupleEqual', 'assertListEqual', 'assertDictEqual', 'assertSequenceEqual') or len(node.args) < 2:
                    return
                try:
                    left, right = expression(node.args[0]), expression(node.args[1])
                    actual, expected = (left, right) if left[0] == 'result' and right[0] == 'literal' else (right, left)
                    if actual[0] != 'result' or expected[0] != 'literal':
                        return
                    fact.update({'targetResult': True, 'expectedType': type(expected[1]).__name__, 'expected': snapshot_value(expected[1])})
                    matches = [item for item in observations if same_call(item.get('call'), actual[1]) and 'result_snapshot' in item]
                    if not matches or any(item['result_snapshot'] != matches[0]['result_snapshot'] for item in matches):
                        return
                    value = restore_value(matches[0]['result_snapshot'])
                    for index in actual[2]:
                        if type(value) not in (tuple, list):
                            raise Unknown()
                        value = value[index]
                    if kind == 'assertAlmostEqual':
                        places = literal(node.args[2]) if len(node.args) > 2 else 7
                        keywords = {item.arg: literal(item.value) for item in node.keywords}
                        if set(keywords) - {'places', 'delta', 'msg'}:
                            raise Unknown()
                        places = keywords.get('places', places)
                        if type(value) not in (float, int) or type(expected[1]) not in (float, int) or type(places) is not int or abs(places) > 12:
                            raise Unknown()
                        equal = abs(value - expected[1]) <= keywords['delta'] if 'delta' in keywords else round(abs(value - expected[1]), places) == 0
                    else:
                        equal = value == expected[1]
                    if equal:
                        fact['observationVerified'] = True
                except (Unknown, ValueError, TypeError, IndexError, OverflowError):
                    return

            def walk(statements):
                for stmt in statements:
                    try:
                        if isinstance(stmt, ast.Assign):
                            try:
                                value = expression(stmt.value)
                            except Unknown:
                                value = None
                            for binding in stmt.targets:
                                assign(binding, value, stmt.lineno)
                        elif isinstance(stmt, ast.AnnAssign):
                            try:
                                value = expression(stmt.value) if stmt.value else None
                            except Unknown:
                                value = None
                            assign(stmt.target, value, stmt.lineno)
                        elif isinstance(stmt, ast.Expr):
                            if isinstance(stmt.value, ast.Constant):
                                continue
                            assertion(stmt.value)
                            # Unknown arbitrary calls may mutate prior results; do not propagate them.
                            if not (isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Attribute) and dotted(stmt.value.func.value) == receiver and stmt.value.func.attr.startswith('assert')):
                                break
                        elif isinstance(stmt, ast.With) and len(stmt.items) == 1:
                            guard = stmt.items[0].context_expr
                            if not isinstance(guard, ast.Call) or not isinstance(guard.func, ast.Attribute) or dotted(guard.func.value) != receiver or guard.func.attr not in ('assertRaises', 'assertRaisesRegex') or guard.func.attr in overrides or not guard.args:
                                break
                            exception = dotted(guard.args[0])
                            resolved_exception = resolve(guard.args[0], local)
                            if resolved_exception.startswith('builtins.'):
                                exception = resolved_exception
                            elif not (isinstance(guard.args[0], ast.Name) and exception in ('TypeError', 'ZeroDivisionError')
                                      and exception not in local and exception not in aliases and exception not in rebound):
                                exception = 'unknown'
                            calls = []
                            for body in stmt.body:
                                if not isinstance(body, ast.Expr):
                                    raise Unknown()
                                result = expression(body.value)
                                if result[0] != 'result':
                                    raise Unknown()
                                calls.append(body.lineno)
                            facts['exceptionGuards'].append({'line': stmt.lineno, 'exception': exception, 'callLines': calls})
                        else:
                            # Do not promote conditional, loop, try, nested or transformed results.
                            break
                    except Unknown:
                        break
            if not custom_loader:
                walk(method.body)
            methods.append(facts)
    return {'schemaVersion': 'review-test-facts-v1', 'runId': payload['runId'], 'sourceHash': payload['sourceHash'],
            'target': payload['target'], 'module': payload['module'], 'testHash': hashlib.sha256(code.encode()).hexdigest(),
            'executionVerified': payload.get('executionVerified') is True, 'imports': imports, 'classes': classes, 'methods': methods,
            'limitations': 'Static facts cover only directly resolved unittest constructs and straight-line literal target calls. Unknown or unexecuted paths are not observations.'}


if __name__ == '__main__':
    try:
        result = build_review_facts(json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=True))
    except (ValueError, KeyError, TypeError, SyntaxError, RecursionError):
        print(json.dumps({'error': 'review-test-facts-unavailable'}))
        sys.exit(1)
