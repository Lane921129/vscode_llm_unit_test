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


def relative_import_package(node, caller_path, project_root):
    """Return the package a relative ``ImportFrom`` starts from, if safe."""
    if not isinstance(node, ast.ImportFrom) or not node.level:
        return None
    package_dir = os.path.dirname(os.path.abspath(caller_path))
    checked_dir = package_dir
    # Relative imports are valid only in packages. Check every parent crossed
    # instead of guessing from folders that merely share a module name.
    for _ in range(node.level):
        if not os.path.isfile(os.path.join(checked_dir, '__init__.py')):
            return None
        checked_dir = os.path.dirname(checked_dir)
    base_dir = package_dir
    for _ in range(node.level - 1):
        base_dir = os.path.dirname(base_dir)
    relative = os.path.relpath(base_dir, project_root)
    if relative == os.pardir or relative.startswith(os.pardir + os.sep):
        return None
    return '' if relative in ('.', '') else relative.replace('\\', '/').replace('/', '.')


def resolved_import_from_module(node, caller_path, project_root):
    """Resolve an ``ImportFrom`` module relative to the caller package.

    ``ast.ImportFrom.module`` omits leading dots.  For example,
    ``from .consumer import format_label`` exposes only ``consumer``.  Resolve
    it before comparison so a same-named module in another package is never
    treated as a caller of the selected target.
    """
    if not isinstance(node, ast.ImportFrom) or not node.module:
        return None
    if not node.level:
        return node.module
    package = relative_import_package(node, caller_path, project_root)
    return '.'.join(part for part in (package, node.module) if part)


def resolved_relative_import_alias_module(node, alias, caller_path, project_root):
    """Resolve ``from . import module`` aliases used as module references.

    The empty ``ImportFrom.module`` form imports a package member.  Treat it
    as a target module only when its complete resolved name exactly matches
    the known target; other package attributes remain intentionally unknown.
    """
    if not isinstance(node, ast.ImportFrom) or node.module or not node.level:
        return None
    package = relative_import_package(node, caller_path, project_root)
    if package is None or not alias.name or alias.name == '*':
        return None
    return '.'.join(part for part in (package, alias.name) if part)


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


def target_names_in(node):
    """Return simple names bound by an assignment-like target."""
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, (ast.Tuple, ast.List)):
        return {name for item in node.elts for name in target_names_in(item)}
    if isinstance(node, ast.Starred):
        return target_names_in(node.value)
    return set()


class ScopeBindingCollector(ast.NodeVisitor):
    """Collect names bound in one lexical scope without entering child scopes."""

    def __init__(self, selected_name=None, selected_is_target=False):
        self.bindings = {}
        self.global_names = set()
        self.nonlocal_names = set()
        self.selected_name = selected_name
        self.selected_is_target = selected_is_target

    def bind(self, name, line, is_target=False):
        self.bindings.setdefault(name, []).append((line, is_target))

    def bind_targets(self, targets, line):
        for target in targets:
            for name in target_names_in(target):
                self.bind(name, line)

    def visit_Global(self, node):
        self.global_names.update(node.names)

    def visit_Nonlocal(self, node):
        self.nonlocal_names.update(node.names)

    def visit_Assign(self, node):
        self.bind_targets(node.targets, node.lineno)
        self.visit(node.value)

    def visit_AnnAssign(self, node):
        self.bind_targets([node.target], node.lineno)
        if node.value:
            self.visit(node.value)

    def visit_AugAssign(self, node):
        self.bind_targets([node.target], node.lineno)
        self.visit(node.value)

    def visit_NamedExpr(self, node):
        self.bind_targets([node.target], node.lineno)
        self.visit(node.value)

    def visit_For(self, node):
        self.bind_targets([node.target], node.lineno)
        self.generic_visit(node)

    visit_AsyncFor = visit_For

    def visit_With(self, node):
        for item in node.items:
            if item.optional_vars:
                self.bind_targets([item.optional_vars], node.lineno)
        self.generic_visit(node)

    visit_AsyncWith = visit_With

    def visit_ExceptHandler(self, node):
        if node.name:
            self.bind(node.name, node.lineno)
        self.generic_visit(node)

    def visit_Import(self, node):
        for alias in node.names:
            self.bind(alias.asname or alias.name.split('.')[0], node.lineno)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            if alias.name != '*':
                self.bind(alias.asname or alias.name, node.lineno)

    def visit_FunctionDef(self, node):
        is_target = self.selected_is_target and node.name == self.selected_name
        self.bind(node.name, node.lineno, is_target)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.bind(node.name, node.lineno)


