"""Read-only AST gate for canonical target imports and unittest.mock bindings."""
import ast
import json
import sys
import builtins
import symtable
import io
import textwrap
import tokenize
from mock_behavior import (has_mock_behavior, imports as mock_imports,
                           source_function, source_module_imports, source_namespace_use_points, target_use_points)
from target_result_evidence import has_target_result_assertion


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        return f'{parent}.{node.attr}' if parent else ''
    return ''


def _definite_test_name_failure(tree, code, ignored):
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
                    if (method.name, name) in ignored:
                        continue
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


def definite_test_name_failure(tree, code):
    """Keep the primary rejection independent of supplementary diagnostics."""
    return _definite_test_name_failure(tree, code, frozenset())


def _additional_name_feedback(tree, code, first):
    """Peel at most seven more failures for feedback, never for acceptance.

    Each scan retains the primary checker's unknown-scope boundaries. Skipping
    a reported binding only exposes possible next repairs in an already-rejected
    candidate; it does not execute, import or change the submitted test.
    """
    if first['reasonCode'] == 'writer-invalid-name-scope':
        return ''
    ignored = {(first['method'], first['name'])}
    details = []
    size = 0
    for _ in range(7):
        failure = _definite_test_name_failure(tree, code, ignored)
        if not failure or failure['reasonCode'] == 'writer-invalid-name-scope':
            break
        key = (failure['method'], failure['name'])
        if key in ignored:
            break
        detail = f'{failure["name"]} in {failure["method"]}'
        if size + len(detail) > 1200:
            break
        details.append(detail)
        size += len(detail)
        ignored.add(key)
    if not details:
        return ''
    return ('Additional statically unresolved bindings (bounded scan): '
            + '; '.join(details) + '. Repair the listed test bindings together. ')


def _proven_immutable_datetime_bindings(tree, expected, context):
    """Diagnose immutable attributes only for a source-matched, stable import.

    Dependency origin hints and an old import do not prove the current object.
    Unknown/rebound cases stay with execution rather than a certain rejection.
    """
    selected = source_function(tree, context)
    if not selected or not expected or ast.dump(selected) != ast.dump(expected):
        return {}
    bindings = {}
    direct_imports = {id(node) for node in tree.body if isinstance(node, ast.ImportFrom)
                      and not node.level and node.module == 'datetime'}
    for node in tree.body:
        if id(node) not in direct_imports:
            continue
        for alias in node.names:
            if alias.name in ('datetime', 'date'):
                name = alias.asname or alias.name
                bindings[name] = None if name in bindings else f'datetime.{alias.name}'
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if any(alias.name == '*' for alias in node.names):
                return {}
            for alias in node.names:
                name = alias.asname or alias.name
                if id(node) not in direct_imports or f'{node.module}.{alias.name}' != bindings.get(name):
                    bindings.pop(name, None)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                bindings.pop(alias.asname or alias.name.split('.')[0], None)
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
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bindings.pop(node.name, None)
        elif isinstance(node, ast.Attribute) and node.attr in ('__dict__', '__builtins__', '__getattribute__'):
            return {}
        elif isinstance(node, ast.Call) and dotted(node.func).split('.')[-1] in {
                'globals', 'locals', 'vars', 'eval', 'exec', 'setattr', 'delattr', '__import__', 'reload'}:
            return {}
    return {name: origin for name, origin in bindings.items() if origin}


