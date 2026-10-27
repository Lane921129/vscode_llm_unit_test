"""Source-bound AST method composition. Never imports or executes submitted code."""
import ast
import copy
import hashlib
import json
import sys
import textwrap

from merge_test_snippets import case_bases, test_class


PLAN_VERSION = 'writer-method-edit-plan-v1'
RESULT_VERSION = 'writer-method-edit-result-v1'
LIMIT = 1024 * 1024
METHOD = (ast.FunctionDef, ast.AsyncFunctionDef)


class EditError(Exception):
    pass


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def parse(source):
    if not isinstance(source, str) or not source.strip() or len(source.encode('utf-8')) > LIMIT:
        raise EditError('edit-input-limit')
    tree = ast.parse(source)
    if sum(1 for _ in ast.walk(tree)) > 20000:
        raise EditError('edit-ast-limit')
    return tree


def locate(tree):
    bases, _ = case_bases(tree)
    classes, methods = {}, {}
    bindings = set()
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, *METHOD)):
            if node.name in bindings:
                raise EditError('ambiguous-edit-baseline')
            bindings.add(node.name)
        if not test_class(node, bases):
            continue
        classes[node.name] = node
        local = set()
        assigned = {name.id for part in node.body if isinstance(part, (ast.Assign, ast.AnnAssign))
                    for target in (part.targets if isinstance(part, ast.Assign) else [part.target])
                    for name in ast.walk(target) if isinstance(name, ast.Name)}
        for method in node.body:
            if not isinstance(method, METHOD):
                continue
            if method.name in local or method.name in assigned:
                raise EditError('ambiguous-edit-baseline')
            local.add(method.name)
            if method.name.startswith('test_'):
                if method.lineno == node.lineno:
                    raise EditError('unsupported-edit-layout')
                methods[node.name + '.' + method.name] = method
    if not methods or len(methods) > 256:
        raise EditError('unsupported-edit-baseline')
    return classes, methods


def header(node):
    value = copy.deepcopy(node)
    value.body = []
    return ast.dump(value, include_attributes=False)


def make_plan(baseline, line_refs):
    tree = parse(baseline)
    _, methods = locate(tree)
    if (not isinstance(line_refs, list) or not 1 <= len(line_refs) <= 32
            or any(type(line) is not int or line < 1 for line in line_refs)):
        raise EditError('invalid-edit-lines')
    selected = {}
    for line in line_refs:
        matches = [(identity, method) for identity, method in methods.items()
                   if min([method.lineno] + [item.lineno for item in method.decorator_list]) <= line <= method.end_lineno]
        if len(matches) != 1:
            raise EditError('edit-line-outside-method')
        selected[matches[0][0]] = matches[0][1]
    lines = baseline.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line.encode('utf-8')))
    packet = []
    for identity, method in sorted(selected.items(), key=lambda item: item[1].lineno):
        start = min([method.lineno] + [item.lineno for item in method.decorator_list])
        class_name, name = identity.split('.')
        packet.append({'id': identity, 'className': class_name, 'name': name, 'line': start,
                       'endLine': method.end_lineno, 'startByte': offsets[start - 1],
                       'endByte': offsets[method.end_lineno], 'code': ''.join(lines[start - 1:method.end_lineno])})
    baseline_hash = digest(baseline)
    plan_hash = digest(PLAN_VERSION + '\0' + baseline_hash + '\0' + '\0'.join(item['id'] for item in packet))
    return {'schemaVersion': PLAN_VERSION, 'ok': True, 'baselineHash': baseline_hash,
            'planHash': plan_hash, 'methods': packet}


def plan(baseline, line_refs):
    return guarded(PLAN_VERSION, lambda: make_plan(baseline, line_refs))


