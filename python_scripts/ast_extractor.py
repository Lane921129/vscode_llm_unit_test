import ast
import json
import sys


def unparse(node):
    return ast.unparse(node) if hasattr(ast, 'unparse') else ast.dump(node)


def source_for(lines, node):
    start = getattr(node, 'lineno', 1) - 1
    end = getattr(node, 'end_lineno', start + 1)
    return '\n'.join(lines[start:end])


def find_function_in_tree(tree, func_name):
    """Prefer module functions, then class methods, then nested functions."""
    if '.' in func_name:
        class_name, method_name = func_name.rsplit('.', 1)
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name == class_name:
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == method_name:
                        return item, node.name, node
        return None, None, None
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            return node, None, None
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == func_name:
                    return item, node.name, node
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            return node, None, None
    return None, None, None


def assignment_names(node):
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        return [target.id for target in targets if isinstance(target, ast.Name)]
    return []


def bound_names(node):
    """Return names bound by an assignment-like target without guessing scope."""
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, (ast.Tuple, ast.List)):
        names = set()
        for item in node.elts:
            names.update(bound_names(item))
        return names
    if isinstance(node, ast.Starred):
        return bound_names(node.value)
    return set()


def function_scope_bindings(func_node):
    """Names which shadow module bindings throughout this function's scope.

    Python decides whether a name is local for the whole function, not merely
    after its assignment line. Nested callable scopes and comprehension targets
    are deliberately excluded from the surrounding function's binding set.
    """
    arguments = (
        list(func_node.args.posonlyargs) + list(func_node.args.args)
        + list(func_node.args.kwonlyargs)
        + ([func_node.args.vararg] if func_node.args.vararg else [])
        + ([func_node.args.kwarg] if func_node.args.kwarg else [])
    )
    bindings = {argument.arg for argument in arguments if argument is not None}
    declared_global, declared_nonlocal = set(), set()

    class BindingVisitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            if node is not func_node:
                bindings.add(node.name)
                return
            self.generic_visit(node)

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_Lambda(self, node):
            return

        def visit_ClassDef(self, node):
            bindings.add(node.name)

        def visit_Global(self, node):
            declared_global.update(node.names)

        def visit_Nonlocal(self, node):
            declared_nonlocal.update(node.names)

        def visit_Assign(self, node):
            for target in node.targets:
                bindings.update(bound_names(target))
            self.generic_visit(node)

        def visit_AnnAssign(self, node):
            bindings.update(bound_names(node.target))
            self.generic_visit(node)

        def visit_AugAssign(self, node):
            bindings.update(bound_names(node.target))
            self.generic_visit(node)

        def visit_NamedExpr(self, node):
            bindings.update(bound_names(node.target))
            self.generic_visit(node)

        def visit_For(self, node):
            bindings.update(bound_names(node.target))
            self.generic_visit(node)

        visit_AsyncFor = visit_For

        def visit_With(self, node):
            for item in node.items:
                if item.optional_vars:
                    bindings.update(bound_names(item.optional_vars))
            self.generic_visit(node)

        visit_AsyncWith = visit_With

        def visit_ExceptHandler(self, node):
            if node.name:
                bindings.add(node.name)
            self.generic_visit(node)

        def visit_Import(self, node):
            for alias in node.names:
                bindings.add(alias.asname or alias.name.split('.')[0])

        def visit_ImportFrom(self, node):
            for alias in node.names:
                if alias.name != '*':
                    bindings.add(alias.asname or alias.name)

    BindingVisitor().visit(func_node)
    # ``global`` resolves to a module name, while ``nonlocal`` resolves to an
    # enclosing function. Neither can prove use of the current module context.
    bindings.difference_update(declared_global)
    bindings.update(declared_nonlocal)
    return bindings


