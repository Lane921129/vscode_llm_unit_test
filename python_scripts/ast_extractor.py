import sys
import ast
import json

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
        
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == func_name:
                args = [arg.arg for arg in node.args.args]
                docstring = ast.get_docstring(node) or ""
                
                # Get calls
                calls = []
                for child in ast.walk(node):
                    if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                        calls.append(child.func.id)
                
                unique_calls = list(set(calls))
                dependencies = []
                for c in unique_calls:
                    if c in imports:
                        dependencies.append({"name": c, "module": imports[c]})
                
                # Get code snippet
                lines = source.split('\n')
                start_idx = getattr(node, 'lineno', 1) - 1
                end_idx = getattr(node, 'end_lineno', len(lines))
                code_snippet = '\n'.join(lines[start_idx:end_idx])
                
                res = {
                    "name": node.name,
                    "args": args,
                    "docstring": docstring,
                    "calls": unique_calls,
                    "dependencies": dependencies,
                    "code": code_snippet
                }
                
                print(json.dumps(res, ensure_ascii=False))
                return
                
        # If not found
        print(json.dumps({"error": "Function not found"}, ensure_ascii=False))
            
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    if len(sys.argv) == 3:
        extract_info(sys.argv[1], sys.argv[2])
