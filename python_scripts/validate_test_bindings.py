"""Read-only AST gate for canonical target imports and unittest.mock bindings."""
import ast
import json
import sys
import builtins
import symtable
import io
import tokenize
from mock_behavior import has_mock_behavior, imports as mock_imports
from target_result_evidence import has_target_result_assertion


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        return f'{parent}.{node.attr}' if parent else ''
    return ''


def definite_test_name_failure(tree, code):
    """Diagnose only direct, statically certain test-owned name failures.

    Unknown branches, dynamic namespaces and nested expression scopes are left
    to execution. Source globals are not magically imported into a test module.
    """
    try:
        tables = symtable.symtable(code, '<generated-test>', 'exec')
    except SyntaxError:
        return {'name': 'scope', 'reasonCode': 'writer-invalid-name-scope', 'method': 'generated scope'}
    globals_ = {symbol.get_name() for symbol in tables.get_symbols()
                if symbol.is_assigned() or symbol.is_imported() or symbol.is_namespace()}
    globals_.update(vars(builtins))
    globals_.update({'__name__', '__file__', '__package__', '__spec__', '__loader__', '__builtins__', '__doc__'})
    module_imports = mock_imports(tree.body)
    if any(isinstance(node, ast.ImportFrom) and any(alias.name == '*' for alias in node.names)
           or isinstance(node, ast.Call) and dotted(node.func) in ('globals', 'locals', 'vars', 'exec', 'eval')
           for node in ast.walk(tree)):
        return None

    def reads(expression):
        if expression is None:
            return []
        if any(isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp))
               for node in ast.walk(expression)):
            return []
        return [node.id for node in ast.walk(expression) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)]

    for cls in (node for node in tree.body if isinstance(node, ast.ClassDef)):
        bases = [dotted(base).partition('.') for base in cls.bases]
        if cls.decorator_list or not any(module_imports.get(root, root) + ('.' + tail if separator else '')
                                        in ('unittest.TestCase', 'unittest.IsolatedAsyncioTestCase')
                                        for root, separator, tail in bases):
            continue
        method_counts = {}
        for method in cls.body:
            if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)):
                method_counts[method.name] = method_counts.get(method.name, 0) + 1
        cls_table = next((table for table in tables.get_children() if table.get_lineno() == cls.lineno
                          and table.get_name() == cls.name), None)
        if not cls_table:
            continue
        for method in cls.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith('test_'):
                continue
            if method_counts[method.name] != 1:
                continue
            if any(isinstance(node, (ast.Global, ast.Nonlocal, ast.NamedExpr)) for node in ast.walk(method)):
                continue
            scope = next((table for table in cls_table.get_children() if table.get_lineno() == method.lineno
                          and table.get_name() == method.name), None)
            if not scope:
                continue
            local = {symbol.get_name() for symbol in scope.get_symbols() if symbol.is_local()}
            bound = {symbol.get_name() for symbol in scope.get_symbols() if symbol.is_parameter()}

            def check(expression):
                for name in reads(expression):
                    if name in local and name not in bound:
                        return {'name': name, 'reasonCode': 'writer-unbound-local-name'}
                    if name not in local and name not in globals_:
                        return {'name': name, 'reasonCode': 'writer-undefined-name'}
                return None

            def statements(nodes):
                for node in nodes:
                    if isinstance(node, (ast.Assign, ast.AnnAssign)):
                        failure = check(node.value)
                        if failure:
                            return failure
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        if node.value is not None:
                            bound.update(child.id for target in targets for child in ast.walk(target)
                                         if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store))
                    elif isinstance(node, (ast.Import, ast.ImportFrom)):
                        bound.update(alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name)
                                     for alias in node.names)
                    elif isinstance(node, ast.With):
                        for item in node.items:
                            failure = check(item.context_expr)
                            if failure:
                                return failure
                            if item.optional_vars:
                                bound.update(child.id for child in ast.walk(item.optional_vars)
                                             if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store))
                        failure = statements(node.body)
                        if failure:
                            return failure
                    elif isinstance(node, (ast.Expr, ast.Return, ast.Raise, ast.Assert)):
                        failure = check(node)
                        if failure:
                            return failure
                        if isinstance(node, (ast.Return, ast.Raise)):
                            return None
                    elif not isinstance(node, ast.Pass):
                        return None
                return None

            failure = statements(method.body)
            if failure:
                return {**failure, 'method': method.name}
    return None


def validate_bindings(code, context):
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        return {'valid': False, 'reason': f'Python syntax: {error.msg} (line {error.lineno})'}
    # These are exact tool-owned scaffold markers, not a ban on legitimate None
    # fixtures or arbitrary source comments/strings containing the word TODO.
    markers = ('# SETUP PLACEHOLDERS ONLY:', '# TODO: set appropriate mock return value',
               '# TODO: set appropriate test value for', '# TODO: provide valid values for', '# TODO: add assertions here')
    if any(token.type == tokenize.COMMENT and token.string.startswith(markers)
           for token in tokenize.generate_tokens(io.StringIO(code).readline)):
        return {'valid': False, 'reasonCode': 'writer-scaffold-placeholder', 'repairRole': 'writer',
                'reason': 'Writer must complete the setup-only scaffold and remove its unresolved placeholder markers before validation.'}
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
    # Diagnose the same certain test-owned binding failures before generic
    # behavior gates can hide the missing import or local shadowing from Writer.
    failure = definite_test_name_failure(tree, code)
    if failure:
        name = failure['name']
        reason = (f'Writer binding repair: {name} is undefined or read before its local binding in {failure["method"]}. '
                  'Use a distinct mock alias and explicitly import test helpers or source globals at the canonical target module; '
                  'do not change assertions or install a guessed package.')
        if failure['reasonCode'] == 'writer-invalid-name-scope':
            reason = 'Writer binding repair: generated global/local declarations are inconsistent. Revise the test scope before execution.'
        return {'valid': False, **failure, 'repairRole': 'writer',
                'reason': reason}
    if context.get('requireMockBehavior') and not has_mock_behavior(tree, context):
        return {'valid': False, 'reason': 'Mock assertion is not proven to observe an explicit target use-point patch or a mock passed to the target.'}
    if context.get('requireTargetBehavior') and not (has_target_result_assertion(tree, context) or has_mock_behavior(tree, context)):
        locations = ', '.join(f'{node.name}:{node.lineno}' for node in ast.walk(tree)
                             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith('test_'))[:300]
        return {'valid': False, 'reason': f'AST 未找到目標回傳值、例外或受控相依的有效斷言（{locations}）；請保留回傳值（可解包），勿覆寫後驗證常數或比較目標與自身。'}
    return {'valid': True}


if __name__ == '__main__':
    if sys.argv[1] == '--payload':
        payload = json.load(sys.stdin)
        result = validate_bindings(payload['code'], payload['context'])
    else:
        result = validate_bindings(sys.stdin.read(), json.loads(sys.argv[1]))
    print(json.dumps(result))