def function_scope_usage(func_node, local_bindings):
    """Collect calls and global loads with Python lexical scopes respected."""
    calls, loaded_names, imported_call_roots = [], set(), set()
    shadow_scopes = [set(local_bindings)]

    def is_shadowed(name):
        return any(name in scope for scope in reversed(shadow_scopes))

    class UsageVisitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            if node is not func_node:
                return
            self.generic_visit(node)

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_Lambda(self, node):
            return

        def visit_ClassDef(self, node):
            return

        def visit_Name(self, node):
            if isinstance(node.ctx, ast.Load) and not is_shadowed(node.id):
                loaded_names.add(node.id)

        def visit_Call(self, node):
            call = attribute_name(node.func)
            calls.append(call)
            root = call.split('.')[0]
            if not is_shadowed(root):
                imported_call_roots.add(root)
            self.generic_visit(node)

        def visit_ListComp(self, node):
            self.visit_comprehension_expression(node.generators, node.elt)

        def visit_SetComp(self, node):
            self.visit_comprehension_expression(node.generators, node.elt)

        def visit_GeneratorExp(self, node):
            self.visit_comprehension_expression(node.generators, node.elt)

        def visit_DictComp(self, node):
            self.visit_comprehension_expression(node.generators, (node.key, node.value))

        def visit_comprehension_expression(self, generators, result_nodes):
            # Comprehension targets have their own implicit scope. Each
            # iterable is evaluated before its own target is bound, while later
            # iterables, filters and the result can use earlier targets.
            shadow_scopes.append(set())
            try:
                for generator in generators:
                    self.visit(generator.iter)
                    shadow_scopes[-1].update(bound_names(generator.target))
                    for condition in generator.ifs:
                        self.visit(condition)
                if isinstance(result_nodes, tuple):
                    for node in result_nodes:
                        self.visit(node)
                else:
                    self.visit(result_nodes)
            finally:
                shadow_scopes.pop()

    visitor = UsageVisitor()
    for statement in func_node.body:
        visitor.visit(statement)
    return calls, loaded_names, imported_call_roots


def attribute_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = attribute_name(node.value)
        return f'{base}.{node.attr}' if base else node.attr
    return unparse(node)


def extract_parameters(arguments, excluded_names=None):
    """Preserve required/default/keyword-only information for safe test calls."""
    excluded = set(excluded_names or [])
    parameters = []
    positional = list(arguments.posonlyargs) + list(arguments.args)
    defaults = [None] * (len(positional) - len(arguments.defaults)) + list(arguments.defaults)
    posonly_count = len(arguments.posonlyargs)
    for index, (arg, default) in enumerate(zip(positional, defaults)):
        if arg.arg in excluded:
            continue
        parameters.append({
            'name': arg.arg,
            'kind': 'positional_only' if index < posonly_count else 'positional_or_keyword',
            'annotation': unparse(arg.annotation) if arg.annotation else None,
            'default': unparse(default) if default is not None else None,
            'required': default is None,
        })
    for arg, default in zip(arguments.kwonlyargs, arguments.kw_defaults):
        if arg.arg in excluded:
            continue
        parameters.append({
            'name': arg.arg,
            'kind': 'keyword_only',
            'annotation': unparse(arg.annotation) if arg.annotation else None,
            'default': unparse(default) if default is not None else None,
            'required': default is None,
        })
    if arguments.vararg and arguments.vararg.arg not in excluded:
        parameters.append({
            'name': arguments.vararg.arg,
            'kind': 'var_positional',
            'annotation': unparse(arguments.vararg.annotation) if arguments.vararg.annotation else None,
            'default': None,
            'required': False,
        })
    if arguments.kwarg and arguments.kwarg.arg not in excluded:
        parameters.append({
            'name': arguments.kwarg.arg,
            'kind': 'var_keyword',
            'annotation': unparse(arguments.kwarg.annotation) if arguments.kwarg.annotation else None,
            'default': None,
            'required': False,
        })
    return parameters


def extract_class_context(class_node, lines, local_classes=None):
    if class_node is None:
        return None
    attrs, init_assigns, init_params, init_signature = [], [], [], []
    for item in class_node.body:
        if isinstance(item, (ast.Assign, ast.AnnAssign)):
            for name in assignment_names(item):
                attrs.append({'name': name, 'code': source_for(lines, item)})
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == '__init__':
            init_signature = extract_parameters(item.args, ('self', 'cls'))
            init_params = [param['name'] for param in init_signature]
            def visit_init_statement(node):
                # A nested helper has its own execution scope. Its assignments
                # are not constructor state and must not become test setup facts.
                if node is not item and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                    return
                if isinstance(node, (ast.Assign, ast.AnnAssign)):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for target in targets:
                        if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == 'self':
                            init_assigns.append({'name': target.attr, 'code': source_for(lines, node)})
                for child in ast.iter_child_nodes(node):
                    visit_init_statement(child)
            for statement in item.body:
                visit_init_statement(statement)
    context = {
        'name': class_node.name,
        'bases': [unparse(base) for base in class_node.bases],
        'class_attrs': attrs,
        'init': {
            'params': init_params,
            'required_params': [param['name'] for param in init_signature if param['required']],
            'optional_params': [param['name'] for param in init_signature if not param['required']],
            'signature': init_signature,
            'assigns': init_assigns,
        }
    }
    if local_classes:
        inherited_context = extract_local_inheritance_context(class_node, local_classes, lines)
        context['inherited_context'] = inherited_context
        effective_init_owner = resolve_effective_local_init_owner(class_node, local_classes)
        if effective_init_owner is not None:
            owner_context = extract_class_context(effective_init_owner, lines)
            context['effective_init'] = {
                'defined_on': effective_init_owner.name,
                **owner_context['init'],
            }
    return context


