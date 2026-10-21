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


def source_function(tree, context, fragment=False):
    """Select the exact source member; fragments may contain just its def."""
    target = context.get('target', '').rsplit('.', 1)[-1]
    owner = context.get('className')
    nodes = tree.body
    if owner:
        classes = [node for node in nodes if isinstance(node, ast.ClassDef) and node.name == owner]
        if len(classes) == 1:
            nodes = classes[0].body
        elif not fragment or len(nodes) != 1 or not isinstance(nodes[0], (ast.FunctionDef, ast.AsyncFunctionDef)):
            return None
    functions = [node for node in nodes if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name == target]
    return functions[0] if len(functions) == 1 else None


def source_module_imports(context):
    """Prove module-object identity from full AST, never from a name hint.

    A from-import copies a binding and is intentionally not an equivalent
    provider patch. Rebinding, attribute writes and dynamic namespaces revoke
    this conservative proof, including writes in other functions.
    """
    raw = context.get('moduleSource', context.get('source', ''))
    if not isinstance(raw, str) or len(raw) > 512000:
        return {}
    try:
        tree = ast.parse(textwrap.dedent(raw))
        fragment = ast.parse(textwrap.dedent(context.get('source', '')))
    except (SyntaxError, TypeError):
        return {}
    selected, expected = source_function(tree, context), source_function(fragment, context, True)
    if not selected or not expected or ast.dump(selected) != ast.dump(expected):
        return {}
    bindings = {}
    direct_imports = {id(node) for node in tree.body if isinstance(node, ast.Import)}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname or alias.name.split('.')[0]
                if name in bindings:
                    bindings[name] = None
                else:
                    bindings[name] = alias.name if alias.asname else alias.name.split('.')[0]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and id(node) not in direct_imports:
            for alias in node.names:
                bindings.pop(alias.asname or alias.name.split('.')[0], None)
        elif isinstance(node, ast.ImportFrom):
            if any(alias.name == '*' for alias in node.names):
                return {}
            for alias in node.names:
                bindings.pop(alias.asname or alias.name, None)
        elif isinstance(node, (ast.Name, ast.Attribute)) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bindings.pop(dotted(node).split('.')[0], None)
        elif isinstance(node, ast.arg):
            bindings.pop(node.arg, None)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bindings.pop(node.name, None)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            bindings.pop(node.name, None)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            bindings.pop(node.rest, None)
        elif isinstance(node, ast.Attribute) and node.attr in ('__dict__', '__builtins__', '__getattribute__'):
            return {}
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bindings.pop(node.name, None)
        elif isinstance(node, ast.Call) and dotted(node.func).split('.')[-1] in {
                'globals', 'locals', 'vars', 'eval', 'exec', 'setattr', 'delattr', '__import__', 'reload'}:
            return {}
    return {name: origin for name, origin in bindings.items() if origin}


def possible_test_origins(tree):
    """Conservative alias set only for revoking equivalence, never granting it."""
    result = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                binding = alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name)
                origin = (alias.name if alias.asname else alias.name.split('.')[0]) if isinstance(node, ast.Import) else f'{node.module}.{alias.name}'
                result.setdefault(binding, set()).add(origin)
    for _ in range(3):
        for node in ast.walk(tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                root, _, tail = dotted(node.value).partition('.')
                origins = {origin + ('.' + tail if tail else '') for origin in result.get(root, ())}
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name) and origins:
                        result.setdefault(target.id, set()).update(origins)
    return result


def target_use_points(context):
    try:
        source = ast.parse(textwrap.dedent(context.get('source', '')))
    except SyntaxError:
        return set(), False
    selected = source_function(source, context, True)
    if not selected:
        return set(), False
    calls, _, roots = function_scope_usage(selected, function_scope_bindings(selected))
    return {f"{context['module']}.{call}" for call in calls if call.split('.')[0] in roots}, isinstance(selected, ast.AsyncFunctionDef)


