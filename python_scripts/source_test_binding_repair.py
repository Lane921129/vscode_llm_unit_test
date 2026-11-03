"""Propose one explicit method-local import for an AST-proven unresolved test name."""
import ast
import copy
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from source_literal_argument_repair import LIMIT, apply_plan, digest, scope_nodes, target_method_context
from validate_test_bindings import _definite_test_name_failure

VERSION = 'source-test-binding-repair-v1'
TEST_HELPERS = {name: 'unittest.mock' for name in ('Mock', 'MagicMock', 'AsyncMock', 'patch', 'call', 'ANY', 'sentinel')}
TEST_HELPERS.update(SimpleNamespace='types', IsolatedAsyncioTestCase='unittest')
FIXTURE_CONSTRUCTORS = {'datetime': {'datetime', 'date', 'time', 'timedelta'},
                        'types': {'SimpleNamespace'}, 'decimal': {'Decimal'}, 'fractions': {'Fraction'},
                        'pathlib': {'Path', 'PurePath', 'WindowsPath', 'PosixPath', 'PureWindowsPath', 'PurePosixPath'}}


def plan(payload):
    failure = payload.get('failure')
    if not isinstance(failure, str):
        return None
    matches = set(re.findall(r'Writer binding repair: (\w+) is undefined or read before its local binding in (\w+)\.', failure))
    if len(matches) != 1:
        return None
    missing, method_name = next(iter(matches))
    context = target_method_context(payload, method_name)
    module, module_source, module_hash = (payload.get(key) for key in ('module', 'moduleSource', 'moduleSourceHash'))
    if (context is None or not missing.isidentifier() or not isinstance(module, str)
            or not all(part.isidentifier() for part in module.split('.')) or not isinstance(module_source, str)
            or len(module_source.encode('utf-8')) > 1024 * 1024 or digest(module_source) != module_hash):
        return None
    source, code, _, target, function, owner, method, _ = context
    try:
        tree = ast.parse(module_source)
    except (SyntaxError, ValueError, RecursionError):
        return None
    if sum(1 for _ in ast.walk(tree)) > 50000:
        return None
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == target]
    if len(selected) != 1:
        return None
    original, supplied = copy.deepcopy(selected[0]), copy.deepcopy(function)
    original.decorator_list, supplied.decorator_list = [], []
    if ast.dump(original) != ast.dump(supplied):
        return None
    nodes = [part for statement in method.body for part in scope_nodes(statement)]
    if not any(isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id == missing for node in nodes):
        return None
    direct_call = any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == missing for node in nodes)
    unresolved, ignored = [], set()
    for _ in range(8):
        current = _definite_test_name_failure(context[-1], code, ignored)
        if current is None:
            break
        if current.get('method') != method.name or current.get('reasonCode') != 'writer-undefined-name':
            return None
        if not unresolved and current.get('name') != missing:
            return None
        unresolved.append(current['name'])
        ignored.add((current['method'], current['name']))
    if not unresolved or len(unresolved) > 7:
        return None
    # Structure rejection restores the last retained candidate. Sequential
    # single-name edits would alternate and lose the preceding import. Resolve
    # all checker-proven helpers in one explicit import when their origin agrees.
    helper_module = TEST_HELPERS.get(missing)
    joint_helpers = len(unresolved) > 1 and helper_module and all(TEST_HELPERS.get(name) == helper_module for name in unresolved)
    if len(unresolved) > 1 and not joint_helpers:
        return None
    body = method.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    if not body or body[0].lineno == method.lineno:
        return None
    raw_lines = code.encode('utf-8').splitlines(keepends=True)
    first = body[0]
    indent = raw_lines[first.lineno - 1][:first.col_offset]
    if not indent or any(char not in (9, 32) for char in indent):
        return None
    newline = '\r\n' if raw_lines[first.lineno - 1].endswith(b'\r\n') else '\n'
    offset = sum(map(len, raw_lines[:first.lineno - 1]))
    candidates = []
    for statement in tree.body:
        bindings = []
        if isinstance(statement, ast.Import):
            bindings = [(alias.asname or alias.name.split('.')[0], alias.name.split('.')[0], False) for alias in statement.names]
        elif isinstance(statement, ast.ImportFrom):
            bindings = [(alias.asname or alias.name, alias.name,
                         statement.level == 0 and alias.name in FIXTURE_CONSTRUCTORS.get(statement.module, set()))
                        for alias in statement.names if alias.name != '*']
        elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            bindings = [(item.id, item.id, False) for item in targets if isinstance(item, ast.Name)]
        elif isinstance(statement, ast.ClassDef) or isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)) and statement.name == target:
            bindings = [(statement.name, statement.name, True)]
        for bound, imported, callable_fixture in bindings:
            if missing in (bound, imported) and (not direct_call or callable_fixture):
                candidates.append((module, bound, statement.lineno, 'target-module'))
    if missing in TEST_HELPERS:
        candidates.append((TEST_HELPERS[missing], missing, None, 'stdlib-test-helper'))
    choices, seen = [], set()
    for source_module, bound, line, origin in candidates:
        if joint_helpers:
            continue
        text = 'from ' + source_module + ' import ' + bound + ((' as ' + missing) if bound != missing else '')
        try:
            parsed = ast.parse(text)
        except SyntaxError:
            continue
        if len(parsed.body) != 1 or not isinstance(parsed.body[0], ast.ImportFrom) or text in seen:
            continue
        seen.add(text)
        fragment = indent.decode('ascii') + text + newline
        choices.append({'id': 'source-' + str(len(choices) + 1), 'source': fragment,
                        'sourceLine': line, 'bindingOrigin': origin, 'valueHash': digest(fragment)})
    if joint_helpers:
        text = 'from ' + helper_module + ' import ' + ', '.join(unresolved)
        fragment = indent.decode('ascii') + text + newline
        choices.append({'id': 'source-1', 'source': fragment, 'sourceLine': None,
                        'bindingOrigin': 'stdlib-test-helper', 'valueHash': digest(fragment)})
    if not choices or len(choices) > 4:
        return None
    result = {'version': VERSION, 'status': 'eligible', 'target': target,
              'targetSourceHash': digest(source), 'moduleSourceHash': module_hash, 'testHash': digest(code),
              'method': owner.name + '.' + method.name, 'methodSource': ast.get_source_segment(code, method),
              'importId': 'import-1', 'editKind': 'insert-import', 'startByte': offset, 'endByte': offset,
              'oldImportHash': digest(''), 'choices': choices, 'missingName': missing, 'missingNames': unresolved,
              'assertionOracle': False, 'patchAuthorization': False}
    result['planHash'] = digest(json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False))
    return result


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
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
