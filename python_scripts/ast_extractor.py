import sys
import ast
import json

def extract_info(filepath, func_name, output_path):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            source = f.read()
        
        tree = ast.parse(source)
        
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == func_name:
                args = [arg.arg for arg in node.args.args]
                docstring = ast.get_docstring(node) or ""
                
                # Get calls
                calls = []
                for child in ast.walk(node):
                    if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                        calls.append(child.func.id)
                
                # Get code snippet
                lines = source.split('\n')
                # node.lineno is 1-indexed
                # node.end_lineno is 1-indexed
                # If end_lineno is None, just extract to the end (some older python versions issue)
                start_idx = getattr(node, 'lineno', 1) - 1
                end_idx = getattr(node, 'end_lineno', len(lines))
                code_snippet = '\n'.join(lines[start_idx:end_idx])
                
                res = {
                    "name": node.name,
                    "args": args,
                    "docstring": docstring,
                    "calls": list(set(calls)),
                    "code": code_snippet
                }
                
                with open(output_path, 'w', encoding='utf-8') as f:
                    json.dump(res, f, ensure_ascii=False)
                return
                
        # If not found
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump({"error": "Function not found"}, f)
            
    except Exception as e:
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump({"error": str(e)}, f)

if __name__ == '__main__':
    if len(sys.argv) == 4:
        extract_info(sys.argv[1], sys.argv[2], sys.argv[3])
