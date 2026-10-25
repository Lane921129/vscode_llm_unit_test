"""Plan a scoped immutable-clock patch repair without importing the application."""
import ast
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from source_literal_argument_repair import LIMIT, digest, scope_nodes, target_method_context
from mock_behavior import ASSERTIONS, dotted, imports, possible_test_origins, source_namespace_use_points
from validate_test_bindings import _proven_immutable_datetime_bindings, validate_bindings

VERSION = 'source-mock-setup-repair-v1'
MOCK_MEMBERS = set(ASSERTIONS) | {'return_value', 'side_effect', 'called', 'call_count',
                               'call_args', 'call_args_list', 'mock_calls', 'reset_mock'}
REFLECTION = {'setattr', 'delattr', 'getattr', 'globals', 'locals', 'vars', 'eval', 'exec', '__import__', 'reload'}


def plan(payload):
    source, code, failure, target = (payload.get(key) for key in ('source', 'code', 'failure', 'target'))
    module, module_source, module_hash = (payload.get(key) for key in ('module', 'moduleSource', 'moduleSourceHash'))
    if (not isinstance(failure, str) or not failure.startswith('Do not patch immutable datetime/date attribute ')
            or not isinstance(code, str) or len(code.encode('utf-8')) > LIMIT
            or not isinstance(module, str) or not all(part.isidentifier() for part in module.split('.'))
            or not isinstance(module_source, str) or len(module_source.encode('utf-8')) > 1024 * 1024
            or digest(module_source) != module_hash):
        return None
    try:
        test_tree, module_tree = ast.parse(code), ast.parse(module_source)
    except (SyntaxError, ValueError, RecursionError):
        return None
    if sum(1 for _ in ast.walk(module_tree)) > 50000:
        return None
    methods = [node for owner in test_tree.body if isinstance(owner, ast.ClassDef)
               for node in owner.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith('test_')]
    if len(methods) != 1:
        return None
    context = target_method_context(payload, methods[0].name)
    if context is None:
        return None
    _, _, _, _, function, owner, method, test_tree = context
    if (not isinstance(function, ast.FunctionDef) or function.decorator_list or method.decorator_list
            or not isinstance(method, ast.FunctionDef) or owner.decorator_list):
        return None
    facts = {'module': module, 'target': target, 'source': source, 'moduleSource': module_source}
    # Reproduce the current checker verdict; failure text alone grants nothing.
    if validate_bindings(code, facts).get('reason') != failure:
        return None
    immutable = _proven_immutable_datetime_bindings(module_tree, function, facts)
    namespaces = source_namespace_use_points(facts)
    aliases = imports([*test_tree.body, *method.body])

    def resolve(node):
        root, sep, tail = dotted(node).partition('.')
        return aliases.get(root, '') + ('.' + tail if sep else '')

    if len(owner.bases) != 1 or resolve(owner.bases[0]) != 'unittest.TestCase':
        return None

    nodes = [part for statement in method.body for part in scope_nodes(statement)]
    if any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda,
                             ast.Global, ast.Nonlocal, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp))
           for node in nodes):
        return None
    candidates = []
    for node in nodes:
        if not isinstance(node, ast.With):
            continue
        for item in node.items:
            call, alias = item.context_expr, item.optional_vars
            if (not isinstance(call, ast.Call) or resolve(call.func) != 'unittest.mock.patch'
                    or len(call.args) != 1 or call.keywords or not isinstance(call.args[0], ast.Constant)
                    or not isinstance(call.args[0].value, str) or not isinstance(alias, ast.Name)):
                continue
            for binding in immutable:
                point = module + '.' + binding
                members = namespaces.get(point, set())
                if len(members) != 1:
                    continue
                member = next(iter(members))
                if (not member.isidentifier() or call.args[0].value != point + '.' + member
                        or not failure.startswith('Do not patch immutable datetime/date attribute ' + call.args[0].value + ' ')):
                    continue
                # A namespace replacement must not also change a constructor,
                # another class member or a callback in this selected target.
                parents = {child: parent for parent in ast.walk(function) for child in ast.iter_child_nodes(parent)}
                reads = [part for statement in function.body for part in scope_nodes(statement)
                         if isinstance(part, ast.Name) and isinstance(part.ctx, ast.Load) and part.id == binding]
                if not reads or any(not isinstance(parents.get(part), ast.Attribute)
                    or parents[part].attr != member or not isinstance(parents.get(parents[part]), ast.Call)
                    or parents[parents[part]].func is not parents[part] for part in reads):
                    continue
                candidates.append((node, alias, call.args[0], point, member))
    if len(candidates) != 1:
        return None
    selected, alias, old_path, point, member = candidates[0]
    selected_call = next(item.context_expr for item in selected.items if isinstance(item.context_expr, ast.Call)
                         and item.context_expr.args and item.context_expr.args[0] is old_path)
    # Revoke the source identity when this test also mutates/replaces it.
    origins = possible_test_origins(test_tree)
    for name in REFLECTION:
        origins.setdefault(name, set()).add(name)
    for _ in range(16):
        changed = False
        for node in ast.walk(test_tree):
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            root, sep, tail = dotted(node.value).partition('.')
            values = {origin + ('.' + tail if sep else '') for origin in origins.get(root, ())}
            for item in node.targets if isinstance(node, ast.Assign) else [node.target]:
                if isinstance(item, ast.Name):
                    previous = origins.setdefault(item.id, set())
                    before = len(previous)
                    previous.update(values)
                    changed = changed or len(previous) != before
        if sum(map(len, origins.values())) > 1024:
            return None
        if not changed:
            break
    else:
        return None

    def possible(node):
        root, sep, tail = dotted(node).partition('.')
        return {origin + ('.' + tail if sep else '') for origin in origins.get(root, {root})}

    source_origin = immutable[point[len(module) + 1:]]
    for node in ast.walk(test_tree):
        writes = set()
        if isinstance(node, ast.Attribute) and node.attr in ('__dict__', '__class__', '__getattribute__', '__setattr__'):
            return None
        if isinstance(node, ast.Attribute) and 'sys.modules' in possible(node):
            return None
        if isinstance(node, (ast.Name, ast.Attribute)) and isinstance(node.ctx, (ast.Store, ast.Del)):
            writes = possible(node)
        elif isinstance(node, ast.Call):
            factories = possible(node.func)
            if any(value.rsplit('.', 1)[-1] in REFLECTION for value in factories):
                return None
            if 'unittest.mock.patch' in factories and node is not selected_call:
                if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    writes.add(node.args[0].value)
            elif 'unittest.mock.patch.object' in factories and len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
                if isinstance(node.args[1].value, str):
                    writes.update(value + '.' + node.args[1].value for value in possible(node.args[0]))
        if any(value == origin or value.startswith(origin + '.')
               for value in writes for origin in (point, source_origin)):
            return None
    stores = [node for node in nodes if isinstance(node, ast.Name) and node.id == alias.id
              and isinstance(node.ctx, (ast.Store, ast.Del))]
    if len(stores) != 1 or stores[0] is not alias:
        return None
    # Imports, exception bindings and patterns can rebind without Name(Store).
    if any(isinstance(node, (ast.Import, ast.ImportFrom))
           and any((a.asname or (a.name.split('.')[0] if isinstance(node, ast.Import) else a.name)) == alias.id for a in node.names)
           or isinstance(node, ast.ExceptHandler) and node.name == alias.id
           or isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name == alias.id
           or isinstance(node, ast.MatchMapping) and node.rest == alias.id for node in nodes):
        return None
    body = {part for statement in selected.body for part in ast.walk(statement)}
    parents = {child: parent for parent in ast.walk(method) for child in ast.iter_child_nodes(parent)}
    uses = [node for node in nodes if isinstance(node, ast.Name) and node.id == alias.id and isinstance(node.ctx, ast.Load)]
    if not uses or len(uses) > 32 or any(node not in body or not isinstance(parents.get(node), ast.Attribute)
                                       or parents[node].value is not node or parents[node].attr not in MOCK_MEMBERS for node in uses):
        return None
    raw_lines = code.encode('utf-8').splitlines(keepends=True)

    def span(node):
        return (sum(map(len, raw_lines[:node.lineno - 1])) + node.col_offset,
                sum(map(len, raw_lines[:node.end_lineno - 1])) + node.end_col_offset)

    edits = [(span(old_path), repr(point))]
    edits.extend((span(node), ast.get_source_segment(code, node) + '.' + member) for node in uses)
    edits.sort()
    if any(left[0][1] > right[0][0] for left, right in zip(edits, edits[1:])):
        return None
    raw = code.encode('utf-8')
    start, end = span(selected)
    block, cursor = [], start
    for (left, right), text in edits:
        block.extend((raw[cursor:left], text.encode('utf-8')))
        cursor = right
    block.append(raw[cursor:end])
    replacement = b''.join(block).decode('utf-8')
    if len(replacement) > 16384:
        return None
    result = {'version': VERSION, 'status': 'eligible', 'target': target,
              'targetSourceHash': digest(source), 'moduleSourceHash': module_hash, 'testHash': digest(code),
              'method': owner.name + '.' + method.name, 'methodSource': ast.get_source_segment(code, method),
              'setupId': 'setup-1', 'editKind': 'replace-mock-setup', 'startByte': start, 'endByte': end,
              'oldSetupHash': digest(raw[start:end].decode('utf-8')),
              'choices': [{'id': 'source-1', 'source': replacement, 'sourceLine': function.lineno,
                           'valueHash': digest(replacement)}],
              'patchPoint': point, 'member': member, 'changes': len(edits),
              'failureBasis': 'static-binding', 'assertionOracle': False, 'patchAuthorization': False}
    result['planHash'] = digest(json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False))
    return result


def handle(payload):
    result = plan(payload)
    if result is None:
        return {'version': VERSION, 'status': 'unsupported'}
    if payload.get('operation', 'plan') == 'plan':
        return result
    # Same closed directive/hash protocol as the other source-slice tools.
    if (payload.get('operation') != 'apply' or payload.get('planHash') != result['planHash']
            or not isinstance(payload.get('directive'), str)
            or payload['directive'].strip() != 'REPLACE setup-1 WITH source-1'):
        return {'version': VERSION, 'status': 'rejected'}
    raw = payload['code'].encode('utf-8')
    candidate = (raw[:result['startByte']] + result['choices'][0]['source'].encode('utf-8') + raw[result['endByte']:]).decode('utf-8')
    return {'version': VERSION, 'status': 'applied', 'planHash': result['planHash'],
            'previousTestHash': result['testHash'], 'targetSourceHash': result['targetSourceHash'],
            'choiceId': 'source-1', 'code': candidate, 'candidateHash': digest(candidate)}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('limit')
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError('shape')
        print(json.dumps(handle(payload), ensure_ascii=True))
    except (ValueError, TypeError, RecursionError, KeyError, UnicodeError):
        print(json.dumps({'version': VERSION, 'status': 'invalid'}))