def has_mock_behavior(tree, context):
    module = context.get('module', '')
    owner = context.get('className')
    target = context.get('target', '')
    target_path = f'{module}.{owner}.{target}' if owner else f'{module}.{target}'
    use_points, asynchronous = target_use_points(context)
    permitted = use_points - {target_path, f'{module}.{owner}' if owner else ''}
    module_imports = imports(tree.body)
    # Only the real standard-library constructor may expose explicit members.
    # Reflective mutation can bypass every lexical alias/path fact below.
    namespace_allowed = not any(
        isinstance(node, ast.Attribute) and node.attr in ('__dict__', '__class__', '__getattribute__', '__setattr__')
        or isinstance(node, ast.Call) and dotted(node.func).split('.')[-1] in
        ('setattr', 'delattr', 'globals', 'locals', 'vars', 'eval', 'exec', '__import__')
        for node in ast.walk(tree))
    # A provider member is the same object only while the application's module
    # binding remains intact. A test that replaces that binding cannot borrow
    # this proof for a simultaneous patch on the unrelated provider object.
    equivalent = source_module_imports(context)
    revocation_aliases = possible_test_origins(tree)

    def possible(node):
        root, _, tail = dotted(node).partition('.')
        return {origin + ('.' + tail if tail else '') for origin in revocation_aliases.get(root, {root})}

    for node in ast.walk(tree):
        resolved = set()
        if isinstance(node, (ast.Name, ast.Attribute)) and isinstance(node.ctx, (ast.Store, ast.Del)):
            resolved = possible(node)
        elif isinstance(node, ast.Call):
            factories = possible(node.func)
            if 'unittest.mock.patch' in factories and node.args and isinstance(node.args[0], ast.Constant):
                if isinstance(node.args[0].value, str):
                    resolved.add(node.args[0].value)
            elif ('unittest.mock.patch.object' in factories and len(node.args) >= 2
                  and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str)):
                resolved = {origin + '.' + node.args[1].value for origin in possible(node.args[0])}
            elif any(factory.split('.')[-1] in ('setattr', 'delattr', 'globals', 'locals', 'vars', 'eval', 'exec')
                     for factory in factories):
                equivalent = {}
        else:
            continue
        for binding in list(equivalent):
            if f'{module}.{binding}' in resolved:
                equivalent.pop(binding)
    for use_point in list(permitted):
        call = use_point[len(module) + 1:]
        root, separator, tail = call.partition('.')
        if separator and root in equivalent:
            permitted.add(equivalent[root] + '.' + tail)
    permitted -= {target_path, f'{module}.{owner}' if owner else ''}

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
            mock_roots, configured_children = set(), set()
            namespace_members = {}
            mock_children = {}
            serial = 0

            def resolve(node):
                name = dotted(node)
                root, _, tail = name.partition('.')
                origin = aliases.get(root)
                return origin + ('.' + tail if tail else '') if origin else ''

            def token_name(name):
                if name and any(name == prefix or name.startswith(prefix + '.') for prefix in blocked_paths):
                    return None
                for prefix in sorted(bindings, key=len, reverse=True):
                    if name == prefix or name.startswith(prefix + '.'):
                        value = bindings[prefix]
                        suffix = name[len(prefix):].lstrip('.')
                        # A namespace is an explicit object graph, not an
                        # auto-creating Mock. Traverse only declared members,
                        # sharing object IDs across aliases and member writes.
                        while isinstance(value, tuple) and value[0] == 'namespace' and suffix:
                            member, _, suffix = suffix.partition('.')
                            value = namespace_members.get(value, {}).get(member)
                        if any(suffix == item or suffix.startswith(item + '.')
                               for item in patch_blocked.get(value, ())):
                            return None
                        return value
                return None

            def token(node):
                return token_name(dotted(node))

            def fixture_value(node, depth=0):
                nonlocal serial
                if depth > 8:
                    return None
                if isinstance(node, ast.Call) and resolve(node.func) in MOCK_FACTORIES:
                    if any(keyword.arg is None for keyword in node.keywords):
                        return None
                    serial += 1
                    # Keyword-provided members may replace real Mock methods.
                    patch_blocked[serial] = {keyword.arg for keyword in node.keywords
                        if keyword.arg not in ('spec', 'spec_set', 'name', 'unsafe')}
                    return serial
                if (namespace_allowed and isinstance(node, ast.Call) and resolve(node.func) == 'types.SimpleNamespace'
                        and not node.args and len(node.keywords) <= 64
                        and all(keyword.arg is not None for keyword in node.keywords)
                        and len({keyword.arg for keyword in node.keywords}) == len(node.keywords)):
                    serial += 1
                    value = ('namespace', serial)
                    namespace_members[value] = {keyword.arg: fixture_value(keyword.value, depth + 1)
                                                for keyword in node.keywords}
                    return value
                return token(node)

            def injected_tokens(value):
                result, pending, visited = set(), [value], set()
                while pending:
                    item = pending.pop()
                    if item is None:
                        continue
                    if not isinstance(item, tuple):
                        result.add(item)
                        if item not in visited:
                            visited.add(item)
                            if len(visited) > 512:
                                return set()
                            pending.extend(mock_children.get(item, {}).values())
                    elif item not in visited:
                        visited.add(item)
                        if len(visited) > 512:
                            return set()  # no partial graph proof on overflow
                        pending.extend(namespace_members.get(item, {}).values())
                return result

            def configuration_path(node, calls):
                """Follow only proven Mock return chains, never arbitrary calls.

                Calling a child while arranging its return value contaminates
                that child's call history, not the parent mock's call count.
                Keep the affected paths out of later assertion evidence.
                """
                if isinstance(node, ast.Name):
                    return node.id
                if isinstance(node, ast.Attribute):
                    root = configuration_path(node.value, calls)
                    return f'{root}.{node.attr}' if root else ''
                if isinstance(node, ast.Call) and not node.args and not node.keywords:
                    name = configuration_path(node.func, calls)
                    if (name and token_name(name) is not None
                            and any(name.startswith(root + '.return_value.') for root in mock_roots)
                            and not any(part in ASSERTIONS or part in ('reset_mock', 'configure_mock', 'attach_mock')
                                        for part in name.split('.'))
                            and not any(name == prefix or name.startswith(prefix + '.')
                                        for prefix in calls)
                            and name + '.side_effect' not in bindings):
                        calls.add(name)
                        return name + '.return_value'
                return ''

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
                if not value or value in {target_path, f'{module}.{owner}' if owner else ''}:
                    return None
                if value not in permitted:
                    return 0
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
                # Python evaluates call arguments before invoking the outer
                # call. A real target inside a standard result assertion is
                # still an actual target call, not merely unused text.
                found = False
                for argument in [*node.args, *(keyword.value for keyword in node.keywords)]:
                    found = expression(argument, active) or found
                if is_target(node):
                    if asynchronous and not awaited:
                        return False
                    for item in active:
                        observed.update(injected_tokens(item))
                    for arg in [*node.args, *(k.value for k in node.keywords)]:
                        observed.update(injected_tokens(token(arg)))
                    return found
                if isinstance(node.func, ast.Attribute) and node.func.attr in ASSERTIONS:
                    value = token(node.func.value)
                    return found or (value is not None and token(node.func) == value and value in observed and value not in manual
                                     and (value not in configured_children or dotted(node.func.value) in mock_roots))
                value = token(node.func)
                if value is not None:
                    manual.add(value)
                return found

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
                            if value == 0:
                                if name:
                                    bindings.pop(name, None)
                                    mock_roots.discard(name)
                                    blocked_paths.add(name)
                                continue
                            if name:
                                bindings[name] = value
                                mock_roots.add(name)
                            nested.add(value)
                        found = statements(node.body, nested) or found
                    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                        rhs = node.value
                        found = expression(rhs, active) or found
                        value = token(rhs)
                        namespace_rhs = (namespace_allowed and isinstance(rhs, ast.Call)
                                         and resolve(rhs.func) == 'types.SimpleNamespace')
                        if namespace_rhs:
                            value = fixture_value(rhs)
                        elif isinstance(rhs, ast.Call) and resolve(rhs.func) in MOCK_FACTORIES:
                            serial += 1
                            value = serial
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        for lhs in targets:
                            name = dotted(lhs)
                            if not name:
                                calls = set()
                                name = configuration_path(lhs, calls)
                                if not name or not calls:
                                    return found
                                # The configured child may have been called by
                                # the test itself. It cannot prove target work.
                                configured_children.update(token_name(call) for call in calls)
                                blocked_paths.update(calls)
                            parent = token(lhs.value) if isinstance(lhs, ast.Attribute) else None
                            if isinstance(parent, tuple) and parent[0] == 'namespace':
                                # Mutating through any alias changes this same
                                # object. Unknown values revoke that member's
                                # provenance without borrowing a sibling Mock.
                                if isinstance(rhs, ast.Call) and resolve(rhs.func) in MOCK_FACTORIES:
                                    value = fixture_value(rhs)
                                namespace_members[parent][lhs.attr] = value
                                bindings.pop(name, None)
                                blocked_paths.discard(name)
                                continue
                            mock_roots.discard(name)
                            owner_prefix = next((prefix for prefix in sorted(bindings, key=len, reverse=True)
                                                 if name.startswith(prefix + '.') and isinstance(bindings[prefix], int)), None)
                            root_owner = token_name(owner_prefix) if owner_prefix else None
                            attr_suffix = name[len(owner_prefix) + 1:] if owner_prefix else ''
                            if isinstance(lhs, ast.Attribute) and lhs.attr in ASSERTIONS:
                                existing = token(lhs.value)
                                if existing is not None:
                                    manual.add(existing)
                            if isinstance(root_owner, int) and attr_suffix:
                                children = mock_children.setdefault(root_owner, {})
                                # Replacing a parent detaches every old path below it.
                                # Other edges/aliases still own their original objects.
                                for stale in [key for key in children if key == attr_suffix or key.startswith(attr_suffix + '.')]:
                                    children.pop(stale, None)
                                children[attr_suffix] = value
                            for stale in [key for key in bindings if key.startswith(name + '.')]:
                                bindings.pop(stale, None)
                            if value is None:
                                blocked_paths.add(name)
                            else:
                                blocked_paths.discard(name)
                            bindings[name] = value
                            if isinstance(rhs, ast.Call) and resolve(rhs.func) in MOCK_FACTORIES:
                                mock_roots.add(name)
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
                if value == 0:
                    bindings.pop(name, None)
                    mock_roots.discard(name)
                    blocked_paths.add(name)
                    continue
                bindings[name] = value
                mock_roots.add(name)
                if value is not None:
                    active.add(value)
            if statements(method.body, active):
                return True
    return False
