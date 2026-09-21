"""Check literal assertions against exact real Trace calls without executing tests.

Only straight-line, unmocked module-function calls are proven here. Other
contexts remain unknown and must pass the isolated execution/mutation gates.
"""
import ast
import json
import sys

from probe_input_transport import restore_call
from trace_value_codec import snapshot_value


def literal(node):
    return ast.literal_eval(node)


def signature(args, keywords):
    # Preserve types, literal spelling and keyword insertion order. A target
    # accepting **kwargs can observe order, so sorting would merge distinct calls.
    for node in list(args) + [value for _, value in keywords]:
        literal(node)
    return tuple(ast.dump(node) for node in args), tuple((key, ast.dump(value)) for key, value in keywords)


def literal_keywords(keywords):
    """Expand only literal **dict arguments with Python's ordering semantics.

    Within one dict, the last value wins while the first key position remains.
    Duplicates across call keywords/expansions would raise TypeError, so they
    cannot borrow a successful Trace call's oracle. Every overwritten value is
    still checked: evaluating an unknown expression can change target state.
    """
    expanded, seen = [], set()
    for keyword in keywords:
        if keyword.arg is not None:
            entries = [(keyword.arg, keyword.value)]
        else:
            if not isinstance(keyword.value, ast.Dict):
                raise ValueError('Unknown keyword expansion')
            values = {}
            for key_node, value_node in zip(keyword.value.keys, keyword.value.values):
                if key_node is None:
                    raise ValueError('Nested keyword expansion is unknown')
                key = literal(key_node)
                if type(key) is not str:
                    raise ValueError('Keyword keys must be strings')
                literal(value_node)
                values[key] = value_node
            entries = list(values.items())
        for key, value in entries:
            if key in seen:
                raise ValueError('Duplicate call keyword')
            seen.add(key)
            expanded.append((key, value))
    return expanded


def observed_arguments(example):
    """Use exact typed input order when present; malformed facts never fall back."""
    if 'input_before' not in example:
        return ([ast.parse(value, mode='eval').body for value in example.get('args', [])],
                [(key, ast.parse(value, mode='eval').body) for key, value in example.get('kwargs', {}).items()])
    before = example['input_before']
    if type(before) is not dict or before.get('replayable') is not True:
        raise ValueError('Input snapshot is not replayable')
    call = restore_call(before.get('call_graph'))
    fields = ('args', 'kwargs', 'constructor_args', 'constructor_kwargs')
    if set(call) != set(fields) or any(snapshot_value(call[field]) != before.get(field) for field in fields):
        raise ValueError('Input snapshot views disagree')
    # restore_call only creates exact builtins; repr cannot invoke user hooks.
    return ([ast.parse(repr(value), mode='eval').body for value in call['args']],
            [(key, ast.parse(repr(value), mode='eval').body) for key, value in call['kwargs'].items()])


