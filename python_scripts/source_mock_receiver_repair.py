"""Source-protocol receiver choices for one real failed Mock assertion; AST only."""
import ast
import json
import os
import re
import sys

# -I excludes application and caller paths. Only extension-owned tools are added.
sys.path.insert(0, os.path.dirname(__file__))
from source_literal_argument_repair import LIMIT, apply_plan, digest, scope_nodes, target_method_context
from dependency_fixture_contract import build_dependency_fixture_contract

VERSION = 'source-mock-receiver-repair-v1'


def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.insert(0, node.attr)
        node = node.value
    return [node.id, *parts] if isinstance(node, ast.Name) else None


def module_roots(payload, function):
    source = payload.get('moduleSource')
    if source is None:
        return set(), None
    if not isinstance(source, str) or len(source.encode('utf-8')) > 1024 * 1024 or digest(source) != payload.get('moduleSourceHash'):
        return None
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError, RecursionError):
        return None
    if sum(1 for _ in ast.walk(tree)) > 50000:
        return None
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function.name]
    if len(selected) != 1 or ast.dump(selected[0]) != ast.dump(function):
        return None
    roots = set()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            roots.update(alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name)
                         for alias in node.names if alias.name != '*')
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            roots.add(node.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            roots.update(target.id for target in targets if isinstance(target, ast.Name))
    return roots, payload['moduleSourceHash']


def plan(payload):
    failure = payload.get('failure')
    static = isinstance(failure, str) and failure.startswith('Mock assertion is not proven to observe an explicit target use-point patch or a mock passed to the target.')
    if static:
        code = payload.get('code')
        if not isinstance(code, str) or len(code.encode('utf-8')) > LIMIT:
            return None
        try:
            tree = ast.parse(code)
        except (SyntaxError, ValueError, RecursionError):
            return None
        methods = [node for owner in tree.body if isinstance(owner, ast.ClassDef)
                   for node in owner.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith('test_')]
        if len(methods) != 1:
            return None
        context = target_method_context(payload, methods[0].name)
    else:
        context = target_method_context(payload)
    module = payload.get('module')
    if context is None or not isinstance(module, str) or not all(part.isidentifier() for part in module.split('.')):
        return None
    source, code, failure, target, function, owner, method, test_tree = context
    globals_proof = module_roots(payload, function)
    if globals_proof is None:
        return None
    names = set(re.findall(r"^AssertionError: Expected '([A-Za-z_]\w{0,79})' to (?:be called once|have been called once)\. Called 0 times\.\r?$",
                           failure, re.M))
    nodes = [part for statement in method.body for part in scope_nodes(statement)]
    assertions = [node for node in nodes if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                  and node.func.attr in ('assert_called', 'assert_called_once', 'assert_called_with', 'assert_called_once_with')
                  and isinstance(node.func.value, ast.Attribute)
                  and dotted(node.func.value)]
    if static:
        if len(assertions) > 32:
            return None
        plans = [result for assertion in assertions
                 if (result := plan_receiver(context, module, assertion, 'static-binding', globals_proof)) is not None]
        # Do not select a first ambiguous assertion or a first test method.
        return plans[0] if len(plans) == 1 else None
    if len(names) == 1:
        failed_name = next(iter(names))
        assertions = [node for node in assertions if node.func.value.attr == failed_name]
    elif not names:
        # Only a native test-frame line that exactly matches this candidate may
        # locate a broken receiver. AttributeError inside the target/setup does
        # not authorize repairing an unrelated assertion.
        missing = re.findall(r"^AttributeError: '[^'\r\n]+' object has no attribute '([A-Za-z_]\w{0,79})'\r?$", failure, re.M)
        frames = re.findall(r'^  File "[^"\r\n]+", line (\d+), in ' + re.escape(method.name)
                            + r'\r?\n    ([^\r\n]+)', failure, re.M)
        if len(missing) != 1 or len(frames) != 1 or failure.count('Traceback (most recent call last):') != 1:
            return None
        line, spelling = int(frames[0][0]), frames[0][1]
        lines = code.splitlines()
        if line < 1 or line > len(lines) or lines[line - 1].strip() != spelling.strip():
            return None
        assertions = [node for node in assertions if node.lineno == node.end_lineno == line
                      and ast.get_source_segment(code, node) == spelling.strip()
                      and missing[0] in dotted(node.func.value)[1:-1]]
        if len(assertions) != 1:
            return None
        failed_name = assertions[0].func.value.attr
    else:
        return None
    if failed_name.startswith('__'):
        return None
    if len(assertions) != 1:
        return None
    return plan_receiver(context, module, assertions[0], 'native-failure', globals_proof)


def plan_receiver(context, module, assertion, basis, globals_proof):
    source, code, failure, target, function, owner, method, test_tree = context
    old = assertion.func.value
    failed_name = old.attr
    if failed_name.startswith('__'):
        return None
    old_path = dotted(old)
    nodes = [part for statement in method.body for part in scope_nodes(statement)]
    imports = [node for node in [*test_tree.body, *method.body] if isinstance(node, ast.ImportFrom)
               and node.module == 'unittest.mock' and node.level == 0]
    patch_names = {alias.asname or alias.name for node in imports for alias in node.names if alias.name == 'patch'}
    mock_names = {alias.asname or alias.name for node in imports for alias in node.names
                  if alias.name in ('Mock', 'MagicMock', 'AsyncMock')}
    changed_names = {node.id for node in [*nodes, *(child for statement in test_tree.body for child in scope_nodes(statement))]
                     if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del))}
    changed_names.update(node.name for node in [*test_tree.body, *nodes]
                         if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)))
    imported_names = [node for node in [*test_tree.body, *method.body] if isinstance(node, (ast.Import, ast.ImportFrom))]
    conflicts = {alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name)
                 for node in imported_names for alias in node.names
                 if not isinstance(node, ast.ImportFrom) or node.level != 0 or node.module != 'unittest.mock'}
    patch_names.difference_update(conflicts)
    mock_names.difference_update(conflicts)
    patch_names.difference_update(changed_names)
    mock_names.difference_update(changed_names)
    target_aliases = {alias.asname or alias.name for node in [*test_tree.body, *method.body]
                      if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module == module
                      for alias in node.names if alias.name == target}
    target_aliases.difference_update(changed_names)
    mappings = []
    for node in nodes:
        if not isinstance(node, ast.With):
            continue
        for item in node.items:
            call, alias = item.context_expr, item.optional_vars
            if (not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id not in patch_names
                    or len(call.args) != 1 or call.keywords or not isinstance(call.args[0], ast.Constant)
                    or not isinstance(call.args[0].value, str) or not isinstance(alias, ast.Name)
                    or not call.args[0].value.startswith(module + '.')):
                continue
            root = call.args[0].value[len(module) + 1:]
            stores = [part for part in nodes if isinstance(part, ast.Name) and isinstance(part.ctx, (ast.Store, ast.Del))
                      and part.id == alias.id]
            if not root.isidentifier() or root == target or len(stores) != 1:
                continue
            if alias.id == old_path[0]:
                mappings.append((root, alias.id, 0))
                continue
            # A separately constructed standard Mock may be the patched
            # factory's return value. Preserve that actual object identity.
            body_nodes = [part for statement in node.body for part in scope_nodes(statement)]
            calls = [part for part in body_nodes if isinstance(part, ast.Call) and isinstance(part.func, ast.Name)
                     and part.func.id in target_aliases]
            links = [part for part in body_nodes if isinstance(part, ast.Assign) and len(part.targets) == 1
                     and dotted(part.targets[0]) == [alias.id, 'return_value']]
            constructors = [part for part in body_nodes if isinstance(part, ast.Assign) and len(part.targets) == 1
                            and isinstance(part.targets[0], ast.Name) and part.targets[0].id == old_path[0]
                            and isinstance(part.value, ast.Call) and isinstance(part.value.func, ast.Name)
                            and part.value.func.id in mock_names]
            object_stores = [part for part in nodes if isinstance(part, ast.Name)
                             and isinstance(part.ctx, (ast.Store, ast.Del)) and part.id == old_path[0]]
            if (len(calls) == len(links) == len(constructors) == len(object_stores) == 1
                    and isinstance(links[0].value, ast.Name) and links[0].value.id == old_path[0]
                    and constructors[0].lineno < links[0].lineno < calls[0].lineno < assertion.lineno <= node.end_lineno):
                mappings.append((root, old_path[0], 1))
    if len(mappings) != 1:
        return None
    root, alias, consumed = mappings[0]
    contract = build_dependency_fixture_contract(function, source, target, {root, *globals_proof[0]})
    if (contract['status'] != 'complete' or contract['assertionOracle'] is not False
            or contract['patchAuthorization'] is not False):
        return None
    choices, seen = [], set()
    for flow in contract['flows']:
        if flow['root'] != {'kind': 'use-point', 'name': root} or flow['method'] != failed_name:
            continue
        steps = flow['steps']
        if consumed and (not steps or steps[0]['kind'] != 'return_value'):
            continue
        parts = [alias]
        for step in steps[consumed:]:
            if step['kind'] == 'return_value':
                parts.append('return_value')
            elif step['kind'] == 'context-enter':
                parts.extend(('__enter__', 'return_value'))
            elif step['kind'] == 'member' and step['name'].isidentifier() and not step['name'].startswith('__'):
                parts.append(step['name'])
            else:
                break
        else:
            expression = '.'.join([*parts, failed_name])
            if expression != '.'.join(old_path) and expression not in seen:
                seen.add(expression)
                choices.append({'id': 'source-' + str(len(choices) + 1), 'source': expression,
                                'sourceLine': flow['line'], 'valueHash': digest(expression)})
    if not choices or len(choices) > 4:
        return None
    lines = code.encode('utf-8').splitlines(keepends=True)
    start = sum(map(len, lines[:old.lineno - 1])) + old.col_offset
    end = sum(map(len, lines[:old.end_lineno - 1])) + old.end_col_offset
    original = code.encode('utf-8')[start:end].decode('utf-8')
    result = {'version': VERSION, 'status': 'eligible', 'target': target,
              'targetSourceHash': digest(source), 'testHash': digest(code),
              'method': owner.name + '.' + method.name, 'methodSource': ast.get_source_segment(code, method),
              'receiverId': 'receiver-1', 'startByte': start, 'endByte': end,
              'oldReceiverHash': digest(original), 'choices': choices,
              'assertionOracle': False, 'patchAuthorization': False, 'failureBasis': basis,
              **({'moduleSourceHash': globals_proof[1]} if globals_proof[1] else {})}
    result['planHash'] = digest(json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False))
    return result


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(3 * LIMIT + 1)
        if len(raw) > 3 * LIMIT:
            raise ValueError('limit')
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError('shape')
        result = plan(payload)
        value = ({'version': VERSION, 'status': 'unsupported'} if result is None else result
                 if payload.get('operation', 'plan') == 'plan' else apply_plan(payload, result))
        print(json.dumps(value, ensure_ascii=True))
    except (ValueError, TypeError, RecursionError, KeyError, UnicodeError):
        print(json.dumps({'version': VERSION, 'status': 'invalid'}))
