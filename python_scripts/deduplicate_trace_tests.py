"""Remove exact copied Trace methods only from fixture-free standard TestCases.

The runner-owned baseline remains intact. No target or generated code executes.
Changed bodies, decorators, helpers, fixtures, inheritance and async are retained.
The resulting whole test still requires all normal execution/quality gates.
"""
import ast
import copy
import json
import sys


def fingerprint(method):
    if not isinstance(method, ast.FunctionDef) or method.decorator_list:
        return None
    if method.args.defaults or method.args.kw_defaults or method.args.vararg or method.args.kwarg:
        return None
    args = method.args.posonlyargs + method.args.args
    if len(args) != 1 or args[0].arg != 'self' or method.args.kwonlyargs:
        return None
    # A method must not depend on its name, class, or another fixture/helper.
    for node in ast.walk(method):
        if isinstance(node, ast.Name) and node.id in ('__class__', 'super'):
            return None
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == 'self':
            if not node.attr.startswith('assert'):
                return None
    normalized = copy.deepcopy(method)
    normalized.name = 'test_trace_copy'
    return ast.dump(normalized, include_attributes=False)


def plain_test_class(node):
    if not isinstance(node, ast.ClassDef) or node.decorator_list or node.keywords or len(node.bases) != 1:
        return False
    if ast.dump(node.bases[0]) != ast.dump(ast.parse('unittest.TestCase', mode='eval').body):
        return False
    return all(isinstance(item, ast.FunctionDef) and item.name.startswith('test_') for item in node.body)


def deduplicate(code, target):
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return {'code': code, 'removed': 0}
    if not any(isinstance(n, ast.Import) and any(a.name == 'unittest' and a.asname is None for a in n.names) for n in tree.body):
        return {'code': code, 'removed': 0}
    prefix = 'TestVerifiedTrace_' + target
    baselines = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == prefix and plain_test_class(n)]
    if len(baselines) != 1:
        return {'code': code, 'removed': 0}
    signatures = {fingerprint(m) for m in baselines[0].body} - {None}
    edits = []
    for cls in tree.body:
        if cls is baselines[0] or not plain_test_class(cls):
            continue
        copies = [m for m in cls.body if fingerprint(m) in signatures]
        for index, method in enumerate(copies):
            # Keep an empty class syntactically valid without inserting a fake test.
            replacement = ' ' * method.col_offset + 'pass\n' if len(copies) == len(cls.body) and index == 0 else ''
            edits.append((method.lineno - 1, method.end_lineno, replacement))
    lines = code.splitlines(keepends=True)
    for start, end, replacement in sorted(edits, reverse=True):
        lines[start:end] = [replacement] if replacement else []
    return {'code': ''.join(lines), 'removed': len(edits)}


if __name__ == '__main__':
    payload = json.load(sys.stdin)
    print(json.dumps(deduplicate(payload['code'], payload['target']), ensure_ascii=True))
