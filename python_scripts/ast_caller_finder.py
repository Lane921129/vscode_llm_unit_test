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


def find_call_sites(func_name, project_root, target_path=None):
    """Find calls resolving to the supplied target module; avoid same-name collisions."""
    results = []
    ignored_dirs = {'__pycache__', '.git', 'node_modules', 'venv', 'env', '.env', '.pytest_cache'}
    target_absolute = os.path.abspath(target_path) if target_path else None
    target_module = target_module_name(target_absolute, project_root) if target_absolute else None

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

            direct_names, module_aliases = set(), set()
            if target_module:
                for node in tree.body:
                    if isinstance(node, ast.ImportFrom) and node.module and module_matches(node.module, target_module):
                        for alias in node.names:
                            if alias.name in (func_name, '*'):
                                direct_names.add(alias.asname or alias.name)
                    elif isinstance(node, ast.Import):
                        for alias in node.names:
                            if module_matches(alias.name, target_module):
                                module_aliases.add(alias.asname or alias.name.split('.')[0])

            func_ranges = [(node.name, node.lineno, getattr(node, 'end_lineno', node.lineno))
                           for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]

            def enclosing_func(lineno):
                containing = [item for item in func_ranges if item[1] <= lineno <= item[2]]
                return min(containing, key=lambda item: item[2] - item[1])[0] if containing else '<module>'

            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                direct_call = isinstance(node.func, ast.Name) and (node.func.id == func_name or node.func.id in direct_names)
                attribute_call = isinstance(node.func, ast.Attribute) and node.func.attr == func_name
                if not (direct_call or attribute_call):
                    continue

                is_target_call = not target_module or os.path.abspath(filepath) == target_absolute
                if target_module and direct_call:
                    is_target_call = is_target_call or node.func.id in direct_names
                if target_module and attribute_call and isinstance(node.func.value, ast.Name):
                    is_target_call = is_target_call or node.func.value.id in module_aliases
                if not is_target_call:
                    continue

                args_list = [ast.unparse(arg) if hasattr(ast, 'unparse') else repr(arg) for arg in node.args]
                kwargs_dict = {(kw.arg or '**'): (ast.unparse(kw.value) if hasattr(ast, 'unparse') else repr(kw.value)) for kw in node.keywords}
                results.append({
                    'caller_file': os.path.relpath(filepath, project_root).replace('\\', '/'),
                    'caller_func': enclosing_func(node.lineno),
                    'line': node.lineno,
                    'args': args_list,
                    'kwargs': kwargs_dict,
                    'call_expr': ast.unparse(node) if hasattr(ast, 'unparse') else func_name
                })
    return results


if __name__ == '__main__':
    if len(sys.argv) in (3, 4):
        target = sys.argv[3] if len(sys.argv) == 4 else None
        print(json.dumps(find_call_sites(sys.argv[1], sys.argv[2], target), ensure_ascii=False))
    else:
        print(json.dumps({'error': 'Usage: ast_caller_finder.py <func_name> <project_root> [target_path]'}))
