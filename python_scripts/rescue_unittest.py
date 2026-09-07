"""Parse bare assertions without executing model output.

Only straight-line setup is rescued. Definitions and control flow are rejected
instead of flattening their scopes. The caller must still validate the result.
"""
import ast
import json
import re
import sys


def rescue_unittest(code, module):
    if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", module):
        return ""
    code = "\n".join(re.sub(r"^(>>>|\.\.\.) ?", "", line) for line in code.splitlines())
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return ""
    body = []
    assertions = 0
    for statement in tree.body:
        if isinstance(statement, ast.Assert):
            # Keep the entire condition, including chained comparisons and
            # short-circuit boolean expressions, as one assertion argument.
            # Dynamic messages are declined: unittest eagerly evaluates msg,
            # whereas Python assert evaluates it only when the condition fails.
            if statement.msg is not None:
                try:
                    ast.literal_eval(statement.msg)
                except (ValueError, TypeError, SyntaxError):
                    return ""
            args = [statement.test]
            if statement.msg is not None:
                args.append(statement.msg)
            body.append(ast.Expr(value=ast.Call(
                func=ast.Attribute(value=ast.Name(id="self", ctx=ast.Load()),
                                   attr="assertTrue", ctx=ast.Load()),
                args=args, keywords=[])))
            assertions += 1
        elif isinstance(statement, (ast.Assign, ast.AnnAssign, ast.Import, ast.ImportFrom)):
            body.append(statement)
        else:
            return ""
    if not assertions:
        return ""
    rendered = "\n".join(ast.unparse(ast.fix_missing_locations(item)) for item in body)
    return (f"import unittest\nfrom {module} import *\n\n"
            "class TestAuto(unittest.TestCase):\n"
            "    def test_rescued_assertions(self):\n"
            + "\n".join("        " + line for line in rendered.splitlines()) + "\n")


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    print(json.dumps({"code": rescue_unittest(payload["code"], payload["module"])}))
