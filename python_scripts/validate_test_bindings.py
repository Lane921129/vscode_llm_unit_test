"""Read-only AST gate for canonical target imports and unittest.mock bindings."""
import ast
import json
import sys
from mock_behavior import has_mock_behavior


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
                if item.name in ('target_module', 'module_under_test', 'your_module', 'module_name') and item.name != module:
                    return {'valid': False, 'reason': f'Unresolved placeholder import {item.name}; use canonical target module {module}.'}
                aliases[item.asname or item.name] = item.name
                if module and item.name != module and item.name == module.rsplit('.', 1)[-1]:
                    return {'valid': False, 'reason': f'Use canonical target module {module}; do not import a second instance as {item.name}.'}
        elif isinstance(node, ast.ImportFrom):
            for item in node.names:
                dependency_alias = (item.asname and item.asname not in (target, context.get('className'))
                                    and dependencies.get(item.asname) == f'{node.module}.{item.name}')
                if (module and node.module != module and item.name in (target, context.get('className'))
                        and not dependency_alias):
                    return {'valid': False, 'reason': f'Target binding {item.name} must be imported from {module}, not {node.module}.'}
                if context.get('className') and node.module == module and item.name == target:
                    return {'valid': False, 'reason': f'Import class {context["className"]} from {module}; {target} is a class member, not a module-level target.'}
                if node.module in ('target_module', 'module_under_test', 'your_module', 'module_name') and node.module != module:
                    return {'valid': False, 'reason': f'Unresolved placeholder import {node.module}; use canonical target module {module}.'}
                aliases[item.asname or item.name] = f'{node.module}.{item.name}'
                if (module and node.module != module and node.module == module.rsplit('.', 1)[-1]
                        and item.name in (target, context.get('className'), '*')):
                    return {'valid': False, 'reason': f'Use from {module} import {item.name}; bare and package imports create different module instances.'}
    def resolve(node):
        name = dotted(node)
        root, _, suffix = name.partition('.')
        return aliases.get(root, root) + ('.' + suffix if suffix else '')

    # unittest calls undecorated bound test methods without user arguments.
    # Decorators may inject mocks; leave those unknown cases to execution.
    for cls in (node for node in tree.body if isinstance(node, ast.ClassDef)):
        if cls.decorator_list or not any(resolve(base) in (
                'unittest.TestCase', 'unittest.IsolatedAsyncioTestCase') for base in cls.bases):
            continue
        for method in cls.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith('test_') or method.decorator_list:
                continue
            required = len(method.args.posonlyargs) + len(method.args.args) - len(method.args.defaults)
            if required > 1 or any(default is None for default in method.args.kw_defaults):
                return {'valid': False, 'reason': f'Unittest method {method.name} requires extra arguments. Put inputs inside the test; unittest supplies only the bound instance. Use a declared patch decorator only for its injected mocks.'}

    owner = context.get('className')
    qualified = target if not owner or target.startswith(owner + '.') else owner + '.' + target
    forbidden = {f'{module}.{qualified}'} if module and target else set()
    if module and owner:
        forbidden.add(f'{module}.{owner}')
    # Reject replacing the selected target even when there is another real Trace
    # test in the file. A normal assertion on a patched return is not target evidence.
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        factory = resolve(node.func)
        patch_path = None
        if factory == 'unittest.mock.patch' and node.args and isinstance(node.args[0], ast.Constant):
            patch_path = node.args[0].value
        elif factory == 'unittest.mock.patch.object' and len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
            attribute = node.args[1].value
            if isinstance(attribute, str):
                patch_path = resolve(node.args[0]) + '.' + attribute
        if isinstance(patch_path, str) and patch_path in forbidden:
            return {'valid': False, 'reason': 'Do not mock or replace the selected target or its class. Keep the real target and patch only its dependencies at their use points.'}

    # patch(...).start() returns a Mock, not its patcher. Calling stop on
    # that Mock cannot undo the patch and contaminates later real Trace cases.
    for scope in tree.body:
        if not isinstance(scope, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        started_mocks = set()
        for node in ast.walk(scope):
            if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
                continue
            start = node.value.func
            if not isinstance(start, ast.Attribute) or start.attr != 'start' or not isinstance(start.value, ast.Call):
                continue
            factory = dotted(start.value.func)
            root, _, suffix = factory.partition('.')
            resolved = aliases.get(root, root) + ('.' + suffix if suffix else '')
            if resolved == 'unittest.mock.patch':
                started_mocks.update(dotted(target) for target in node.targets
                                     if not isinstance(scope, ast.ClassDef) or dotted(target).startswith('self.'))
        for node in ast.walk(scope):
            if isinstance(node, ast.Attribute) and node.attr == 'stop' and dotted(node.value) in started_mocks:
                return {'valid': False, 'reason': 'Calling stop on the Mock returned by patch(...).start() does not undo the patch. Retain the patcher and register addCleanup(patcher.stop), or use a patch context manager.'}
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
    if context.get('requireMockBehavior') and not has_mock_behavior(tree, context):
        return {'valid': False, 'reason': 'Mock assertion is not proven to observe an explicit target use-point patch or a mock passed to the target.'}
    return {'valid': True}


if __name__ == '__main__':
    if sys.argv[1] == '--payload':
        payload = json.load(sys.stdin)
        result = validate_bindings(payload['code'], payload['context'])
    else:
        result = validate_bindings(sys.stdin.read(), json.loads(sys.argv[1]))
    print(json.dumps(result))
