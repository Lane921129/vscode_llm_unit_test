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


def find_import_bindings(tree: ast.Module) -> set[str]:
    """回傳在被測模組命名空間中可被 patch 的匯入綁定名稱。"""
    bindings = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                if alias.name != '*':
                    bindings.add(alias.asname if alias.asname else alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                # import package.sub binds ``package`` unless an alias is used.
                bindings.add(alias.asname if alias.asname else alias.name.split('.')[0])
    return bindings


def expression_path(node):
    """將 name/attribute 表達式轉為可比較的使用點路徑。"""
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        parent = expression_path(node.value)
        return parent + [node.attr] if parent else None
    return None


def helper_has_side_effect_boundary(helper_node, import_bindings):
    """Whether a same-module helper reaches an imported I/O boundary.

    A target that calls such a helper must patch the helper at its use point;
    otherwise a generated test may touch the application's real database,
    network, or filesystem even though the target itself has no direct import
    call in its body.
    """
    for node in ast.walk(helper_node):
        if not isinstance(node, ast.Call):
            continue
        call_path = expression_path(node.func)
        if call_path and call_path[0] in import_bindings:
            return True
        if isinstance(node.func, ast.Name) and node.func.id == 'open':
            return True
    return False


def find_external_calls(func_node, import_bindings, target_module, local_helpers=None):
    """Find imported calls and side-effecting local helpers to patch at use point."""
    external_calls = []
    seen = set()
    local_helpers = local_helpers or {}
    for node in ast.walk(func_node):
        if isinstance(node, ast.Call):
            call_path = expression_path(node.func)
            if not call_path:
                continue
            if call_path[0] in import_bindings:
                patch_path = f"{target_module}." + '.'.join(call_path)
            elif (len(call_path) == 1 and call_path[0] in local_helpers
                  and helper_has_side_effect_boundary(local_helpers[call_path[0]], import_bindings)):
                patch_path = f"{target_module}.{call_path[0]}"
            else:
                continue
            if patch_path in seen:
                continue
            seen.add(patch_path)
            external_calls.append({
                "name": call_path[-1],
                "patch_path": patch_path
            })
    return external_calls


def constructor_required_params(class_node):
    if not class_node:
        return []
    init_node = next((item for item in class_node.body
                      if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == '__init__'), None)
    if not init_node:
        return []
    params = [arg.arg for arg in init_node.args.args if arg.arg not in ('self', 'cls')]
    required_count = len(params) - len(init_node.args.defaults)
    return params[:required_count]


def get_method_kind(func_node, class_node):
    if not class_node:
        return 'module'
    decorator_names = {
        node.id if isinstance(node, ast.Name)
        else node.attr if isinstance(node, ast.Attribute)
        else ''
        for node in func_node.decorator_list
    }
    if 'staticmethod' in decorator_names:
        return 'static'
    if 'classmethod' in decorator_names:
        return 'class'
    return 'instance'


def generate_scaffold(file_path: str, func_name: str, trace_result: dict = None,
                      target_module: str = None) -> dict:
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            source = f.read()
    except Exception as e:
        return {"scaffold": "", "patches": [], "mock_names": [], "error": str(e)}

    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"scaffold": "", "patches": [], "mock_names": [], "error": str(e)}

    # A qualified Class.method selection takes precedence over any same-named
    # module function or sibling class method.
    target_func = None
    class_name = None
    class_node = None
    selected_method_name = func_name.rsplit('.', 1)[-1]
    if '.' in func_name:
        selected_class_name = func_name.rsplit('.', 1)[0]
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name == selected_class_name:
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == selected_method_name:
                        target_func = item
                        class_name = node.name
                        class_node = node
                        break
            if target_func:
                break
    else:
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
                target_func = node
                break
        if target_func is None:
            for node in tree.body:
                if isinstance(node, ast.ClassDef):
                    for item in node.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == func_name:
                            target_func = item
                            class_name = node.name
                            class_node = node
                            break
                if target_func:
                    break

    if not target_func:
        return {"scaffold": "", "patches": [], "mock_names": [], "error": f"Function '{func_name}' not found"}

    method_kind = get_method_kind(target_func, class_node)

    # 找 import 映射
    import_bindings = find_import_bindings(tree)
    target_module = target_module or os.path.splitext(os.path.basename(file_path))[0]
    local_helpers = {
        node.name: node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node is not target_func
    }

    # 找外部呼叫
    external_calls = find_external_calls(target_func, import_bindings, target_module, local_helpers)

    # 取得函式參數名稱（如果在 class 內，去除 self/cls）
    all_params = [arg.arg for arg in target_func.args.args]
    func_params = [p for p in all_params if p not in ('self', 'cls')] if class_name else all_params

    # 建立 patch decorator 列表
    patches = [ec["patch_path"] for ec in external_calls]
    mock_names = [f"mock_{ec['name']}" for ec in external_calls]

    # 從 trace_result 取得真實回傳值
    return_value_hints = []
    if trace_result and trace_result.get("examples"):
        first_ex = trace_result["examples"][0]
        return_value_hints.append(f"# Real return: {first_ex['result']}")

    # 建立 scaffold 字串
    lines = []

    # @patch decorators（倒序，因為 Python decorator 執行順序是由內到外）
    for patch_path in reversed(patches):
        lines.append(f"@patch('{patch_path}')")

    # 方法簽章（加上 mock 參數）
    mock_param_str = ", ".join(["self"] + mock_names)
    test_prefix = 'async def' if isinstance(target_func, ast.AsyncFunctionDef) else 'def'
    lines.append(f"{test_prefix} test_{selected_method_name}({mock_param_str}):")

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
    if class_name and method_kind == 'instance':
        required_init = constructor_required_params(class_node)
        if required_init:
            lines.append(f"    instance = {class_name}(...)  # TODO: provide valid values for: {', '.join(required_init)}")
        else:
            lines.append(f"    instance = {class_name}()")
        call_target = f"instance.{selected_method_name}({call_args})"
    elif class_name:
        call_target = f"{class_name}.{selected_method_name}({call_args})"
    else:
        call_target = f"{selected_method_name}({call_args})"
    if isinstance(target_func, ast.AsyncFunctionDef):
        lines.append(f"    result = await {call_target}")
    else:
        lines.append(f"    result = {call_target}")
    lines.append(f"    # TODO: add assertions here")
    lines.append(f"    # Example: self.assertEqual(result, expected_value)")

    scaffold = "\n".join(lines)

    return {
        "scaffold": scaffold,
        "patches": patches,
        "mock_names": mock_names,
        "func_params": func_params,
        "class_name": class_name,
        "method_kind": method_kind,
        "is_async": isinstance(target_func, ast.AsyncFunctionDef)
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

    target_module = sys.argv[4] if len(sys.argv) >= 5 and sys.argv[4] else None
    result = generate_scaffold(file_path, func_name, trace_result, target_module)
    print(json.dumps(result, ensure_ascii=False))
