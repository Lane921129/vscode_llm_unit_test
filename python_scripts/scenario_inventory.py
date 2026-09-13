"""Static scenario identities; no generated code is executed by this reader."""
import ast
import copy
import hashlib
import json
import sys


def inventory(code):
    tree = ast.parse(code)
    # Include module setup and class fixtures, so a renamed test with a changed
    # mock/constructor cannot masquerade as the old verified scenario.
    module_setup = [node for node in tree.body if not isinstance(node, ast.ClassDef)
                    and not (isinstance(node, ast.If) and ast.dump(node.test) == ast.dump(ast.parse("__name__ == '__main__'", mode='eval').body))]
    result = []
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef):
            continue
        tests = [node for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name.startswith('test_')]
        fixtures = [node for node in cls.body if node not in tests]
        for method in tests:
            normalized = copy.deepcopy(method)
            normalized.name = 'test_scenario'
            # Docstrings have no assertion semantics.
            if normalized.body and isinstance(normalized.body[0], ast.Expr) and isinstance(normalized.body[0].value, ast.Constant) and isinstance(normalized.body[0].value.value, str):
                normalized.body = normalized.body[1:]
            nodes = module_setup + cls.bases + cls.decorator_list + fixtures + [normalized]
            digest = hashlib.sha256('\n'.join(ast.dump(node, include_attributes=False) for node in nodes).encode()).hexdigest()
            result.append({'id': f'{cls.name}.{method.name}', 'fingerprint': digest})
    return result


if __name__ == '__main__':
    print(json.dumps(inventory(sys.stdin.read())))
