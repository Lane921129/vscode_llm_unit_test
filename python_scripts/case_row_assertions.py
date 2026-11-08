"""Compare the asserted expectations of a test method before and after a fix.

stdin:  {"before": "<method source>", "after": "<method source>", "method": "test_c1"}
stdout: {"sameName": bool, "expectationsEqual": bool, "parsed": bool}

An expectation is every self.assert* call's expected part: all arguments after
the first for value assertions (assertEqual(result, X) -> X), and the first
argument for assertRaises/assertRaisesRegex. A fix may change setup or calls'
plumbing, never these.
"""
import ast
import json
import sys
import textwrap

RAISES = {'assertRaises', 'assertRaisesRegex', 'assertWarns', 'assertWarnsRegex'}


def expectations(source, method):
    tree = ast.parse(textwrap.dedent(source))
    functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    if len(functions) < 1 or functions[0].name != method:
        return None
    found = []
    for node in ast.walk(functions[0]):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr.startswith('assert') \
                and isinstance(node.func.value, ast.Name) and node.func.value.id == 'self':
            parts = node.args[:1] if node.func.attr in RAISES else node.args[1:]
            found.append((node.func.attr, [ast.dump(part) for part in parts]))
    found.sort()
    return found


def compare(request):
    try:
        before = expectations(request['before'], request['method'])
        after = expectations(request['after'], request['method'])
    except (SyntaxError, ValueError):
        return {'parsed': False, 'sameName': False, 'expectationsEqual': False}
    return {'parsed': True, 'sameName': before is not None and after is not None,
            'expectationsEqual': before is not None and before == after and bool(before)}


def main(stdin=None, stdout=None):
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    try:
        report = compare(json.loads(stdin.read()))
    except (ValueError, KeyError, TypeError):
        report = {'parsed': False, 'sameName': False, 'expectationsEqual': False}
    stdout.write(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
