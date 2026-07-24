"""
mock_scaffold_generator.py
為目標函式的外部依賴自動產生 @patch mock 骨架。
用法: python mock_scaffold_generator.py <file_path> <func_name> [trace_result_json]
輸出: JSON { "scaffold": str, "patches": [str], "mock_names": [str] }

scaffold: 含 @patch decorator 的測試方法字串（含 TODO 占位符）
patches: 每個 @patch 的路徑列表
mock_names: 對應的 mock 參數名稱
"""
import sys
import ast
import json
import os


def find_imports(tree: ast.Module) -> dict:
    """回傳 {name: module_path} 的 import 映射"""
    imports = {}
    module_name = ''
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                name = alias.asname if alias.asname else alias.name
                imports[name] = node.module
        elif isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname if alias.asname else alias.name
                imports[name] = alias.name
    return imports


def find_external_calls(func_node, imports: dict) -> list:
    """找出函式中所有呼叫到外部 import 的函式名稱與完整路徑"""
    external_calls = []
    seen = set()
    for node in ast.walk(func_node):
        if isinstance(node, ast.Call):
            call_name = None
            full_path = None
            if isinstance(node.func, ast.Name):
                call_name = node.func.id
                if call_name in imports:
                    full_path = f"{imports[call_name]}.{call_name}"
            elif isinstance(node.func, ast.Attribute):
                obj = node.func.value
                attr = node.func.attr
                if isinstance(obj, ast.Name) and obj.id in imports:
                    full_path = f"{imports[obj.id]}.{attr}"
                    call_name = attr

            if full_path and full_path not in seen:
                seen.add(full_path)
                external_calls.append({
                    "name": call_name,
                    "patch_path": full_path
                })
    return external_calls


def generate_scaffold(file_path: str, func_name: str, trace_result: dict = None) -> dict:
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            source = f.read()
    except Exception as e:
        return {"scaffold": "", "patches": [], "mock_names": [], "error": str(e)}

    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"scaffold": "", "patches": [], "mock_names": [], "error": str(e)}

    # 找目標函式
    target_func = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            target_func = node
            break

    if not target_func:
        return {"scaffold": "", "patches": [], "mock_names": [], "error": f"Function '{func_name}' not found"}

    # 找 import 映射
    imports = find_imports(tree)

    # 找外部呼叫
    external_calls = find_external_calls(target_func, imports)

    # 取得函式參數名稱
    func_params = [arg.arg for arg in target_func.args.args]

    # 建立 patch decorator 列表
    patches = [ec["patch_path"] for ec in external_calls]
    mock_names = [f"mock_{ec['name']}" for ec in external_calls]

    # 從 trace_result 取得真實回傳值
    return_value_hints = []
    if trace_result and trace_result.get("examples"):
        for ex in trace_result["examples"][:2]:
            return_value_hints.append(f"# Real return: {ex['result']}")

    # 建立 scaffold 字串
    lines = []

    # @patch decorators（倒序，因為 Python decorator 執行順序是由內到外）
    for patch_path in reversed(patches):
        lines.append(f"@patch('{patch_path}')")

    # 方法簽章（加上 mock 參數）
    mock_param_str = ", ".join(["self"] + list(reversed(mock_names)))
    lines.append(f"def test_{func_name}({mock_param_str}):")

    # Mock return value hints
    for mock_name, ec in zip(mock_names, external_calls):
        hint = return_value_hints[0] if return_value_hints else "# set appropriate return value"
        lines.append(f"    {mock_name}.return_value = None  {hint}")

    lines.append(f"")

    # TODO: 參數設定、呼叫、斷言
    if func_params:
        for param in func_params:
            lines.append(f"    {param} = None  # TODO: set appropriate test value for '{param}'")
        lines.append(f"")

    call_args = ", ".join(func_params)
    lines.append(f"    result = {func_name}({call_args})")
    lines.append(f"    # TODO: add assertions here")
    lines.append(f"    # Example: self.assertEqual(result, expected_value)")

    scaffold = "\n".join(lines)

    return {
        "scaffold": scaffold,
        "patches": patches,
        "mock_names": mock_names,
        "func_params": func_params
    }


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({"scaffold": "", "patches": [], "mock_names": [], "error": "Usage: mock_scaffold_generator.py <file_path> <func_name> [trace_json]"}))
        sys.exit(1)

    file_path = sys.argv[1]
    func_name = sys.argv[2]
    trace_result = None
    if len(sys.argv) >= 4:
        try:
            trace_result = json.loads(sys.argv[3])
        except Exception:
            pass

    result = generate_scaffold(file_path, func_name, trace_result)
    print(json.dumps(result, ensure_ascii=False))
