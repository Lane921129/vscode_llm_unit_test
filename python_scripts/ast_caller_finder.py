import sys
import ast
import json
import os

def find_call_sites(func_name: str, project_root: str) -> list:
    """
    掃描 project_root 底下所有 .py 檔案，
    找出所有呼叫 func_name 的地方，並擷取實際傳入的參數。
    """
    results = []
    ignored_dirs = {'__pycache__', '.git', 'node_modules', 'venv', 'env', '.env', '.pytest_cache'}

    for dirpath, dirnames, filenames in os.walk(project_root):
        # 跳過忽略的目錄
        dirnames[:] = [d for d in dirnames if d not in ignored_dirs]
        
        for filename in filenames:
            if not filename.endswith('.py'):
                continue
            filepath = os.path.join(dirpath, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    source = f.read()
                tree = ast.parse(source, filename=filepath)
            except Exception:
                continue

            # 找出這個檔案所在的函式定義（用來標記 caller_func）
            # 建立 line -> enclosing_func 的映射
            func_ranges = []
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    func_ranges.append((node.name, node.lineno, getattr(node, 'end_lineno', node.lineno)))

            def get_enclosing_func(lineno):
                for fname, start, end in func_ranges:
                    if start <= lineno <= end:
                        return fname
                return '<module>'

            # 找所有呼叫點
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue

                called_name = None
                if isinstance(node.func, ast.Name):
                    called_name = node.func.id
                elif isinstance(node.func, ast.Attribute):
                    called_name = node.func.attr

                if called_name != func_name:
                    continue

                # 擷取參數
                args_list = []
                for arg in node.args:
                    args_list.append(ast.unparse(arg) if hasattr(ast, 'unparse') else repr(arg))

                kwargs_dict = {}
                for kw in node.keywords:
                    key = kw.arg or '**'
                    val = ast.unparse(kw.value) if hasattr(ast, 'unparse') else repr(kw.value)
                    kwargs_dict[key] = val

                rel_path = os.path.relpath(filepath, project_root).replace('\\', '/')
                enclosing = get_enclosing_func(node.lineno)

                results.append({
                    "caller_file": rel_path,
                    "caller_func": enclosing,
                    "line": node.lineno,
                    "args": args_list,
                    "kwargs": kwargs_dict
                })

    return results


if __name__ == '__main__':
    if len(sys.argv) == 3:
        func_name = sys.argv[1]
        project_root = sys.argv[2]
        sites = find_call_sites(func_name, project_root)
        print(json.dumps(sites, ensure_ascii=False))
    else:
        print(json.dumps({"error": "Usage: ast_caller_finder.py <func_name> <project_root>"}))
