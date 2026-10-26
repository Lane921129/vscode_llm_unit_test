"""Offer a source-bound parameter Mock adapter; preserve AI-authored values/assertions."""
import ast
import json
import io
import os
import sys
import tokenize

sys.path.insert(0, os.path.dirname(__file__))
from source_literal_argument_repair import LIMIT, digest, target_method_context
from source_mock_setup_repair import MOCK_MEMBERS, REFLECTION
from mock_behavior import ASSERTIONS, dotted, imports
from validate_test_bindings import validate_bindings

VERSION = 'source-parameter-mock-repair-v1'


def plan(payload):
    source, code, failure, target, module, full, full_hash = (
        payload.get(key) for key in ('source', 'code', 'failure', 'target', 'module', 'moduleSource', 'moduleSourceHash'))
    if (not isinstance(failure, str) or not failure.startswith('Do not patch ')
            or not isinstance(code, str) or len(code.encode('utf-8')) > LIMIT
            or not isinstance(module, str) or not all(part.isidentifier() for part in module.split('.'))
            or not isinstance(full, str) or len(full.encode('utf-8')) > 1024 * 1024 or digest(full) != full_hash):
        return None
    try:
        tree, module_tree = ast.parse(code), ast.parse(full)
    except (SyntaxError, ValueError, RecursionError):
        return None
    if sum(1 for _ in ast.walk(module_tree)) > 50000:
        return None
    methods = [n for cls in tree.body if isinstance(cls, ast.ClassDef) for n in cls.body
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith('test_')]
    context = target_method_context(payload, methods[0].name) if len(methods) == 1 else None
    if context is None:
        return None
    _, _, _, _, function, owner, method, tree = context
    selected_sources = [n for n in module_tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == target]
    if (len(selected_sources) != 1 or ast.dump(selected_sources[0]) != ast.dump(function)
            or not isinstance(function, ast.FunctionDef) or function.decorator_list
            or not isinstance(method, ast.FunctionDef) or method.decorator_list or owner.decorator_list
            or any(not isinstance(n, (ast.FunctionDef, ast.Pass)) and not (
                isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)) for n in owner.body)
            or any(isinstance(n, ast.FunctionDef) and n is not method for n in owner.body)):
        return None
    facts = {'module': module, 'target': target, 'source': source, 'moduleSource': full}
    if validate_bindings(code, facts).get('reason') != failure:
        return None
    aliases = imports([*tree.body, *method.body])

    def resolve(node):
        root, sep, tail = dotted(node).partition('.')
        return aliases.get(root, '') + ('.' + tail if sep else '')

    if len(owner.bases) != 1 or resolve(owner.bases[0]) != 'unittest.TestCase':
        return None
    # Only straight-line suites and ordinary patch contexts are adapted. No setup,
    # callback, custom constructor, dynamic lookup or redefined test helper is inferred.
    allowed = (ast.Import, ast.ImportFrom, ast.ClassDef)
    if any(not isinstance(n, allowed) or isinstance(n, ast.ClassDef) and n is not owner for n in tree.body):
        return None
    for statement in ast.walk(method):
        if isinstance(statement, ast.stmt) and statement is not method and not isinstance(
                statement, (ast.With, ast.Assign, ast.AnnAssign, ast.Expr, ast.Assert, ast.Import, ast.ImportFrom, ast.Pass)):
            return None
    nodes = list(ast.walk(method))
    if any(isinstance(n, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)) for n in nodes):
        return None
    # Require one stable import for every helper/target root used in the proof.
    records = {}
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                if a.name == '*':
                    return None
                key = a.asname or (a.name.split('.')[0] if isinstance(n, ast.Import) else a.name)
                origin = a.name.split('.')[0] if isinstance(n, ast.Import) and not a.asname else (
                    a.name if isinstance(n, ast.Import) else ('.' * n.level) + (n.module or '') + '.' + a.name)
                records.setdefault(key, set()).add(origin)
        if isinstance(n, ast.Attribute) and n.attr.startswith('__'):
            return None
        if isinstance(n, ast.Call) and dotted(n.func).split('.')[-1] in REFLECTION:
            return None
    params = [arg.arg for arg in [*function.args.posonlyargs, *function.args.args]]
    params += [arg.arg for arg in function.args.kwonlyargs]
    candidates = []
    for n in nodes:
        if not isinstance(n, ast.With) or len(n.items) != 1:
            continue
        item = n.items[0]
        call, alias = item.context_expr, item.optional_vars
        if (not isinstance(call, ast.Call) or resolve(call.func) != 'unittest.mock.patch'
                or not isinstance(call.func, ast.Attribute) or len(call.args) != 1 or call.keywords
                or not isinstance(call.args[0], ast.Constant) or not isinstance(call.args[0].value, str)
                or not isinstance(alias, ast.Name)):
            continue
        path = call.args[0].value
        rest = path[len(module) + 1:] if path.startswith(module + '.') else ''
        parts = rest.split('.')
        if len(parts) != 2 or parts[0] not in params or not parts[1].isidentifier():
            continue
        parameter, member = parts
        if not failure.startswith(f'Do not patch {path}: {parameter} is a parameter of {target}, '):
            continue
        source_reads = [x for x in ast.walk(function) if isinstance(x, ast.Attribute)
                        and dotted(x) == parameter + '.' + member]
        if not source_reads or any(isinstance(x, ast.Name) and x.id == parameter
                                   and isinstance(x.ctx, (ast.Store, ast.Del)) for x in ast.walk(function)):
            continue
        target_calls = [x for x in nodes if isinstance(x, ast.Call) and resolve(x.func) == module + '.' + target]
        if len(target_calls) != 1:
            continue
        invocation = target_calls[0]
        positional = [arg.arg for arg in [*function.args.posonlyargs, *function.args.args]]
        if any(isinstance(x, ast.Starred) for x in invocation.args) or any(k.arg is None for k in invocation.keywords):
            continue
        supplied = [invocation.args[positional.index(parameter)]] if parameter in positional and len(invocation.args) > positional.index(parameter) else []
        supplied += [k.value for k in invocation.keywords if k.arg == parameter]
        if len(supplied) != 1 or not isinstance(supplied[0], ast.Name) or supplied[0].id != alias.id:
            continue
        candidates.append((n, call, alias, parameter, member, supplied[0], invocation))
    if len(candidates) != 1:
        return None
    selected, factory, alias, parameter, member, argument, invocation = candidates[0]
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    body = set(ast.walk(selected))
    if invocation not in body:
        return None
    roots = {dotted(factory.func).split('.')[0], dotted(invocation.func).split('.')[0], dotted(owner.bases[0]).split('.')[0]}
    for root in roots:
        if len(records.get(root, set())) != 1 or any(isinstance(n, ast.Name) and n.id == root
                and isinstance(n.ctx, (ast.Store, ast.Del)) or isinstance(n, ast.arg) and n.arg == root
                or isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == root for n in ast.walk(tree)):
            return None
        if any(isinstance(n, ast.Attribute) and dotted(n).split('.')[0] == root and isinstance(n.ctx, (ast.Store, ast.Del)) for n in ast.walk(tree)):
            return None
        if any(isinstance(n, (ast.Assign, ast.AnnAssign)) and dotted(n.value).split('.')[0] == root for n in ast.walk(tree)):
            return None
    if records.get(alias.id, 0) or alias.id in roots:
        return None
    stores = [n for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == alias.id and isinstance(n.ctx, (ast.Store, ast.Del))]
    if len(stores) != 1 or stores[0] is not alias:
        return None
    uses = [n for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == alias.id and isinstance(n.ctx, ast.Load)]
    others = [n for n in uses if n is not argument]
    if not others or len(others) > 32 or any(n not in body or not isinstance(parents.get(n), ast.Attribute)
            or parents[n].attr not in MOCK_MEMBERS for n in others):
        return None
    if not any(parents[n].attr in ASSERTIONS for n in others):
        return None
    # No new input values, expected values, call counts or assertion methods.
    # The original method Mock becomes a member of the caller-owned parameter Mock.
    raw = code.encode('utf-8')
    lines = raw.splitlines(keepends=True)

    def span(n):
        return (sum(map(len, lines[:n.lineno - 1])) + n.col_offset,
                sum(map(len, lines[:n.end_lineno - 1])) + n.end_col_offset)

    # Use the already-supported direct Mock assignment form. Dedent only Python
    # indentation tokens, never the contents/closing line of a multiline string.
    if factory.end_lineno != selected.lineno or selected.body[0].lineno <= selected.lineno:
        return None
    first = selected.body[0]
    depth = first.col_offset - selected.col_offset
    if depth < 1 or depth > 16:
        return None
    protected = set()
    try:
        for token in tokenize.generate_tokens(io.StringIO(code).readline):
            if token.type == tokenize.STRING:
                protected.update(range(token.start[0] + 1, token.end[0] + 1))
    except (tokenize.TokenError, IndentationError):
        return None
    header = lines[selected.lineno - 1]
    comments = [token.string for token in tokenize.generate_tokens(io.StringIO(header.decode('utf-8')).readline)
                if token.type == tokenize.COMMENT]
    newline = '\r\n' if header.endswith(b'\r\n') else '\n'
    expression = alias.id + ' = ' + ast.get_source_segment(code, factory.func.value) + '.MagicMock()'
    expression += (' ' + comments[0] if comments else '') + newline
    edits = [((span(selected)[0], sum(map(len, lines[:selected.lineno]))), expression)]
    for line in range(selected.lineno + 1, selected.end_lineno + 1):
        if line in protected:
            continue
        content = lines[line - 1]
        if not content.strip():
            continue
        if content[:first.col_offset] != b' ' * first.col_offset:
            if content.lstrip().startswith(b'#'):
                continue
            return None
        offset = sum(map(len, lines[:line - 1])) + selected.col_offset
        edits.append(((offset, offset + depth), ''))
    edits += [(span(n), alias.id + '.' + member) for n in others]
    if len(edits) > 256:
        return None
    edits.sort()
    if any(a[0][1] > b[0][0] for a, b in zip(edits, edits[1:])):
        return None
    start, end = span(selected)
    pieces, cursor = [], start
    for (left, right), text in edits:
        pieces.extend((raw[cursor:left], text.encode('utf-8')))
        cursor = right
    pieces.append(raw[cursor:end])
    replacement = b''.join(pieces).decode('utf-8')
    if len(replacement) > 16384:
        return None
    result = {'version': VERSION, 'status': 'eligible', 'target': target,
              'targetSourceHash': digest(source), 'moduleSourceHash': full_hash, 'testHash': digest(code),
              'method': owner.name + '.' + method.name, 'methodSource': ast.get_source_segment(code, method),
              'setupId': 'setup-1', 'editKind': 'replace-mock-setup', 'startByte': start, 'endByte': end,
              'oldSetupHash': digest(raw[start:end].decode('utf-8')),
              'choices': [{'id': 'source-1', 'source': replacement, 'sourceLine': function.lineno, 'valueHash': digest(replacement)}],
              'patchPoint': module + '.' + parameter + '.' + member, 'member': member, 'changes': len(edits),
              'failureBasis': 'static-binding', 'assertionOracle': False, 'patchAuthorization': False}
    result['planHash'] = digest(json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False))
    return result


def handle(payload):
    result = plan(payload)
    if result is None:
        return {'version': VERSION, 'status': 'unsupported'}
    if payload.get('operation', 'plan') == 'plan':
        return result
    if (payload.get('operation') != 'apply' or payload.get('planHash') != result['planHash']
            or payload.get('directive') != 'REPLACE setup-1 WITH source-1'):
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
