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


def extract_class_context(class_node, lines):
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
            for node in ast.walk(item):
                if isinstance(node, (ast.Assign, ast.AnnAssign)):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    for target in targets:
                        if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == 'self':
                            init_assigns.append({'name': target.attr, 'code': source_for(lines, node)})
    return {
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


def extract_info(filepath, func_name):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            source = f.read()
        lines = source.split('\n')
        tree = ast.parse(source, filename=filepath)

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
        calls = [attribute_name(child.func) for child in ast.walk(func_node) if isinstance(child, ast.Call)]
        unique_calls = list(dict.fromkeys(calls))

        dependencies, seen_dependencies = [], set()
        for call in unique_calls:
            symbol = imported_symbols.get(call.split('.')[0])
            if symbol:
                key = (symbol['module'], symbol['name'], symbol.get('level', 0))
                if key not in seen_dependencies:
                    dependencies.append({
                        'name': symbol['name'],
                        'module': symbol['module'],
                        'level': symbol.get('level', 0)
                    })
                    seen_dependencies.add(key)

        loaded_names = {node.id for node in ast.walk(func_node) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}
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
            'class_context': extract_class_context(class_node, lines),
            'method_kind': method_kind(func_node, class_node),
            'property_context': extract_property_context(class_node, lines, func_node.name),
            'is_async': isinstance(func_node, ast.AsyncFunctionDef),
            'executable_lines': executable_body_lines(func_node),
            'raised_exceptions': raised_exception_names(func_node),
            'code': source_for(lines, func_node)
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))


if __name__ == '__main__' and len(sys.argv) == 3:
    extract_info(sys.argv[1], sys.argv[2])
