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


def extract_class_context(class_node, lines):
    if class_node is None:
        return None
    attrs, init_assigns, init_params = [], [], []
    for item in class_node.body:
        if isinstance(item, (ast.Assign, ast.AnnAssign)):
            for name in assignment_names(item):
                attrs.append({'name': name, 'code': source_for(lines, item)})
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == '__init__':
            init_params = [arg.arg for arg in item.args.args if arg.arg not in ('self', 'cls')]
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
        'init': {'params': init_params, 'assigns': init_assigns}
    }


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
            elif isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    bound = alias.asname or alias.name
                    file_imports.append({'kind': 'from', 'module': node.module, 'name': alias.name, 'alias': alias.asname, 'bound_name': bound})
                    imported_symbols[bound] = {'name': alias.name, 'module': node.module}
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                for name in assignment_names(node):
                    module_globals[name] = {'name': name, 'code': source_for(lines, node)}

        func_node, class_name, class_node = find_function_in_tree(tree, func_name)
        if func_node is None:
            print(json.dumps({'error': 'Function not found'}, ensure_ascii=False))
            return

        raw_args = [arg.arg for arg in func_node.args.args]
        args = [arg for arg in raw_args if not (class_name is not None and arg in ('self', 'cls'))]
        calls = [attribute_name(child.func) for child in ast.walk(func_node) if isinstance(child, ast.Call)]
        unique_calls = list(dict.fromkeys(calls))

        dependencies, seen_dependencies = [], set()
        for call in unique_calls:
            symbol = imported_symbols.get(call.split('.')[0])
            if symbol:
                key = (symbol['module'], symbol['name'])
                if key not in seen_dependencies:
                    dependencies.append({'name': symbol['name'], 'module': symbol['module']})
                    seen_dependencies.add(key)

        loaded_names = {node.id for node in ast.walk(func_node) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)}
        referenced_globals = [module_globals[name] for name in sorted(loaded_names & module_globals.keys())]

        print(json.dumps({
            'name': func_node.name,
            'args': args,
            'docstring': ast.get_docstring(func_node) or '',
            'calls': unique_calls,
            'dependencies': dependencies,
            'file_imports': file_imports,
            'referenced_globals': referenced_globals,
            'class_name': class_name,
            'class_context': extract_class_context(class_node, lines),
            'is_async': isinstance(func_node, ast.AsyncFunctionDef),
            'code': source_for(lines, func_node)
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))


if __name__ == '__main__' and len(sys.argv) == 3:
    extract_info(sys.argv[1], sys.argv[2])
