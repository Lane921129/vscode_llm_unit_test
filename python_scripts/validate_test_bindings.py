"""Read-only AST gate for canonical target imports and unittest.mock bindings."""
import ast
import json
import sys


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        return f'{parent}.{node.attr}' if parent else ''
    return ''


def validate_bindings(code, context):
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        return {'valid': False, 'reason': f'Python syntax: {error.msg} (line {error.lineno})'}
    module = context.get('module', '')
    target = context.get('target', '')
    dependencies = context.get('dependencies', {})
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for item in node.names:
                aliases[item.asname or item.name] = item.name
                if module and item.name != module and item.name == module.rsplit('.', 1)[-1]:
                    return {'valid': False, 'reason': f'Use canonical target module {module}; do not import a second instance as {item.name}.'}
        elif isinstance(node, ast.ImportFrom):
            for item in node.names:
                aliases[item.asname or item.name] = f'{node.module}.{item.name}'
                if (module and node.module != module and node.module == module.rsplit('.', 1)[-1]
                        and item.name in (target, context.get('className'), '*')):
                    return {'valid': False, 'reason': f'Use from {module} import {item.name}; bare and package imports create different module instances.'}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = dotted(node.func)
        root, _, suffix = name.partition('.')
        resolved = aliases.get(root, root) + ('.' + suffix if suffix else '')
        if resolved != 'unittest.mock.patch' or not node.args:
            continue
        value = node.args[0]
        if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
            continue
        patch_path = value.value
        leaf = patch_path.rsplit('.', 1)[-1]
        for binding, origin in dependencies.items():
            if leaf == binding or patch_path == origin:
                expected = f'{module}.{binding}'
                if patch_path != expected:
                    return {'valid': False, 'reason': f'Patch the dependency at its target use point: {expected}, not {patch_path}. Verify the mock was called.'}
    return {'valid': True}


if __name__ == '__main__':
    print(json.dumps(validate_bindings(sys.stdin.read(), json.loads(sys.argv[1]))))
