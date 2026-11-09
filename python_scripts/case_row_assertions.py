"""Check that a single-row fix only touches setup, never what the test asserts.

stdin:  {"before": "<method>", "after": "<method>", "method": "test_c1",
         "callees": ["target_module.find", "instance.size"]}
stdout: {"parsed": bool, "sameName": bool, "accepted": bool, "violations": [...]}

A fix is accepted only when, compared with the host-written method:
  target-call-changed   every call to the function under test (callee and all
                        arguments) is AST-identical, in the same order;
  assertion-changed     every self.assert* call (all arguments, including the
                        first) is AST-identical, with the same count;
  mock-changed          every mock.patch* context and every mock_N configuration
                        statement is AST-identical;
  control-flow-added    no try/except, if, loop or conditional expression newly
                        encloses a target call or assertion, and no return is added.
Only surrounding code (setup lines, imports, helper values) may change.
"""
import ast
import json
import sys
import textwrap

GUARDS = (ast.Try, ast.If, ast.IfExp, ast.While, ast.For, ast.AsyncFor, ast.With, ast.AsyncWith, ast.Lambda)
try:
    GUARDS = GUARDS + (ast.TryStar,)
except AttributeError:  # Python < 3.11
    pass


def _method(source, name):
    tree = ast.parse(textwrap.dedent(source))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return node if node.name == name else None
    return None


def _parents(root):
    parents = {}
    for node in ast.walk(root):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    return parents


def _guard_path(node, parents, root):
    """Kinds of enclosing control structures; mock.patch with-blocks are part of the mock fingerprint instead."""
    kinds = []
    current = parents.get(node)
    while current is not None and current is not root:
        if isinstance(current, (ast.With, ast.AsyncWith)) and all(_is_patch(item.context_expr) for item in current.items):
            pass
        elif isinstance(current, (ast.With, ast.AsyncWith)) and all(_is_assert_call(item.context_expr) for item in current.items):
            kinds.append('assert-context')
        elif isinstance(current, GUARDS):
            kinds.append(type(current).__name__)
        current = parents.get(current)
    return kinds


def _dotted(node):
    try:
        return ast.unparse(node)
    except Exception:  # unparse of exotic nodes
        return ''


def _is_patch(node):
    name = _dotted(node.func) if isinstance(node, ast.Call) else ''
    return any(part.startswith('patch') for part in name.split('.')) and name.startswith(('mock.', 'patch', 'unittest.mock.'))


def _is_assert_call(node):
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr.startswith('assert') \
        and isinstance(node.func.value, ast.Name) and node.func.value.id == 'self'


def fingerprint(method, callees):
    parents = _parents(method)
    calls, asserts, mocks = [], [], []
    for node in ast.walk(method):
        if isinstance(node, ast.Call) and _dotted(node.func) in callees:
            calls.append((node.lineno, node.col_offset, ast.dump(node), tuple(_guard_path(node, parents, method))))
        elif _is_assert_call(node):
            asserts.append((node.lineno, node.col_offset, ast.dump(node), tuple(_guard_path(node, parents, method))))
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if _is_patch(item.context_expr):
                    mocks.append((node.lineno, ast.dump(item)))
        if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(_dotted(target).startswith('mock_') for target in targets):
                mocks.append((node.lineno, ast.dump(node)))
    order = lambda items: [item[2:] if len(item) == 4 else item[1:] for item in sorted(items)]
    returns = sum(isinstance(node, ast.Return) for node in ast.walk(method))
    return {'calls': order(calls), 'asserts': order(asserts), 'mocks': order(mocks), 'returns': returns}


def compare(request):
    callees = set(request.get('callees') or [])
    try:
        before = _method(request['before'], request['method'])
        after = _method(request['after'], request['method'])
    except (SyntaxError, ValueError):
        return {'parsed': False, 'sameName': False, 'accepted': False, 'violations': ['unparseable']}
    if before is None or after is None:
        return {'parsed': True, 'sameName': False, 'accepted': False, 'violations': ['method-renamed']}
    old, new = fingerprint(before, callees), fingerprint(after, callees)
    violations = []
    if [item[0] for item in old['calls']] != [item[0] for item in new['calls']] or not old['calls']:
        violations.append('target-call-changed')
    if [item[0] for item in old['asserts']] != [item[0] for item in new['asserts']] or not old['asserts']:
        violations.append('assertion-changed')
    if old['mocks'] != new['mocks']:
        violations.append('mock-changed')
    if new['returns'] > old['returns'] or [item[1] for item in old['calls'] + old['asserts']] != [item[1] for item in new['calls'] + new['asserts']]:
        violations.append('control-flow-added')
    return {'parsed': True, 'sameName': True, 'accepted': not violations, 'violations': violations}


def main(stdin=None, stdout=None):
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    try:
        report = compare(json.loads(stdin.read()))
    except (ValueError, KeyError, TypeError):
        report = {'parsed': False, 'sameName': False, 'accepted': False, 'violations': ['invalid-request']}
    stdout.write(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