def local_base_classes(class_node, local_classes):
    """Return source-local simple base classes without guessing imports or MRO."""
    bases = []
    for base in class_node.bases:
        if isinstance(base, ast.Name) and base.id in local_classes:
            bases.append(local_classes[base.id])
    return bases


def extract_local_inheritance_context(class_node, local_classes, lines):
    """Expose bounded source setup inherited from classes in the same module.

    This is setup context for a model, not proof that a constructor call is
    safe. Imported bases, dynamic bases and arbitrary MRO manipulation remain
    intentionally unresolved.
    """
    ancestors, seen = [], {class_node.name}

    def visit(node):
        for base_node in local_base_classes(node, local_classes):
            if base_node.name in seen:
                continue
            seen.add(base_node.name)
            base_context = extract_class_context(base_node, lines)
            ancestors.append({
                'name': base_context['name'],
                'bases': base_context['bases'],
                'class_attrs': base_context['class_attrs'],
                'init': base_context['init'],
            })
            visit(base_node)

    visit(class_node)
    return ancestors


def resolve_effective_local_init_owner(class_node, local_classes, seen=None):
    """Find a conservative source-local inherited ``__init__`` owner.

    Only plain local inheritance is followed. A decorated class, class keyword
    (for example a metaclass), imported base or cycle may alter construction
    semantics, so no effective signature is claimed in those cases.
    """
    seen = set() if seen is None else seen
    if class_node.name in seen:
        return None
    seen.add(class_node.name)
    if any(isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == '__init__'
           for item in class_node.body):
        return class_node
    if class_node.decorator_list or class_node.keywords:
        return None
    for base_node in local_base_classes(class_node, local_classes):
        owner = resolve_effective_local_init_owner(base_node, local_classes, seen)
        if owner is not None:
            return owner
    return None


def method_kind(func_node, class_node):
    """Describe how a class member is bound so callers need not guess."""
    if class_node is None:
        return 'module'
    decorators = {attribute_name(decorator) for decorator in func_node.decorator_list}
    if any(
        decorator == 'property'
        or decorator.endswith('.getter')
        or decorator.endswith('.setter')
        or decorator.endswith('.deleter')
        or decorator.endswith('cached_property')
        for decorator in decorators
    ):
        return 'property'
    if 'staticmethod' in decorators:
        return 'static'
    if 'classmethod' in decorators:
        return 'class'
    return 'instance'


def extract_property_context(class_node, lines, property_name):
    """Return accessor relationships for a selected Python descriptor."""
    if class_node is None:
        return None
    accessors = {}
    for item in class_node.body:
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        decorators = [attribute_name(decorator) for decorator in item.decorator_list]
        accessor_kind = None
        name = item.name
        if any(decorator == 'property' or decorator.endswith('cached_property') for decorator in decorators):
            accessor_kind = 'getter'
        else:
            for decorator in decorators:
                for suffix, kind in (('.getter', 'getter'), ('.setter', 'setter'), ('.deleter', 'deleter')):
                    if decorator.endswith(suffix):
                        name = decorator[:-len(suffix)]
                        accessor_kind = kind
                        break
                if accessor_kind:
                    break
        if not accessor_kind:
            continue
        descriptor = accessors.setdefault(name, {'name': name, 'getter': None, 'setter': None, 'deleter': None})
        descriptor[accessor_kind] = {
            'signature': extract_parameters(item.args, ('self', 'cls')),
            'is_async': isinstance(item, ast.AsyncFunctionDef),
            'code': source_for(lines, item),
        }
    return accessors.get(property_name)


def executable_body_lines(func_node):
    """Return statement lines inside the target body, excluding nested callables.

    The list is used only to decide whether coverage executed any target-body
    statement.  Decorator and definition lines are intentionally excluded:
    importing a module executes those lines without exercising the function.
    """
    result = set()

    def visit(node):
        if node is not func_node and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return
        if node is not func_node and isinstance(node, ast.stmt) and hasattr(node, 'lineno'):
            result.add(node.lineno)
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in func_node.body:
        visit(statement)
    return sorted(result)