def check(payload):
    tree = ast.parse(payload['code'])
    target, module = payload['target'], payload.get('module')
    if payload.get('className'):
        return {'valid': True, 'checked': 0, 'unknown': 'class binding requires instance-specific evidence'}
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef)): continue
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str): continue
        if isinstance(node, ast.If) and ast.dump(node.test) == ast.dump(ast.parse("__name__ == '__main__'", mode='eval').body): continue
        return {'valid': True, 'checked': 0, 'unknown': 'module setup can change execution context'}
    names, modules = set(), set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == module and not node.level:
            for item in node.names:
                if item.name == target:
                    names.add(item.asname or item.name)
                elif item.name == '*':
                    names.add(target)
        elif isinstance(node, ast.Import):
            for item in node.names:
                if item.name == module:
                    modules.add(item.asname or item.name)
    def dotted(node):
        if isinstance(node, ast.Name): return node.id
        if isinstance(node, ast.Attribute): return dotted(node.value) + '.' + node.attr
        return ''
    aliases = names | modules
    # A module-level rebinding prevents proving the original imported callable.
    if any(isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.FunctionDef, ast.ClassDef))
           and any(isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store) and child.id in aliases
                   for child in ast.walk(node)) for node in tree.body if not isinstance(node, ast.ClassDef)):
        return {'valid': True, 'checked': 0, 'unknown': 'import binding may be rebound'}
    facts = {}
    for example in payload.get('trace', {}).get('examples', []):
        if example.get('call_assertable') is False or example.get('result_assertable') is False:
            continue
        try:
            args, kwargs = observed_arguments(example)
            key = signature(args, kwargs)
            value = literal(ast.parse(example['result'], mode='eval').body)
            # Conflicting observations are not a stable oracle.
            if key in facts and (type(facts[key]) is not type(value) or facts[key] != value):
                facts[key] = UNKNOWN
            else:
                facts[key] = value
        except (ValueError, TypeError, SyntaxError, KeyError):
            continue
    checked = 0
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef): continue
        fixtures = [node for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and not node.name.startswith('test_')]
        # Fixtures/decorators/unknown bases can alter dependencies; do not apply real Trace there.
        if cls.decorator_list or fixtures or len(cls.bases) != 1 or dotted(cls.bases[0]) != 'unittest.TestCase': continue
        for method in cls.body:
            if not isinstance(method, ast.FunctionDef) or not method.name.startswith('test_') or method.decorator_list: continue
            if any(isinstance(node, (ast.With, ast.AsyncWith, ast.Try, ast.If, ast.For, ast.While)) for node in ast.walk(method)): continue
            if any(isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id in aliases for node in ast.walk(method)): continue
            values = {}
            def result(node):
                if isinstance(node, ast.Name): return values.get(node.id, UNKNOWN)
                if not isinstance(node, ast.Call): return UNKNOWN
                call_name = dotted(node.func)
                if call_name not in names and call_name not in {name + '.' + target for name in modules}: return UNKNOWN
                try: return facts.get(signature(node.args, literal_keywords(node.keywords)), UNKNOWN)
                except (ValueError, TypeError): return UNKNOWN
            for statement in method.body:
                if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                    values[statement.targets[0].id] = result(statement.value)
                    # Unknown calls may mutate shared state before the next target invocation.
                    if values[statement.targets[0].id] is UNKNOWN and any(isinstance(node, ast.Call) for node in ast.walk(statement.value)): break
                    continue
                if not isinstance(statement, ast.Expr): break
                call = statement.value
                if isinstance(call, ast.Constant) and isinstance(call.value, str): continue
                if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute) or dotted(call.func.value) != 'self': break
                name = call.func.attr
                if name not in ('assertEqual', 'assertIs', 'assertIsNone', 'assertTrue', 'assertFalse'): break
                # Even an ignored assertion message/helper can change later observations.
                if any(isinstance(node, ast.Call) and node is not call and result(node) is UNKNOWN for node in ast.walk(call)): break
                if not call.args: continue
                observed = result(call.args[0])
                try:
                    if name in ('assertEqual', 'assertIs') and len(call.args) >= 2:
                        if observed is UNKNOWN:
                            observed = result(call.args[1]); expected = literal(call.args[0])
                        else: expected = literal(call.args[1])
                    elif name == 'assertIsNone': expected = None
                    elif name == 'assertTrue': expected = True
                    elif name == 'assertFalse': expected = False
                    else: continue
                except (ValueError, TypeError): continue
                if observed is UNKNOWN: continue
                if name == 'assertIs' and expected is not None and type(expected) is not bool: continue
                checked += 1
                matches = (observed is expected) if name in ('assertIs', 'assertIsNone') else (
                    bool(observed) == expected if name in ('assertTrue', 'assertFalse') else observed == expected)
                if not matches:
                    return {'valid': False, 'checked': checked,
                            'reason': f'已驗證 Trace 與 {cls.name}.{method.name} 第 {call.lineno} 行斷言矛盾：實測 {observed!r}，預期 {expected!r}。'}
    return {'valid': True, 'checked': checked}


UNKNOWN = object()
if __name__ == '__main__':
    print(json.dumps(check(json.loads(sys.stdin.read())), ensure_ascii=False))
