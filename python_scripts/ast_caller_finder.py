import ast
import json
import os
import sys


def module_matches(module, target_module):
    normalized = module.lstrip('.')
    return normalized == target_module or normalized.endswith('.' + target_module)


def target_module_name(target_path, project_root):
    relative = os.path.relpath(target_path, project_root)
    return os.path.splitext(relative)[0].replace(os.sep, '.').replace('/', '.')


def expression_path(node):
    """Return a simple dotted path for names and attributes, when knowable."""
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        parent = expression_path(node.value)
        return parent + [node.attr] if parent else None
    return None


def literal_arguments(call):
    """Extract constructor facts only when every supplied argument is literal."""
    try:
        if any(keyword.arg is None for keyword in call.keywords):
            raise ValueError('**kwargs cannot be safely resolved')
        return (
            [ast.literal_eval(argument) for argument in call.args],
            {keyword.arg: ast.literal_eval(keyword.value) for keyword in call.keywords}
        )
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return None, None


def source_arguments(call):
    """Return source spelling for arguments already confirmed as literals."""
    render = ast.unparse if hasattr(ast, 'unparse') else repr
    return (
        [render(argument) for argument in call.args],
        {(keyword.arg or '**'): render(keyword.value) for keyword in call.keywords}
    )


def class_defines_member(class_node, member_name):
    """Whether a class overrides the selected member in its own body."""
    return any(
        isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == member_name
        for item in class_node.body
    )


def direct_safe_subclasses(tree, target_class, target_member, resolves_target_class):
    """Find classes that can only inherit the selected target member.

    This deliberately accepts just one direct base, no class decorator, and no
    local override.  Python's broader MRO, metaclasses and class decorators
    can alter lookup semantics, so they remain outside of Trace evidence.
    """
    safe_names = {target_class}
    pending = [node for node in tree.body if isinstance(node, ast.ClassDef)]
    changed = True
    while changed:
        changed = False
        for class_node in pending:
            if class_node.name in safe_names or class_node.decorator_list:
                continue
            if len(class_node.bases) != 1 or class_defines_member(class_node, target_member):
                continue
            base = expression_path(class_node.bases[0])
            if not base:
                continue
            if resolves_target_class(base, safe_names):
                safe_names.add(class_node.name)
                changed = True
    return safe_names