def raised_exception_names(func_node):
    """Return explicit exception classes raised by the selected callable.

    Nested callables are excluded because their errors are not necessarily
    observable when exercising the selected function itself.
    """
    names = []

    def visit(node):
        if node is not func_node and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return
        if isinstance(node, ast.Raise) and node.exc is not None:
            exception = node.exc.func if isinstance(node.exc, ast.Call) else node.exc
            if isinstance(exception, (ast.Name, ast.Attribute)):
                names.append(attribute_name(exception))
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in func_node.body:
        visit(statement)
    return list(dict.fromkeys(names))


def is_generator_function(func_node):
    """Whether the selected callable itself yields values.

    A nested helper's yield does not make its enclosing callable a generator,
    so nested scopes are intentionally excluded.
    """
    found = False

    def visit(node):
        nonlocal found
        if found:
            return
        if node is not func_node and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return
        if isinstance(node, (ast.Yield, ast.YieldFrom)):
            found = True
            return
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in func_node.body:
        visit(statement)
    return found


def branch_condition_facts(func_node, parameter_names):
    """Return only direct, source-verifiable branch comparisons.

    These facts deliberately describe *conditions*, not expected results.  A
    test planner can use them to choose inputs on both sides of a condition,
    while assertions must still be justified by source code or real tracing.
    Calls such as ``validator(value)`` and nested callables are excluded: their
    semantics cannot be safely inferred from the selected function alone.
    """
    facts = []
    seen = set()

    def scalar_literal(node):
        try:
            value = ast.literal_eval(node)
        except (ValueError, TypeError):
            return None
        if isinstance(value, (str, int, float, bool)) or value is None:
            return repr(value)
        return None

    def compared_parameter(node):
        if isinstance(node, ast.Name) and node.id in parameter_names:
            return node.id, 'value'
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == 'len'
            and len(node.args) == 1
            and not node.keywords
            and isinstance(node.args[0], ast.Name)
            and node.args[0].id in parameter_names
        ):
            return node.args[0].id, 'length'
        return None, None

    def is_scalar_literal_node(node):
        literal = scalar_literal(node)
        return literal is not None or (isinstance(node, ast.Constant) and node.value is None)

    def reversed_operator(operator):
        """Normalise ``literal OP parameter`` into parameter-first form."""
        reverse = {
            ast.Lt: ast.Gt,
            ast.LtE: ast.GtE,
            ast.Gt: ast.Lt,
            ast.GtE: ast.LtE,
            ast.Eq: ast.Eq,
            ast.NotEq: ast.NotEq,
            ast.Is: ast.Is,
            ast.IsNot: ast.IsNot,
        }
        operator_type = reverse.get(type(operator))
        return operator_type() if operator_type else None

    def membership_literals(node):
        if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return None
        values = []
        for item in node.elts:
            if not is_scalar_literal_node(item):
                return None
            values.append(scalar_literal(item))
        return values

    def match_literals(match_node):
        match_value = getattr(ast, 'MatchValue', ())
        match_singleton = getattr(ast, 'MatchSingleton', ())
        match_or = getattr(ast, 'MatchOr', ())

        def pattern_values(pattern):
            if match_value and isinstance(pattern, match_value):
                return [scalar_literal(pattern.value)] if is_scalar_literal_node(pattern.value) else []
            if match_singleton and isinstance(pattern, match_singleton):
                return [repr(pattern.value)]
            if match_or and isinstance(pattern, match_or):
                values = []
                for nested in pattern.patterns:
                    values.extend(pattern_values(nested))
                return values
            return []

        values = []
        for case in match_node.cases:
            # A guard may rely on runtime state, so its literal pattern alone
            # is not a safe branch-input fact.
            if case.guard is None:
                values.extend(pattern_values(case.pattern))
        return list(dict.fromkeys(values))

    def visit(node):
        if node is not func_node and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return
        match_type = getattr(ast, 'Match', ())
        if match_type and isinstance(node, match_type):
            parameter, subject = compared_parameter(node.subject)
            values = match_literals(node) if parameter and subject == 'value' else []
            if values:
                fact = {
                    'kind': 'match', 'parameter': parameter, 'subject': subject,
                    'literals': values, 'line': node.lineno,
                }
                identity = tuple(sorted((key, tuple(value) if isinstance(value, list) else value)
                                        for key, value in fact.items()))
                if identity not in seen:
                    facts.append(fact)
                    seen.add(identity)
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
            operator = node.ops[0]
            parameter, subject = compared_parameter(node.left)
            comparator = node.comparators[0]
            if parameter and isinstance(operator, (ast.In, ast.NotIn)) and subject == 'value':
                values = membership_literals(comparator)
                if values is not None:
                    fact = {
                        'kind': 'membership',
                        'parameter': parameter,
                        'subject': subject,
                        'operator': type(operator).__name__,
                        'literals': values,
                        'line': node.lineno,
                    }
                    identity = tuple(sorted((key, tuple(value) if isinstance(value, list) else value)
                                            for key, value in fact.items()))
                    if identity not in seen:
                        facts.append(fact)
                        seen.add(identity)
                return
            if not parameter:
                parameter, subject = compared_parameter(comparator)
                if parameter and is_scalar_literal_node(node.left):
                    operator = reversed_operator(operator)
                    comparator = node.left
                else:
                    parameter = None
            literal = scalar_literal(comparator)
            if parameter and operator and is_scalar_literal_node(comparator):
                fact = {
                    'kind': 'comparison',
                    'parameter': parameter,
                    'subject': subject,
                    'operator': type(operator).__name__,
                    'literal': literal,
                    'line': node.lineno,
                }
                identity = tuple(sorted(fact.items()))
                if identity not in seen:
                    facts.append(fact)
                    seen.add(identity)
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in func_node.body:
        visit(statement)
    return facts


