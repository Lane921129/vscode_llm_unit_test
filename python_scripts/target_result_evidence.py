"""Read-only AST data flow for unittest assertions, including unpacked results.

No submitted code is executed. Unsupported flows do not manufacture evidence.
"""
import ast
import textwrap
from ast_extractor import function_scope_bindings


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        root = dotted(node.value)
        return root + '.' + node.attr if root else ''
    return ''


def direct_parameter_writes(context):
    """Prove only straight-line writes on an unrebound module-function input.

    This identifies observable state, never its expected value. Unsupported
    ownership, control flow or parameter binding yields no state evidence.
    """
    if context.get('className') or context.get('targetUsage') == 'property':
        return None, {}
    source = context.get('source', '')
    if not isinstance(source, str) or len(source) > 512000:
        return None, {}
    try:
        tree = ast.parse(textwrap.dedent(source))
    except (SyntaxError, ValueError, RecursionError):
        return None, {}
    target = context.get('target', '')
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == target]
    if len(tree.body) != 1 or len(functions) != 1:
        return None, {}
    function = functions[0]
    if function.decorator_list or function.args.vararg or function.args.kwarg:
        return None, {}
    parameters = {arg.arg for arg in [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]}
    if any(not isinstance(node, (ast.Assign, ast.AnnAssign, ast.Expr, ast.Return, ast.Pass)) for node in function.body):
        return None, {}
    if any(isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)) and node.id in parameters
           or isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del)) and
           (node.attr.startswith('__') or isinstance(node.value, ast.Call))
           or isinstance(node, ast.Call) and dotted(node.func).split('.')[-1] in
           {'setattr', 'delattr', 'globals', 'locals', 'vars', 'exec', 'eval'} for node in ast.walk(function)):
        return None, {}
    writes = {}
    for node in function.body:
        if isinstance(node, ast.Return):
            break
        if not isinstance(node, (ast.Assign, ast.AnnAssign)) or node.value is None:
            continue
        for destination in node.targets if isinstance(node, ast.Assign) else [node.target]:
            if (isinstance(destination, ast.Attribute) and isinstance(destination.value, ast.Name)
                    and destination.value.id in parameters and not destination.attr.startswith('__')):
                writes.setdefault(destination.value.id, set()).add(destination.attr)
    return function, writes