def _source_patch_facts(context):
    module = context.get('module', '')
    owner = context.get('className')
    dependencies = dict(context.get('dependencies') or {})
    use_points, _ = target_use_points(context)
    equivalent = source_module_imports(context)
    parameters = []
    try:
        source_tree = ast.parse(textwrap.dedent(context.get('source', '')))
        selected = source_function(source_tree, context, True)
    except (SyntaxError, TypeError):
        selected = None
    if selected:
        raw_params = [arg.arg for arg in [*selected.args.posonlyargs, *selected.args.args, *selected.args.kwonlyargs]]
        if selected.args.vararg:
            raw_params.append(selected.args.vararg.arg)
        if selected.args.kwarg:
            raw_params.append(selected.args.kwarg.arg)
        is_static = any(dotted(dec).split('.')[-1] == 'staticmethod' for dec in selected.decorator_list)
        if owner and raw_params and not is_static:
            raw_params = raw_params[1:]
        parameters = raw_params

    module_globals = set(dependencies) | set(equivalent)
    from_imports = {}
    immutable_datetime = {}
    raw_module = context.get('moduleSource', '')
    if isinstance(raw_module, str) and raw_module and len(raw_module) <= 512000:
        try:
            mod_tree = ast.parse(textwrap.dedent(raw_module))
        except (SyntaxError, TypeError):
            mod_tree = None
        if mod_tree:
            immutable_datetime = _proven_immutable_datetime_bindings(mod_tree, selected, context)
            for node in mod_tree.body:
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        module_globals.add(alias.asname or alias.name.split('.')[0])
                elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
                    for alias in node.names:
                        if alias.name == '*':
                            continue
                        bound = alias.asname or alias.name
                        module_globals.add(bound)
                        origin = f'{node.module}.{alias.name}'
                        from_imports.setdefault(bound, origin)
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    module_globals.add(node.name)
                elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for tgt in targets:
                        for child in ast.walk(tgt):
                            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                                module_globals.add(child.id)
    return {
        'parameters': [param for param in parameters if param not in module_globals],
        'use_points': use_points,
        'namespace_points': source_namespace_use_points(context),
        'equivalent': equivalent,
        'from_imports': from_imports,
        'immutable_datetime': immutable_datetime,
        'module': module,
    }


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
                if item.name == 'HOST_ISOLATED_RESOURCE_CONTEXT':
                    return {'valid': False, 'reason': f'HOST_ISOLATED_RESOURCE_CONTEXT is a prompt section heading, not a Python module; remove that import and use {module or "the target module"} directly.'}
                if item.name in ('target_module', 'module_under_test', 'your_module', 'module_name') and item.name != module:
                    return {'valid': False, 'reason': f'Unresolved placeholder import {item.name}; use canonical target module {module}.'}
                aliases[item.asname or item.name] = item.name
                if module and item.name != module and item.name == module.rsplit('.', 1)[-1]:
                    return {'valid': False, 'reason': f'Use canonical target module {module}; do not import a second instance as {item.name}.'}
        elif isinstance(node, ast.ImportFrom):
            for item in node.names:
                if node.module == 'HOST_ISOLATED_RESOURCE_CONTEXT' or item.name == 'HOST_ISOLATED_RESOURCE_CONTEXT':
                    return {'valid': False, 'reason': f'HOST_ISOLATED_RESOURCE_CONTEXT is a prompt section heading, not a Python module or symbol; remove that import and use {module or "the target module"} directly.'}
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
            return {'valid': False, 'reason': f'Do not mock or replace the selected target or its class ({patch_path}). Keep the real target {qualified} and patch only its dependencies at their use points (or pass MagicMock() objects for function parameters).'}

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
    facts = _source_patch_facts(context)
    mentions_type_error = 'TypeError' in {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    patch_paths = []
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
        patch_paths.append(patch_path)
        leaf = patch_path.rsplit('.', 1)[-1]
        if module:
            for param in facts['parameters']:
                if ((patch_path == f'{module}.{param}' or patch_path.startswith(f'{module}.{param}.'))
                        and patch_path not in facts['use_points']):
                    return {'valid': False, 'reason': (
                        f'Do not patch {patch_path}: {param} is a parameter of {qualified}, not a module attribute of {module}. '
                        f'Remove that patch, pass a MagicMock() (or controlled object) for {param} directly to {qualified}(...), '
                        f'and assert on {param}.'
                    )}
            if not mentions_type_error:
                for dt_binding, dt_origin in facts['immutable_datetime'].items():
                    if (patch_path.startswith(f'{module}.{dt_binding}.')
                            or patch_path.startswith(f'{dt_origin}.')
                            or (patch_path.startswith(f'{dt_binding}.') and patch_path.count('.') == 1)):
                        attr = patch_path.rsplit('.', 1)[-1]
                        return {'valid': False, 'reason': (
                            f'Do not patch immutable datetime/date attribute {patch_path} (raises TypeError at runtime). '
                            f"Patch the target module binding '{module}.{dt_binding}' (e.g. with patch('{module}.{dt_binding}') as clock_stub) "
                            f'and configure clock_stub.{attr}.return_value.'
                        )}
        for binding, origin in dependencies.items():
            if leaf == binding or patch_path == origin:
                expected = f'{module}.{binding}'
                if patch_path != expected:
                    return {'valid': False, 'reason': f'Patch the dependency at its target use point: {expected}, not {patch_path}. Verify the mock was called.'}
        if module:
            for binding, origin in facts['from_imports'].items():
                if patch_path == origin or patch_path == binding:
                    expected = f'{module}.{binding}'
                    if patch_path != expected:
                        return {'valid': False, 'reason': f'Patch the dependency at its target use point: {expected}, not {patch_path}. Verify the mock was called.'}
            for use_point in sorted(facts['use_points']):
                if not use_point.startswith(module + '.'):
                    continue
                call = use_point[len(module) + 1:]
                if '.' not in call and (patch_path == call or ('.' not in module and patch_path.endswith('.' + use_point))):
                    return {'valid': False, 'reason': f'Patch the dependency at its target use point: {use_point}, not {patch_path}. Verify the mock was called.'}
                if '.' in call and '.' not in module and patch_path.endswith('.' + use_point):
                    return {'valid': False, 'reason': f'Patch the dependency at its target use point: {use_point}, not {patch_path}. Verify the mock was called.'}
    # Diagnose the same certain test-owned binding failures before generic
    # behavior gates can hide the missing import or local shadowing from Writer.
    failure = definite_test_name_failure(tree, code)
    if failure:
        name = failure['name']
        target_hint = (f'Import the selected target explicitly with `from {module} import {owner or target}` (or call `{module}.{owner or target}`). '
                       if module and name in (target, owner) and failure['reasonCode'] == 'writer-undefined-name' else '')
        reason = (f'Writer binding repair: {name} is undefined or read before its local binding in {failure["method"]}. '
                  + target_hint
                  + _additional_name_feedback(tree, code, failure)
                  + 'Use a distinct mock alias and explicitly import test helpers or source globals at the canonical target module; '
                  'do not change assertions or install a guessed package.')
        if failure['reasonCode'] == 'writer-invalid-name-scope':
            reason = 'Writer binding repair: generated global/local declarations are inconsistent. Revise the test scope before execution.'
        return {'valid': False, **failure, 'repairRole': 'writer',
                'reason': reason}
    if context.get('requireMockBehavior') and not has_mock_behavior(tree, context):
        permitted = (set(facts['use_points']) | set(facts['namespace_points'])) - forbidden
        for use_point in list(permitted):
            if module and use_point.startswith(module + '.'):
                root_call, sep, tail_call = use_point[len(module) + 1:].partition('.')
                if sep and root_call in facts['equivalent']:
                    permitted.add(facts['equivalent'][root_call] + '.' + tail_call)
        unpermitted = [path for path in dict.fromkeys(patch_paths) if path not in permitted]
        extra = ''
        if unpermitted:
            extra += f' Unrecognized or non-use-point patch target(s): {", ".join(unpermitted[:6])}.'
        recognized_namespaces = [path for path in dict.fromkeys(patch_paths) if path in facts['namespace_points']]
        if recognized_namespaces:
            extra += (f' Recognized source-bound dependency namespace(s): {", ".join(recognized_namespaces[:6])}. '
                      'Keep the real target call inside the active patch scope and assert on a source-used member '
                      'of the same controlled mock; setup calls or assertions outside that scope do not prove observation.')
        if permitted:
            extra += f' Direct target use points in {qualified}: {", ".join(sorted(permitted)[:10])}.'
        elif facts['parameters']:
            extra += f' {qualified} has no module-level call use points; pass MagicMock() (or controlled objects) for parameter(s) ({", ".join(facts["parameters"])}) and assert on them.'
        return {'valid': False, 'reason': 'Mock assertion is not proven to observe an explicit target use-point patch or a mock passed to the target.' + extra}
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