def extract_info(filepath, func_name):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            source = f.read()
        lines = source.split('\n')
        tree = ast.parse(source, filename=filepath)
        local_classes = {
            node.name: node for node in tree.body
            if isinstance(node, ast.ClassDef)
        }

        file_imports, imported_symbols, module_globals = [], {}, {}
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    bound = alias.asname or alias.name.split('.')[0]
                    file_imports.append({'kind': 'import', 'module': alias.name, 'name': None, 'alias': alias.asname, 'bound_name': bound})
                    imported_symbols[bound] = {'name': bound, 'module': alias.name}
            elif isinstance(node, ast.ImportFrom) and (node.module or node.level):
                imported_module = node.module or ''
                for alias in node.names:
                    bound = alias.asname or alias.name
                    file_imports.append({
                        'kind': 'from',
                        'module': imported_module,
                        'level': node.level,
                        'name': alias.name,
                        'alias': alias.asname,
                        'bound_name': bound
                    })
                    imported_symbols[bound] = {
                        'name': alias.name,
                        'module': imported_module,
                        'level': node.level
                    }
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                for name in assignment_names(node):
                    module_globals[name] = {'name': name, 'code': source_for(lines, node)}

        func_node, class_name, class_node = find_function_in_tree(tree, func_name)
        if func_node is None:
            print(json.dumps({'error': 'Function not found'}, ensure_ascii=False))
            return

        signature = extract_parameters(func_node.args, ('self', 'cls') if class_name is not None else ())
        args = [param['name'] for param in signature]
        local_bindings = function_scope_bindings(func_node)
        calls, loaded_names, imported_call_roots = function_scope_usage(func_node, local_bindings)
        unique_calls = list(dict.fromkeys(calls))

        dependencies, seen_dependencies = [], set()
        for call in unique_calls:
            root = call.split('.')[0]
            symbol = imported_symbols.get(root) if root in imported_call_roots else None
            if symbol:
                key = (symbol['module'], symbol['name'], symbol.get('level', 0))
                if key not in seen_dependencies:
                    dependencies.append({
                        'name': symbol['name'],
                        'module': symbol['module'],
                        'level': symbol.get('level', 0)
                    })
                    seen_dependencies.add(key)

        referenced_globals = [module_globals[name] for name in sorted(loaded_names & module_globals.keys())]

        print(json.dumps({
            'name': func_node.name,
            'args': args,
            'signature': signature,
            'required_args': [param['name'] for param in signature if param['required']],
            'docstring': ast.get_docstring(func_node) or '',
            'calls': unique_calls,
            'dependencies': dependencies,
            'file_imports': file_imports,
            'referenced_globals': referenced_globals,
            'class_name': class_name,
            'class_context': extract_class_context(class_node, lines, local_classes),
            'method_kind': method_kind(func_node, class_node),
            'property_context': extract_property_context(class_node, lines, func_node.name),
            'is_async': isinstance(func_node, ast.AsyncFunctionDef),
            'is_generator': is_generator_function(func_node),
            'executable_lines': executable_body_lines(func_node),
            'raised_exceptions': raised_exception_names(func_node),
            'condition_facts': branch_condition_facts(func_node, set(args)),
            'code': source_for(lines, func_node)
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))


if __name__ == '__main__' and len(sys.argv) == 3:
    extract_info(sys.argv[1], sys.argv[2])