def compose(baseline, line_refs, baseline_hash, plan_hash, replacement):
    current = make_plan(baseline, line_refs)
    if current['baselineHash'] != baseline_hash or current['planHash'] != plan_hash:
        raise EditError('stale-edit-plan')
    base_tree = parse(baseline)
    classes, old_methods = locate(base_tree)
    try:
        replacement_tree = parse(replacement)
    except IndentationError:
        # A wrapper preserves multiline string values; text dedenting does not.
        wrapped = parse('if True:\n' + replacement)
        if len(wrapped.body) != 1 or not isinstance(wrapped.body[0], ast.If):
            raise EditError('unsupported-edit-response')
        replacement_tree = ast.Module(body=wrapped.body[0].body, type_ignores=[])
    expected = {item['id'] for item in current['methods']}
    owners = {item['className'] for item in current['methods']}
    found = {}
    for node in replacement_tree.body:
        if isinstance(node, ast.ClassDef):
            if (node.name not in owners or node.decorator_list or node.keywords or getattr(node, 'type_params', [])
                    or node.bases and [ast.dump(item) for item in node.bases] != [ast.dump(item) for item in classes[node.name].bases]):
                raise EditError('edit-class-wrapper-conflict')
            owner, candidates = node.name, node.body
        elif isinstance(node, METHOD) and len(owners) == 1:
            owner, candidates = next(iter(owners)), [node]
        else:
            raise EditError('unsupported-edit-response')
        for method in candidates:
            if not isinstance(method, METHOD):
                raise EditError('unsupported-edit-response')
            identity = owner + '.' + method.name
            if identity not in expected:
                raise EditError('method-outside-edit-scope')
            if identity in found:
                raise EditError('duplicate-edit-method')
            if header(method) != header(old_methods[identity]):
                raise EditError('edit-signature-changed')
            found[identity] = method
    if set(found) != expected:
        raise EditError('edit-method-missing')
    changed = [item['id'] for item in current['methods']
               if ast.dump(found[item['id']]) != ast.dump(old_methods[item['id']])]
    if not changed:
        raise EditError('edit-no-method-change')
    lines = baseline.splitlines(keepends=True)
    newline = '\r\n' if '\r\n' in baseline else '\n'
    edits = []
    for item in current['methods']:
        original = old_methods[item['id']]
        indent = lines[original.lineno - 1][:original.col_offset]
        rendered = textwrap.indent(ast.unparse(found[item['id']]), indent).replace('\n', newline)
        if item['code'].endswith(('\n', '\r')):
            rendered += newline
        edits.append({'id': item['id'], 'startByte': item['startByte'], 'endByte': item['endByte'], 'replacement': rendered})
    merged = baseline.encode('utf-8')
    for edit in reversed(edits):
        merged = merged[:edit['startByte']] + edit['replacement'].encode('utf-8') + merged[edit['endByte']:]
    merged = merged.decode('utf-8')
    merged_tree = parse(merged)
    _, merged_methods = locate(merged_tree)
    for identity in expected:
        old_methods[identity].body = []
        merged_methods[identity].body = []
    if ast.dump(base_tree) != ast.dump(merged_tree):
        raise EditError('edit-escaped-method-scope')
    return {'schemaVersion': RESULT_VERSION, 'ok': True, 'baselineHash': baseline_hash, 'planHash': plan_hash,
            'mergedCode': merged, 'mergedHash': digest(merged), 'edits': edits, 'changedMethodIds': changed}


def apply(baseline, line_refs, baseline_hash, plan_hash, replacement):
    return guarded(RESULT_VERSION, lambda: compose(baseline, line_refs, baseline_hash, plan_hash, replacement))


def guarded(version, operation):
    try:
        return operation()
    except EditError as error:
        reason = str(error)
    except (SyntaxError, ValueError, TypeError, RecursionError, MemoryError, UnicodeError):
        reason = 'invalid-edit-python'
    return {'schemaVersion': version, 'ok': False, 'reasonCode': reason}


def main():
    raw = sys.stdin.buffer.read(5 * LIMIT + 1)
    try:
        if len(raw) > 5 * LIMIT:
            raise EditError('edit-input-limit')
        request = json.loads(raw.decode('utf-8'))
        if not isinstance(request, dict):
            raise EditError('invalid-edit-request')
        if request.get('mode') == 'plan' and set(request) == {'mode', 'baseline', 'lineRefs'}:
            return plan(request['baseline'], request['lineRefs'])
        if request.get('mode') == 'apply' and set(request) == {'mode', 'baseline', 'lineRefs', 'baselineHash', 'planHash', 'replacement'}:
            return apply(request['baseline'], request['lineRefs'], request['baselineHash'], request['planHash'], request['replacement'])
        raise EditError('invalid-edit-request')
    except EditError as error:
        reason = str(error)
    except (ValueError, UnicodeError, RecursionError):
        reason = 'invalid-edit-request'
    return {'schemaVersion': RESULT_VERSION, 'ok': False, 'reasonCode': reason}


if __name__ == '__main__':
    print(json.dumps(main(), ensure_ascii=True))
