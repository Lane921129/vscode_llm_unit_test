import sys
import ast
import json


def find_function_in_tree(tree, func_name):
    """
    搜尋 AST，優先回傳頂層函式；若找不到，則搜尋所有 class 內的 method。
    回傳 (func_node, class_name_or_None)
    """
    # 第一優先：頂層函式
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            return node, None

    # 第二優先：class 內的 method
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == func_name:
                    return item, node.name

    # 最後：全樹搜尋（巢狀函式等邊緣情況）
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            return node, None

    return None, None


def extract_info(filepath, func_name):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            source = f.read()

        tree = ast.parse(source)

        imports = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    imports[alias.name] = node.module

        func_node, class_name = find_function_in_tree(tree, func_name)

        if func_node is None:
            print(json.dumps({"error": "Function not found"}, ensure_ascii=False))
            return

        # 取得參數列表（若在 class 內，去除 self/cls）
        raw_args = [arg.arg for arg in func_node.args.args]
        if class_name is not None:
            # 去除 self / cls
            args = [a for a in raw_args if a not in ('self', 'cls')]
        else:
            args = raw_args

        docstring = ast.get_docstring(func_node) or ""

        # Get calls
        calls = []
        for child in ast.walk(func_node):
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                calls.append(child.func.id)

        unique_calls = list(set(calls))
        dependencies = []
        for c in unique_calls:
            if c in imports:
                dependencies.append({"name": c, "module": imports[c]})

        # Get code snippet
        lines = source.split('\n')
        start_idx = getattr(func_node, 'lineno', 1) - 1
        end_idx = getattr(func_node, 'end_lineno', len(lines))
        code_snippet = '\n'.join(lines[start_idx:end_idx])

        res = {
            "name": func_node.name,
            "args": args,
            "docstring": docstring,
            "calls": unique_calls,
            "dependencies": dependencies,
            "code": code_snippet,
            "class_name": class_name  # None 表示頂層函式
        }

        print(json.dumps(res, ensure_ascii=False))
        return

    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    if len(sys.argv) == 3:
        extract_info(sys.argv[1], sys.argv[2])
