"""Plan/apply an AI-selected verbatim source argument; never execute application code."""
import ast
import hashlib
import json
import re
import sys

VERSION = 'source-literal-argument-repair-v1'
LIMIT = 256 * 1024


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def scope_nodes(node):
    yield node
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda,
                         ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        return
    for child in ast.iter_child_nodes(node):
        yield from scope_nodes(child)


def target_method_context(payload, named_method=None):
    source, code, failure, target = (payload.get(key) for key in ('source', 'code', 'failure', 'target'))
    if not all(isinstance(value, str) and len(value.encode('utf-8')) <= LIMIT
               for value in (source, code, failure, target)):
        return None
    if not target.isidentifier():
        return None
    if named_method is None:
        headers = set(re.findall(r'^(?:FAIL|ERROR): (\w+) \(([\w.]+)\)\r?$', failure, re.M))
        if len(headers) != 1:
            return None
        method_name, runtime_id = next(iter(headers))
    else:
        method_name, runtime_id = named_method, None
    if not isinstance(method_name, str) or not method_name.isidentifier() or not method_name.startswith('test_'):
        return None
    try:
        source_tree, test_tree = ast.parse(source), ast.parse(code)
    except (SyntaxError, ValueError, RecursionError):
        return None
    if sum(1 for _ in ast.walk(source_tree)) + sum(1 for _ in ast.walk(test_tree)) > 10000:
        return None
    if len(source_tree.body) != 1 or not isinstance(source_tree.body[0], (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None
    function = source_tree.body[0]
    if function.name != target:
        return None
    methods = [(owner, method) for owner in test_tree.body if isinstance(owner, ast.ClassDef)
               for method in owner.body if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))
               and method.name == method_name and (runtime_id is None or runtime_id.endswith('.' + owner.name + '.' + method.name))]
    if len(methods) != 1:
        return None
    owner, method = methods[0]
    return source, code, failure, target, function, owner, method, test_tree


def plan(payload):
    context = target_method_context(payload)
    if context is None:
        return None
    source, code, failure, target, function, owner, method, _ = context
    if not re.search(r'^AssertionError: expected call not found\.\r?$', failure, re.M):
        return None
    nodes = [part for statement in method.body for part in scope_nodes(statement)]
    assertions = [node for node in nodes if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                  and node.func.attr == 'assert_called_once_with' and node.args
                  and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)
                  and isinstance(node.func.value, ast.Attribute)]
    if len(assertions) != 1:
        return None
    assertion = assertions[0]
    old = assertion.args[0]
    collapsed = ' '.join(old.value.split())
    if not collapsed or len(old.value.encode('utf-8')) > 4096:
        return None
    source_nodes = [part for statement in function.body for part in scope_nodes(statement)]
    choices = []
    values = set()
    for call in source_nodes:
        if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute) or not call.args:
            continue
        value = call.args[0]
        if (call.func.attr != assertion.func.value.attr or not isinstance(value, ast.Constant)
                or not isinstance(value.value, str) or value.value == old.value
                or len(value.value.encode('utf-8')) > 4096 or value.value in values
                or ' '.join(value.value.split()) != collapsed):
            continue
        values.add(value.value)
        choices.append({'id': 'source-' + str(len(choices) + 1), 'source': repr(value.value),
                        'sourceLine': call.lineno, 'valueHash': digest(value.value)})
    if not choices or len(choices) > 4:
        return None
    lines = code.encode('utf-8').splitlines(keepends=True)
    start = sum(map(len, lines[:old.lineno - 1])) + old.col_offset
    end = sum(map(len, lines[:old.end_lineno - 1])) + old.end_col_offset
    literal = code.encode('utf-8')[start:end].decode('utf-8')
    result = {'version': VERSION, 'status': 'eligible', 'target': target,
              'targetSourceHash': digest(source), 'testHash': digest(code),
              'method': owner.name + '.' + method.name, 'methodSource': ast.get_source_segment(code, method),
              'argumentId': 'argument-1', 'startByte': start, 'endByte': end,
              'oldLiteralHash': digest(literal), 'choices': choices,
              'assertionOracle': False, 'patchAuthorization': False}
    result['planHash'] = digest(json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False))
    return result


def apply_plan(payload, result):
    version = result['version']
    directive = payload.get('directive')
    if (payload.get('operation') != 'apply' or payload.get('planHash') != result['planHash']
            or not isinstance(directive, str)):
        return {'version': version, 'status': 'rejected'}
    slot = result.get('argumentId') or result.get('receiverId') or result.get('importId')
    pattern = (r'INSERT ' + re.escape(slot) + r' FROM (source-[1-4])' if result.get('editKind') == 'insert-import'
               else r'REPLACE ' + re.escape(slot) + r' WITH (source-[1-4])')
    match = re.fullmatch(pattern, directive.strip())
    choice = next((item for item in result['choices'] if match and item['id'] == match[1]), None)
    if choice is None:
        return {'version': version, 'status': 'rejected'}
    raw = payload['code'].encode('utf-8')
    candidate = (raw[:result['startByte']] + choice['source'].encode('utf-8') + raw[result['endByte']:]).decode('utf-8')
    return {'version': version, 'status': 'applied', 'planHash': result['planHash'],
            'previousTestHash': result['testHash'], 'targetSourceHash': result['targetSourceHash'],
            'choiceId': choice['id'], 'code': candidate, 'candidateHash': digest(candidate)}


def handle(payload):
    result = plan(payload)
    if result is None:
        return {'version': VERSION, 'status': 'unsupported'}
    return result if payload.get('operation', 'plan') == 'plan' else apply_plan(payload, result)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(3 * LIMIT + 1)
        if len(raw) > 3 * LIMIT:
            raise ValueError('limit')
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError('shape')
        # -I deliberately ignores caller Python-path/encoding overrides. Keep
        # transport ASCII-safe so Windows console encodings cannot alter code.
        print(json.dumps(handle(payload), ensure_ascii=True))
    except (ValueError, TypeError, RecursionError, KeyError, UnicodeError):
        print(json.dumps({'version': VERSION, 'status': 'invalid'}))