def function_scope_bindings(scope):
    """Return declarations whose Python function scope can shadow imports."""
    collector = ScopeBindingCollector()
    arguments = scope.args
    for argument in (
        list(arguments.posonlyargs) + list(arguments.args) + list(arguments.kwonlyargs)
        + ([arguments.vararg] if arguments.vararg else [])
        + ([arguments.kwarg] if arguments.kwarg else [])
    ):
        collector.bind(argument.arg, scope.lineno)
    for statement in scope.body:
        collector.visit(statement)
    return collector


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
                    imported_module = resolved_import_from_module(node, filepath, project_root)
                    if isinstance(node, ast.ImportFrom) and imported_module and module_matches(imported_module, target_module):
                        for alias in node.names:
                            if target_class and alias.name in target_module_classes:
                                class_aliases.add(alias.asname or alias.name)
                            elif not target_class and alias.name in (func_name, '*'):
                                direct_names.add(alias.asname or alias.name)
                    elif isinstance(node, ast.ImportFrom):
                        for alias in node.names:
                            imported_alias_module = resolved_relative_import_alias_module(
                                node, alias, filepath, project_root
                            )
                            if imported_alias_module and module_matches(imported_alias_module, target_module):
                                module_reference_paths.add((alias.asname or alias.name,))
                    elif isinstance(node, ast.Import):
                        for alias in node.names:
                            if module_matches(alias.name, target_module):
                                module_reference_paths.add(
                                    (alias.asname,) if alias.asname else tuple(alias.name.split('.'))
                                )

            # A direct import is not proof by itself: a function parameter,
            # local assignment or a later module binding can shadow it.  Keep
            # an ordered module-level binding history so a caller is accepted
            # only when its name still resolves to the selected function on
            # that source line.
            module_bindings = ScopeBindingCollector(
                selected_name=func_name,
                selected_is_target=(
                    not target_class and target_absolute is not None
                    and os.path.abspath(filepath) == target_absolute
                )
            )
            for statement in tree.body:
                module_bindings.visit(statement)
            if target_module and not target_class:
                for node in tree.body:
                    imported_module = resolved_import_from_module(node, filepath, project_root)
                    if not isinstance(node, ast.ImportFrom) or not imported_module or not module_matches(imported_module, target_module):
                        continue
                    for alias in node.names:
                        if alias.name == func_name:
                            module_bindings.bind(alias.asname or alias.name, node.lineno, True)
            for bindings in module_bindings.bindings.values():
                bindings.sort(key=lambda item: item[0])

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

            function_bindings = {
                id(scope): function_scope_bindings(scope)
                for scope, _, _ in scope_ranges
                if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef))
            }

            def direct_function_reference(name, line):
                """Whether a name safely resolves to the selected function at line."""
                if not target_module:
                    return name == func_name or name in direct_names

                containing_functions = [
                    item for item in scope_ranges
                    if isinstance(item[0], (ast.FunctionDef, ast.AsyncFunctionDef))
                    and item[1] <= line <= item[2]
                ]
                # Inspect nearest lexical function first.  ``global`` makes
                # the name resolve at module level; ``nonlocal`` or any local
                # binding cannot be proven to be the imported target here.
                for scope, _, _ in sorted(containing_functions, key=lambda item: item[2] - item[1]):
                    declarations = function_bindings[id(scope)]
                    if name in declarations.global_names:
                        # A global assignment in this callable changes the
                        # module binding before this call, but is not part of
                        # the module's static statement history.
                        if name in declarations.bindings:
                            return False
                        break
                    if name in declarations.nonlocal_names or name in declarations.bindings:
                        return False

                bindings = module_bindings.bindings.get(name, [])
                earlier = [binding for binding in bindings if binding[0] <= line]
                return bool(earlier and earlier[-1][1])

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
                    and direct_function_reference(node.func.id, node.lineno)
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
                    is_target_call = True
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
