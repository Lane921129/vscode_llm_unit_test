"""Conservative AST evidence for assertions on standard-library mocks.

Only straight-line test code and explicit patch scopes are followed. Unknown
control flow, rebinding, manual mock calls and patched targets are not evidence.
This module never executes the supplied test code.
"""
import ast
import textwrap
from ast_extractor import function_scope_bindings, function_scope_usage


ASSERTIONS = {'assert_called', 'assert_called_once', 'assert_called_with',
              'assert_called_once_with', 'assert_any_call', 'assert_has_calls',
              'assert_not_called', 'assert_awaited', 'assert_awaited_once',
              'assert_awaited_with', 'assert_awaited_once_with', 'assert_any_await',
              'assert_has_awaits', 'assert_not_awaited'}
MOCK_FACTORIES = {'unittest.mock.Mock', 'unittest.mock.MagicMock', 'unittest.mock.AsyncMock'}


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        root = dotted(node.value)
        return f'{root}.{node.attr}' if root else ''
    return ''


def imports(statements):
    result = {}
    for node in statements:
        if isinstance(node, ast.Import):
            for alias in node.names:
                result[alias.asname or alias.name.split('.')[0]] = alias.name if alias.asname else alias.name.split('.')[0]
        elif isinstance(node, ast.ImportFrom) and not node.level:
            for alias in node.names:
                result[alias.asname or alias.name] = f'{node.module}.{alias.name}'
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            result.pop(node.name, None)
        else:
            for child in ast.walk(node):
                if isinstance(child, (ast.Name, ast.Attribute)) and isinstance(child.ctx, (ast.Store, ast.Del)):
                    result.pop(dotted(child).split('.')[0], None)
    return result


def target_use_points(context):
    try:
        source = ast.parse(textwrap.dedent(context.get('source', '')))
    except SyntaxError:
        return set(), False
    functions = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name == context.get('target')]
    if len(functions) != 1:
        return set(), False
    calls, _, roots = function_scope_usage(functions[0], function_scope_bindings(functions[0]))
    return {f"{context['module']}.{call}" for call in calls if call.split('.')[0] in roots}, isinstance(functions[0], ast.AsyncFunctionDef)