def has_target_result_assertion(tree, context):
    aliases = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for item in node.names:
                aliases[item.asname or item.name.split('.')[0]] = item.name if item.asname else item.name.split('.')[0]
        elif isinstance(node, ast.ImportFrom) and not node.level:
            for item in node.names:
                aliases[item.asname or item.name] = f'{node.module}.{item.name}'
    owner = context.get('className')
    target = context.get('target', '')
    root = context.get('module', '') + ('.' + owner if owner else '')
    selected = root + '.' + target
    module_aliases = aliases.copy()
    state_function, parameter_writes = direct_parameter_writes(context)
    namespace_module_aliases = {}
    module_defined_names = set()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for item in node.names:
                name = item.asname or (item.name.split('.')[0] if isinstance(node, ast.Import) else item.name)
                origin = ((item.name if item.asname else item.name.split('.')[0]) if isinstance(node, ast.Import)
                          else f'{node.module}.{item.name}')
                if not isinstance(node, ast.ImportFrom) or not node.level:
                    if origin in ('types', 'types.SimpleNamespace'):
                        namespace_module_aliases[name] = origin
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            namespace_module_aliases.pop(node.name, None)
            module_defined_names.add(node.name)
        else:
            for child in ast.walk(node):
                if isinstance(child, (ast.Name, ast.Attribute)) and isinstance(child.ctx, (ast.Store, ast.Del)):
                    namespace_module_aliases.pop(dotted(child).split('.')[0], None)
                    module_defined_names.add(dotted(child).split('.')[0])
            if any(isinstance(child, ast.Call) for child in ast.walk(node)):
                namespace_module_aliases.clear()

    def resolve(node, hidden):
        name = dotted(node)
        head, _, tail = name.partition('.')
        return '' if head in hidden else aliases.get(head, head) + ('.' + tail if tail else '')

    for cls in tree.body:
        aliases = module_aliases.copy()
        if not isinstance(cls, ast.ClassDef) or cls.decorator_list:
            continue
        if not any(resolve(base, set()) in ('unittest.TestCase', 'unittest.IsolatedAsyncioTestCase') for base in cls.bases):
            continue
        fixtures = [node for node in cls.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in ('setUp', 'asyncSetUp')]
        for method in cls.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith('test_'):
                continue
            values, instances = set(), set()
            hidden = function_scope_bindings(method)
            aliases = module_aliases.copy()
            namespace_aliases = namespace_module_aliases.copy()
            namespaces, states = set(), set()
            state_safe = not method.decorator_list and not any(
                isinstance(node, ast.Call) and dotted(node.func).split('.')[-1] in
                {'setattr', 'delattr', 'globals', 'locals', 'vars', 'exec', 'eval'} for node in ast.walk(method))
            namespace_authorized = state_safe

            def is_target(node):
                return resolve(node, hidden) == selected or bool(owner and isinstance(node, ast.Attribute)
                    and node.attr == target and (dotted(node.value) in instances or (
                        isinstance(node.value, ast.Call) and resolve(node.value.func, hidden) == root)))

            def derived(node):
                if isinstance(node, ast.Await):
                    return derived(node.value)
                if isinstance(node, ast.Call):
                    return is_target(node.func) or (resolve(node.func, hidden) in (
                        'len', 'bool', 'str', 'int', 'float', 'abs', 'round', 'sorted', 'list', 'tuple', 'type', 'isinstance')
                        and any(derived(arg) for arg in node.args))
                if isinstance(node, (ast.Name, ast.Attribute)):
                    return dotted(node) in values or dotted(node) in states or (context.get('targetUsage') == 'property' and is_target(node)) or (
                        isinstance(node, ast.Attribute) and derived(node.value))
                if isinstance(node, ast.Subscript):
                    return derived(node.value)
                if isinstance(node, (ast.Tuple, ast.List)):
                    return any(derived(item) for item in node.elts)
                if isinstance(node, (ast.UnaryOp, ast.BinOp, ast.Compare)):
                    return any(derived(child) for child in ast.iter_child_nodes(node))
                return False

            def assign(node, evidence, instance=False):
                if isinstance(node, (ast.Tuple, ast.List)):
                    for item in node.elts:
                        assign(item, evidence)
                elif isinstance(node, ast.Starred):
                    assign(node.value, evidence)
                else:
                    name = dotted(node)
                    affected = name or (dotted(node.value) if isinstance(node, ast.Subscript) else '')
                    if affected:
                        states.difference_update(item for item in states.copy()
                                                 if item == affected or item.startswith(affected + '.'))
                        namespaces.discard(affected)
                        namespace_aliases.pop(affected.split('.')[0], None)
                    if not name:
                        # Mutation of an element invalidates the containing result.
                        if isinstance(node, ast.Subscript):
                            values.discard(dotted(node.value))
                        states.clear(); namespaces.clear()
                        return
                    if isinstance(node, ast.Attribute):
                        values.discard(dotted(node.value))
                    values.discard(name)
                    instances.discard(name)
                    if evidence:
                        values.add(name)
                    if instance:
                        instances.add(name)
                    if isinstance(node, ast.Name):
                        hidden.add(name)

            def namespace_factory(node):
                if not isinstance(node, ast.Call) or node.args or any(keyword.arg is None or keyword.arg.startswith('__') for keyword in node.keywords):
                    return False
                name = dotted(node.func)
                head, _, tail = name.partition('.')
                origin = namespace_aliases.get(head)
                return bool(namespace_authorized and head not in hidden and origin and
                            origin + ('.' + tail if tail else '') == 'types.SimpleNamespace')

            def observe_state_call(node, enabled=True):
                """Follow actual evaluation order; unsupported calls revoke state."""
                nonlocal namespace_authorized
                if isinstance(node, ast.Await):
                    observe_state_call(node.value, enabled)
                    return
                if not isinstance(node, ast.Call):
                    if isinstance(node, (ast.Tuple, ast.List, ast.Dict, ast.Set, ast.UnaryOp, ast.BinOp, ast.Compare)):
                        for child in ast.iter_child_nodes(node):
                            observe_state_call(child, enabled)
                    return
                for argument in [*node.args, *(keyword.value for keyword in node.keywords)]:
                    observe_state_call(argument, enabled)
                if enabled and state_safe and state_function and is_target(node.func):
                    positional = [*state_function.args.posonlyargs, *state_function.args.args]
                    if any(isinstance(argument, ast.Starred) for argument in node.args) or len(node.args) > len(positional):
                        states.clear(); namespaces.clear()
                        return
                    bound = {parameter.arg: argument for parameter, argument in zip(positional, node.args)}
                    keyword_names = {arg.arg for arg in [*state_function.args.args, *state_function.args.kwonlyargs]}
                    for keyword in node.keywords:
                        if keyword.arg not in keyword_names or keyword.arg in bound:
                            states.clear(); namespaces.clear()
                            return
                        bound[keyword.arg] = keyword.value
                    for parameter, attributes in parameter_writes.items():
                        argument = bound.get(parameter)
                        if isinstance(argument, ast.Name) and argument.id in namespaces:
                            states.update(argument.id + '.' + attribute for attribute in attributes)
                    return
                pure = (isinstance(node.func, ast.Name) and node.func.id not in module_defined_names
                        and resolve(node.func, hidden) in ('len', 'bool', 'str', 'int', 'float', 'abs', 'round', 'sorted', 'list', 'tuple', 'type', 'isinstance', 'set', 'dict'))
                assertion = isinstance(node.func, ast.Attribute) and dotted(node.func.value) == 'self' and node.func.attr.startswith('assert')
                if namespace_factory(node) or pure or assertion:
                    return
                states.clear(); namespaces.clear()
                namespace_authorized = False

            def statements(nodes, assertions=True):
                for node in nodes:
                    if isinstance(node, (ast.Import, ast.ImportFrom)):
                        # A method-local import is a real binding only after
                        # that statement, in this exact lexical scope. Never
                        # borrow relative/wildcard imports or another test's
                        # local namespace as target-call evidence.
                        if isinstance(node, ast.ImportFrom) and (node.level or any(item.name == '*' for item in node.names)):
                            return False
                        for item in node.names:
                            name = item.asname or (item.name.split('.')[0] if isinstance(node, ast.Import) else item.name)
                            origin = ((item.name if item.asname else item.name.split('.')[0]) if isinstance(node, ast.Import)
                                      else f'{node.module}.{item.name}')
                            values.discard(name)
                            instances.discard(name)
                            states.difference_update(item for item in states.copy() if item == name or item.startswith(name + '.'))
                            namespaces.discard(name)
                            aliases[name] = origin
                            namespace_aliases.pop(name, None)
                            if origin in ('types', 'types.SimpleNamespace'):
                                namespace_aliases[name] = origin
                            hidden.discard(name)
                    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        assign(ast.Name(id=node.name, ctx=ast.Store()), False)
                    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                        value = node.value
                        fresh_namespace = assertions and namespace_factory(value)
                        escaped_namespace = isinstance(value, ast.Name) and value.id in namespaces
                        observe_state_call(value, assertions)
                        evidence = derived(value)
                        instance = bool(owner and isinstance(value, ast.Call) and resolve(value.func, hidden) == root)
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        for dest in targets:
                            # Respect each element's origin for tuple literals.
                            if isinstance(dest, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List)) and len(dest.elts) == len(value.elts):
                                flags = [derived(item) for item in value.elts]
                                for item, flag in zip(dest.elts, flags):
                                    assign(item, flag)
                            else:
                                assign(dest, evidence, instance)
                        if escaped_namespace:
                            states.clear(); namespaces.clear()
                        if fresh_namespace and namespace_authorized and len(targets) == 1 and isinstance(targets[0], ast.Name):
                            namespaces.add(targets[0].id)
                    elif isinstance(node, (ast.AugAssign, ast.Delete)):
                        for dest in node.targets if isinstance(node, ast.Delete) else [node.target]:
                            assign(dest, False)
                    elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                        call = node.value
                        observe_state_call(call, assertions)
                        if assertions and isinstance(call.func, ast.Attribute) and dotted(call.func.value) == 'self' and call.func.attr.startswith('assert'):
                            # Messages are not tested values; target-vs-target is not an oracle.
                            count = 2 if call.func.attr in ('assertEqual', 'assertNotEqual', 'assertAlmostEqual', 'assertNotAlmostEqual', 'assertIs', 'assertIsNot', 'assertIn', 'assertNotIn', 'assertGreater', 'assertGreaterEqual', 'assertLess', 'assertLessEqual', 'assertSequenceEqual', 'assertListEqual', 'assertTupleEqual', 'assertDictEqual', 'assertCountEqual') else 1
                            flags = [derived(arg) for arg in call.args[:count]]
                            if any(flags) and (count == 1 or not all(flags)):
                                return True
                    elif isinstance(node, ast.Assert) and assertions:
                        observe_state_call(node.test)
                        if derived(node.test) and not (isinstance(node.test, ast.Compare)
                                and all(derived(item) for item in [node.test.left, *node.test.comparators])):
                            return True
                    elif isinstance(node, (ast.With, ast.AsyncWith)):
                        for item in node.items:
                            observe_state_call(item.context_expr, assertions)
                        raises = any(isinstance(item.context_expr, ast.Call) and isinstance(item.context_expr.func, ast.Attribute)
                            and dotted(item.context_expr.func.value) == 'self' and item.context_expr.func.attr in ('assertRaises', 'assertRaisesRegex') for item in node.items)
                        if assertions and raises and any(isinstance(child, ast.Call) and is_target(child.func) for child in ast.walk(node)):
                            return True
                        if statements(node.body, assertions):
                            return True
                        states.clear(); namespaces.clear()
                    elif isinstance(node, ast.If):
                        # Check assertions within branches, but do not carry uncertain writes out.
                        observe_state_call(node.test, assertions)
                        old = values.copy(), instances.copy(), hidden.copy(), aliases.copy(), states.copy(), namespaces.copy(), namespace_aliases.copy()
                        for branch in (node.body, node.orelse):
                            values.clear(); values.update(old[0])
                            instances.clear(); instances.update(old[1])
                            hidden.clear(); hidden.update(old[2])
                            aliases.clear(); aliases.update(old[3])
                            states.clear(); states.update(old[4])
                            namespaces.clear(); namespaces.update(old[5])
                            namespace_aliases.clear(); namespace_aliases.update(old[6])
                            if statements(branch, assertions):
                                return True
                        values.clear(); instances.clear()
                        states.clear(); namespaces.clear()
                        hidden.clear(); hidden.update(old[2])
                        aliases.clear(); aliases.update(old[3])
                        namespace_aliases.clear(); namespace_aliases.update(old[6])
                    elif isinstance(node, (ast.For, ast.AsyncFor)):
                        old_hidden, old_aliases = hidden.copy(), aliases.copy()
                        observe_state_call(node.iter, assertions)
                        assign(node.target, False)
                        if statements(node.body, assertions):
                            return True
                        values.clear(); instances.clear()
                        states.clear(); namespaces.clear()
                        hidden.clear(); hidden.update(old_hidden)
                        aliases.clear(); aliases.update(old_aliases)
                    elif isinstance(node, (ast.Return, ast.Raise, ast.Try, ast.While)):
                        return False
                return False

            for fixture in fixtures:
                aliases.clear(); aliases.update(module_aliases)
                hidden.clear(); hidden.update(function_scope_bindings(fixture))
                statements(fixture.body, False)
            # Fixture instances are useful; assertions must inspect a call made in the test.
            values.clear()
            states.clear(); namespaces.clear()
            namespace_aliases.clear(); namespace_aliases.update(namespace_module_aliases)
            namespace_authorized = state_safe
            aliases.clear(); aliases.update(module_aliases)
            hidden.clear(); hidden.update(function_scope_bindings(method))
            if statements(method.body):
                return True
    return False