def find_call_sites(func_name, project_root, target_path=None):
    """Find calls resolving to the supplied target module; avoid same-name collisions."""
    results = []
    ignored_dirs = {'__pycache__', '.git', 'node_modules', 'venv', 'env', '.env', '.venv', '.pytest_cache'}
    target_absolute = os.path.abspath(target_path) if target_path else None
    target_module = target_module_name(target_absolute, project_root) if target_absolute else None
    target_class, target_member = (func_name.rsplit('.', 1) if '.' in func_name else (None, func_name))
    target_module_classes = {target_class} if target_class else set()

    # A subclass declared beside the selected base can safely supply caller
    # literals for Base.method only when it has the conservative shape below.
    # This keeps dynamic tracing grounded in real call sites without assuming
    # arbitrary inheritance, factories or a modified MRO.
    if target_absolute and target_class:
        try:
            with open(target_absolute, 'r', encoding='utf-8') as handle:
                target_tree = ast.parse(handle.read(), filename=target_absolute)
            target_module_classes = direct_safe_subclasses(
                target_tree,
                target_class,
                target_member,
                lambda path, known: len(path) == 1 and path[0] in known
            )
        except Exception:
            # Caller discovery remains usable for direct class references if a
            # side scan cannot parse the selected target module.
            target_module_classes = {target_class}

    for dirpath, dirnames, filenames in os.walk(project_root):
        dirnames[:] = [d for d in dirnames if d not in ignored_dirs]
        for filename in filenames:
            if not filename.endswith('.py'):
                continue
            filepath = os.path.join(dirpath, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as handle:
                    source = handle.read()
                tree = ast.parse(source, filename=filepath)
            except Exception:
                continue

            direct_names, class_aliases = set(), set()
            # Preserve the actual bound expression path for ``import pkg.mod``.
            # Python binds only ``pkg`` in that form, while a later call uses
            # ``pkg.mod.target(...)``.  A plain alias set cannot distinguish
            # it from an unrelated ``pkg.other`` attribute chain.
            module_reference_paths = set()
            if target_module:
                for node in tree.body:
                    if isinstance(node, ast.ImportFrom) and node.module and module_matches(node.module, target_module):
                        for alias in node.names:
                            if target_class and alias.name in target_module_classes:
                                class_aliases.add(alias.asname or alias.name)
                            elif not target_class and alias.name in (func_name, '*'):
                                direct_names.add(alias.asname or alias.name)
                    elif isinstance(node, ast.Import):
                        for alias in node.names:
                            if module_matches(alias.name, target_module):
                                module_reference_paths.add(
                                    (alias.asname,) if alias.asname else tuple(alias.name.split('.'))
                                )

            func_ranges = [(node.name, node.lineno, getattr(node, 'end_lineno', node.lineno))
                           for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]

            def enclosing_func(lineno):
                containing = [item for item in func_ranges if item[1] <= lineno <= item[2]]
                return min(containing, key=lambda item: item[2] - item[1])[0] if containing else '<module>'

            def is_target_class_reference(node):
                """Resolve a class reference through a direct or module import."""
                path = expression_path(node)
                if not path or not target_class:
                    return False
                return (
                    len(path) == 1 and path[0] in class_aliases
                ) or (
                    len(path) >= 2 and tuple(path[:-1]) in module_reference_paths
                    and path[-1] in target_module_classes
                ) or (
                    target_absolute is not None
                    and os.path.abspath(filepath) == target_absolute
                    and len(path) == 1
                    and path[0] in target_module_classes
                )

            if target_class:
                local_safe_subclasses = direct_safe_subclasses(
                    tree,
                    target_class,
                    target_member,
                    lambda path, known: (
                        len(path) == 1 and path[0] in class_aliases
                    ) or (
                        len(path) >= 2 and tuple(path[:-1]) in module_reference_paths
                        and path[-1] in target_module_classes
                    ) or (
                        target_absolute is not None
                        and os.path.abspath(filepath) == target_absolute
                        and len(path) == 1 and path[0] in known
                    )
                )
                # ``direct_safe_subclasses`` includes the target name as a
                # traversal seed.  It was not necessarily imported in this
                # caller file, so never turn that seed into a class alias.
                class_aliases.update(local_safe_subclasses - {target_class})

            # A variable is evidence of a target instance only when it is
            # assigned directly in the same lexical callable.  This small,
            # syntax-only dataflow pass deliberately does not guess through
            # conditions, factories, attributes or outer scopes.
            scope_ranges = [(tree, 1, float('inf'))]
            scope_ranges.extend(
                (node, node.lineno, getattr(node, 'end_lineno', node.lineno))
                for node in ast.walk(tree)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            )

            def scope_for_line(lineno):
                containing = [item for item in scope_ranges if item[1] <= lineno <= item[2]]
                return min(containing, key=lambda item: item[2] - item[1])[0]

            instance_bindings = {}
            for scope, _, _ in scope_ranges:
                bindings = {}
                for statement in getattr(scope, 'body', []):
                    if not isinstance(statement, (ast.Assign, ast.AnnAssign)):
                        continue
                    targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                    value = statement.value
                    constructor = value if isinstance(value, ast.Call) and is_target_class_reference(value.func) else None
                    for target in targets:
                        if isinstance(target, ast.Name):
                            bindings.setdefault(target.id, []).append((statement.lineno, constructor))
                instance_bindings[id(scope)] = bindings

            def bound_constructor_call(receiver, call_line):
                if not isinstance(receiver, ast.Name):
                    return None
                bindings = instance_bindings.get(id(scope_for_line(call_line)), {}).get(receiver.id, [])
                earlier = [binding for binding in bindings if binding[0] < call_line]
                return earlier[-1][1] if earlier else None

            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                direct_call = (
                    not target_class
                    and isinstance(node.func, ast.Name)
                    and (node.func.id == func_name or node.func.id in direct_names)
                )
                attribute_call = (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == target_member
                )
                if not (direct_call or attribute_call):
                    continue

                is_target_call = not target_module or os.path.abspath(filepath) == target_absolute
                constructor_args, constructor_kwargs = None, None
                constructor_code_args, constructor_code_kwargs = None, None
                if target_class and attribute_call:
                    receiver = node.func.value
                    constructor_call = (
                        receiver if isinstance(receiver, ast.Call) and is_target_class_reference(receiver.func)
                        else bound_constructor_call(receiver, node.lineno)
                    )
                    if constructor_call is not None:
                        is_target_call = True
                        constructor_args, constructor_kwargs = literal_arguments(constructor_call)
                        if constructor_args is not None:
                            constructor_code_args, constructor_code_kwargs = source_arguments(constructor_call)
                    elif is_target_class_reference(receiver):
                        # staticmethod/classmethod called as Class.member(...)
                        is_target_call = True
                    else:
                        is_target_call = False
                elif target_module and direct_call:
                    is_target_call = is_target_call or node.func.id in direct_names
                if not target_class and target_module and attribute_call:
                    module_path = expression_path(node.func.value)
                    is_target_call = is_target_call or (
                        module_path is not None and tuple(module_path) in module_reference_paths
                    )
                if not is_target_call:
                    continue

                args_list = [ast.unparse(arg) if hasattr(ast, 'unparse') else repr(arg) for arg in node.args]
                kwargs_dict = {(kw.arg or '**'): (ast.unparse(kw.value) if hasattr(ast, 'unparse') else repr(kw.value)) for kw in node.keywords}
                trace_args, trace_kwargs = literal_arguments(node)
                results.append({
                    'caller_file': os.path.relpath(filepath, project_root).replace('\\', '/'),
                    'caller_func': enclosing_func(node.lineno),
                    'line': node.lineno,
                    'args': args_list,
                    'kwargs': kwargs_dict,
                    'call_expr': ast.unparse(node) if hasattr(ast, 'unparse') else func_name,
                    'trace_args': trace_args,
                    'trace_kwargs': trace_kwargs,
                    # These facts are deliberately separate from the method
                    # arguments: Dynamic Trace needs them only to construct an
                    # instance, never to call the selected member itself.
                    'trace_constructor_args': constructor_args,
                    'trace_constructor_kwargs': constructor_kwargs,
                    'constructor_args': constructor_code_args,
                    'constructor_kwargs': constructor_code_kwargs
                })
    return results


if __name__ == '__main__':
    if len(sys.argv) in (3, 4):
        target = sys.argv[3] if len(sys.argv) == 4 else None
        print(json.dumps(find_call_sites(sys.argv[1], sys.argv[2], target), ensure_ascii=False))
    else:
        print(json.dumps({'error': 'Usage: ast_caller_finder.py <func_name> <project_root> [target_path]'}))