def has_mock_behavior(tree, context):
    module = context.get('module', '')
    owner = context.get('className')
    target = context.get('target', '')
    target_path = f'{module}.{owner}.{target}' if owner else f'{module}.{target}'
    use_points, asynchronous = target_use_points(context)
    permitted = use_points - {target_path, f'{module}.{owner}' if owner else ''}
    module_imports = imports(tree.body)

    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef) or cls.decorator_list:
            continue
        bases = [dotted(base).split('.') for base in cls.bases]
        if len(bases) != 1 or not any('.'.join([module_imports.get(base[0], ''), *base[1:]]) in
                   ('unittest.TestCase', 'unittest.IsolatedAsyncioTestCase') for base in bases):
            continue
        for method in cls.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith('test_'):
                continue
            aliases = dict(module_imports)
            bindings, instances, observed, manual = {}, set(), set(), set()
            blocked_paths = set()
            patch_blocked = {}
            serial = 0

            def resolve(node):
                name = dotted(node)
                root, _, tail = name.partition('.')
                origin = aliases.get(root)
                return origin + ('.' + tail if tail else '') if origin else ''

            def token(node):
                name = dotted(node)
                if name and any(name == prefix or name.startswith(prefix + '.') for prefix in blocked_paths):
                    return None
                for prefix in sorted(bindings, key=len, reverse=True):
                    if name == prefix or name.startswith(prefix + '.'):
                        value = bindings[prefix]
                        suffix = name[len(prefix):].lstrip('.')
                        if any(suffix == item or suffix.startswith(item + '.')
                               for item in patch_blocked.get(value, ())):
                            return None
                        return value
                return None

            def patch_token(call):
                nonlocal serial
                if not isinstance(call, ast.Call) or any(k.arg in (None, 'new', 'new_callable', 'create') for k in call.keywords):
                    return None
                factory = resolve(call.func)
                value = None
                if factory == 'unittest.mock.patch' and call.args and len(call.args) == 1:
                    arg = call.args[0]
                    value = arg.value if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else None
                elif factory == 'unittest.mock.patch.object' and len(call.args) == 2:
                    arg = call.args[1]
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        value = resolve(call.args[0]) + '.' + arg.value
                if value not in permitted:
                    return None
                serial += 1
                # Configured return values/attributes need not be mocks. The
                # patch itself is still a real Mock and supports call assertions.
                patch_blocked[serial] = {k.arg for k in call.keywords
                                         if k.arg not in ('spec', 'spec_set', 'autospec')}
                return serial

            def is_target(call):
                if resolve(call.func) == target_path:
                    return True
                return bool(owner and isinstance(call.func, ast.Attribute) and call.func.attr == target
                            and dotted(call.func.value) in instances)

            def expression(node, active, awaited=False):
                nonlocal serial
                if isinstance(node, ast.Await):
                    return expression(node.value, active, True)
                if not isinstance(node, ast.Call):
                    return False
                if is_target(node):
                    if asynchronous and not awaited:
                        return False
                    observed.update(active)
                    observed.update(value for arg in [*node.args, *(k.value for k in node.keywords)]
                                    if (value := token(arg)) is not None)
                    return False
                if isinstance(node.func, ast.Attribute) and node.func.attr in ASSERTIONS:
                    value = token(node.func.value)
                    return value is not None and token(node.func) == value and value in observed and value not in manual
                value = token(node.func)
                if value is not None:
                    manual.add(value)
                return False

            def statements(nodes, active):
                nonlocal serial
                found = False
                for node in nodes:
                    if isinstance(node, ast.With):
                        nested = set(active)
                        for item in node.items:
                            value = patch_token(item.context_expr)
                            if value is None:
                                return found
                            name = dotted(item.optional_vars)
                            if name:
                                bindings[name] = value
                            if value is not None:
                                nested.add(value)
                        found = statements(node.body, nested) or found
                    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                        rhs = node.value
                        found = expression(rhs, active) or found
                        value = token(rhs)
                        if isinstance(rhs, ast.Call) and resolve(rhs.func) in MOCK_FACTORIES:
                            serial += 1
                            value = serial
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        for lhs in targets:
                            name = dotted(lhs)
                            if not name:
                                return found
                            if isinstance(lhs, ast.Attribute) and isinstance(rhs, ast.Call) and resolve(rhs.func) in MOCK_FACTORIES:
                                value = token(lhs.value) or value
                            if isinstance(lhs, ast.Attribute) and lhs.attr in ASSERTIONS:
                                existing = token(lhs.value)
                                if existing is not None:
                                    manual.add(existing)
                            if value is None:
                                blocked_paths.add(name)
                            else:
                                blocked_paths.discard(name)
                            bindings[name] = value
                            if isinstance(rhs, ast.Call) and resolve(rhs.func) in MOCK_FACTORIES:
                                for keyword in rhs.keywords:
                                    if keyword.arg is None:
                                        blocked_paths.add(name)
                                    elif keyword.arg not in ('spec', 'spec_set', 'name', 'unsafe'):
                                        blocked_paths.add(name + '.' + keyword.arg)
                            aliases.pop(name.split('.')[0], None)
                            instances.discard(name)
                            if owner and isinstance(rhs, ast.Call) and resolve(rhs.func) == f'{module}.{owner}':
                                instances.add(name)
                    elif isinstance(node, ast.Expr):
                        found = expression(node.value, active) or found
                    elif isinstance(node, (ast.Import, ast.ImportFrom)):
                        aliases.update(imports([node]))
                    elif not isinstance(node, ast.Pass):
                        # Do not let unexecuted branches or hidden rebinding
                        # supply evidence to statements that follow them.
                        return found
                return found

            # unittest invokes a direct, undecorated setUp before each test.
            # Transfer only instance attributes from a provable straight-line
            # setup. Never transfer setup locals or assume arbitrary helpers ran.
            setups = [item for item in cls.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
                      and item.name == 'setUp']
            lifecycle_overrides = {'__getattribute__', '__getattr__', '__setattr__', 'run', '__call__', '_callSetUp', 'asyncSetUp'}
            if (len(setups) == 1 and isinstance(setups[0], ast.FunctionDef) and not setups[0].decorator_list
                    and not any(isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
                                and item.name in lifecycle_overrides for item in cls.body)
                    and all(isinstance(item, (ast.Assign, ast.AnnAssign, ast.Import, ast.ImportFrom, ast.Pass))
                            for item in setups[0].body)
                    and [arg.arg for arg in setups[0].args.args] == ['self']):
                statements(setups[0].body, set())
                # Class descriptors/properties may intercept assignment and
                # access; they cannot establish standard Mock provenance.
                class_names = {item.name for item in cls.body
                               if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
                class_names.update(child.id for item in cls.body if isinstance(item, (ast.Assign, ast.AnnAssign))
                                   for child in ast.walk(item) if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store))
                bindings = {name: value for name, value in bindings.items()
                            if name.startswith('self.') and name.split('.')[1] not in class_names}
                blocked_paths = {name for name in blocked_paths if name.startswith('self.')}
                instances = {name for name in instances if name.startswith('self.')}
                aliases = dict(module_imports)
                observed.clear()

            decorated = [patch_token(decorator) for decorator in reversed(method.decorator_list)]
            if any(value is None for value in decorated):
                continue
            parameters = [arg.arg for arg in [*method.args.posonlyargs, *method.args.args]][1:]
            for name in parameters:
                aliases.pop(name, None)
            active = set()
            for name, value in zip(parameters, decorated):
                bindings[name] = value
                if value is not None:
                    active.add(value)
            if statements(method.body, active):
                return True
    return False
