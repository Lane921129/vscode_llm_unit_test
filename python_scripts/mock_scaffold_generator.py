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
from mock_behavior import imports, dotted
from ast_extractor import (function_scope_bindings, function_scope_usage, extract_parameters,
                           receiver_exclusions, method_kind as source_method_kind)
from dependency_fixture_contract import build_dependency_fixture_contract


# These are concrete I/O API use points, not guesses based on a helper name.
# Other imported calls remain unknown metadata for Writer to inspect in source.
EXTERNAL_BOUNDARIES = {
    'sqlite3.connect', 'io.open', 'os.open', 'os.listdir', 'os.scandir',
    'os.mkdir', 'os.makedirs', 'os.remove', 'os.unlink', 'os.rename', 'os.replace', 'os.rmdir',
    'shutil.copy', 'shutil.copy2', 'shutil.copyfile', 'shutil.move', 'shutil.rmtree',
    'socket.socket', 'socket.create_connection', 'urllib.request.urlopen', 'urllib.request.urlretrieve',
    'subprocess.run', 'subprocess.Popen', 'subprocess.call', 'subprocess.check_call', 'subprocess.check_output',
}


def find_import_bindings(tree):
    """回傳在被測模組命名空間中可被 patch 的匯入綁定名稱。"""
    bindings = imports(tree.body)
    if any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == 'open'
           or isinstance(node, (ast.Assign, ast.AnnAssign)) and any(
               isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store) and child.id == 'open'
               for child in ast.walk(node)) for node in tree.body):
        bindings['open'] = ''
    return bindings


def boundary_origin(call_path, import_bindings, roots):
    if not call_path or call_path[0] not in roots:
        return None
    if call_path == ['open'] and 'open' not in import_bindings:
        return 'builtins.open'
    root = import_bindings.get(call_path[0])
    origin = '.'.join([root, *call_path[1:]]) if root else ''
    return origin if origin in EXTERNAL_BOUNDARIES else None


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
    _, _, roots = function_scope_usage(helper_node, function_scope_bindings(helper_node))
    for node in ast.walk(helper_node):
        if not isinstance(node, ast.Call):
            continue
        call_path = expression_path(node.func)
        if boundary_origin(call_path, import_bindings, roots):
            return True
    return False


def find_external_calls(func_node, import_bindings, target_module, local_helpers=None, unknown_calls=None):
    """Find imported calls and side-effecting local helpers to patch at use point."""
    external_calls = []
    seen = set()
    local_helpers = local_helpers or {}
    _, _, roots = function_scope_usage(func_node, function_scope_bindings(func_node))
    for node in ast.walk(func_node):
        if isinstance(node, ast.Call):
            call_path = expression_path(node.func)
            if not call_path or call_path[0] not in roots:
                continue
            # ``open`` is resolved from builtins at runtime but can be patched
            # safely at the target module's use point.  Without this branch a
            # file-I/O Tier 3 scaffold has no patch and may touch real files.
            boundary = boundary_origin(call_path, import_bindings, roots)
            if boundary == 'builtins.open':
                patch_path = f"{target_module}.open"
            elif boundary:
                patch_path = f"{target_module}." + '.'.join(call_path)
            elif (len(call_path) == 1 and call_path[0] in local_helpers
                  and helper_has_side_effect_boundary(local_helpers[call_path[0]], import_bindings)):
                patch_path = f"{target_module}.{call_path[0]}"
            else:
                if call_path[0] in import_bindings and unknown_calls is not None:
                    unknown = {'use_point': f"{target_module}." + '.'.join(call_path),
                               'line': node.lineno, 'status': 'unknown', 'reason': 'import-does-not-prove-external-boundary'}
                    if unknown not in unknown_calls:
                        unknown_calls.append(unknown)
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
        return None if class_node.bases else []
    return [parameter['name'] for parameter in extract_parameters(
        init_node.args, receiver_exclusions(init_node, class_node)) if parameter['required']]


def get_method_kind(func_node, class_node):
    return source_method_kind(func_node, class_node)


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
    direct_imports = {id(node) for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))}
    # A write anywhere makes an imported API's boundary identity uncertain.
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)) and id(node) not in direct_imports:
            for alias in node.names:
                root = alias.asname or (alias.name.split('.')[0] if isinstance(node, ast.Import) else alias.name)
                if root == 'open':
                    import_bindings[root] = ''
                else:
                    import_bindings.pop(root, None)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            if node.name == 'open':
                import_bindings['open'] = ''
            else:
                import_bindings.pop(node.name, None)
        elif isinstance(node, (ast.Name, ast.Attribute)) and isinstance(node.ctx, (ast.Store, ast.Del)):
            root = dotted(node).split('.')[0]
            if root == 'open':
                import_bindings[root] = ''
            else:
                import_bindings.pop(root, None)
        elif isinstance(node, ast.Call) and dotted(node.func).split('.')[-1] in (
                'globals', 'locals', 'vars', 'eval', 'exec', 'setattr', 'delattr'):
            import_bindings = {'open': ''}
    target_module = target_module or os.path.splitext(os.path.basename(file_path))[0]
    local_helpers = {
        node.name: node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node is not target_func
    }

    # 找外部呼叫
    unknown_calls = []
    external_calls = find_external_calls(target_func, import_bindings, target_module, local_helpers, unknown_calls)

    parameters = extract_parameters(target_func.args, receiver_exclusions(target_func, class_node))
    func_params = [parameter['name'] for parameter in parameters]

    # 建立 patch decorator 列表
    patches = [ec["patch_path"] for ec in external_calls]
    mock_names = []
    for ec in external_calls:
        base = f"mock_{ec['name']}"
        name, suffix = base, 2
        while name in mock_names or name in func_params or name in ('self', 'instance', 'result'):
            name, suffix = f'{base}_{suffix}', suffix + 1
        mock_names.append(name)

    # 建立 scaffold 字串
    lines = ['# SETUP PLACEHOLDERS ONLY: fill every TODO; this scaffold is not an accepted test.']

    # @patch decorators（倒序，因為 Python decorator 執行順序是由內到外）
    for patch_path in reversed(patches):
        lines.append(f"@patch('{patch_path}')")

    # 方法簽章（加上 mock 參數）
    mock_param_str = ", ".join(["self"] + mock_names)
    test_prefix = 'async def' if isinstance(target_func, ast.AsyncFunctionDef) else 'def'
    lines.append(f"{test_prefix} test_{selected_method_name}({mock_param_str}):")

    # A blanket None contradicts factory().method() and connection/cursor
    # consumption. Preserve the default mock receiver only when the existing
    # lexical contract proves that a patched call's result is consumed again.
    target_source = ast.get_source_segment(source, target_func) or ''
    fixture_contract = build_dependency_fixture_contract(
        target_func, target_source, func_name, set(import_bindings) | set(local_helpers))
    for patch_path, mock_name in zip(patches, mock_names):
        receivers = set()
        for flow in fixture_contract['flows']:
            if flow['root']['kind'] != 'use-point':
                continue
            receiver = target_module + '.' + flow['root']['name']
            for step in flow['steps']:
                receiver += ('.' + step['name'] if step['kind'] == 'member'
                             else '.__enter__.return_value' if step['kind'] == 'context-enter' else '.return_value')
            if receiver.startswith(patch_path + '.return_value'):
                receivers.add(mock_name + receiver[len(patch_path):])
        if receivers:
            paths = sorted(receiver for receiver in receivers
                           if not any(other.startswith(receiver + '.') for other in receivers))
            lines.append('    # TODO: configure source-consumed receiver objects: ' + ', '.join(paths))
            lines.append('    # Keep enclosing return objects; do not replace them with None/string/scalar. No expected output is implied.')
        else:
            lines.append(f"    # TODO: choose an explicit controlled return for {mock_name}; source shape is unknown, no value is supplied")

    lines.append(f"")

    # TODO: 參數設定、呼叫、斷言
    parameter_bindings = {}
    used_names = {'self', 'instance', 'result', *mock_names}
    if func_params:
        for param in func_params:
            local, suffix = param, 2
            if local in used_names:
                local = 'input_' + param
            while local in used_names or local in func_params and local != param:
                local, suffix = f'input_{param}_{suffix}', suffix + 1
            used_names.add(local)
            parameter_bindings[param] = local
            lines.append(f"    # TODO: define {local} explicitly for parameter '{param}'; no fixture value is supplied")
        lines.append(f"")

    call_args = ", ".join(
        f"{parameter['name']}={parameter_bindings[parameter['name']]}" if parameter['kind'] == 'keyword_only'
        else ('*' if parameter['kind'] == 'var_positional' else '**' if parameter['kind'] == 'var_keyword' else '')
        + parameter_bindings[parameter['name']] for parameter in parameters)
    if class_name and method_kind in ('instance', 'property'):
        required_init = constructor_required_params(class_node)
        if required_init is None:
            lines.append(f"    instance = {class_name}(...)  # TODO: verify inherited constructor setup from source")
        elif required_init:
            lines.append(f"    instance = {class_name}(...)  # TODO: provide valid values for: {', '.join(required_init)}")
        else:
            lines.append(f"    instance = {class_name}()")
        call_target = (f"instance.{selected_method_name}" if method_kind == 'property'
                       else f"instance.{selected_method_name}({call_args})")
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
        "parameter_bindings": parameter_bindings,
        "class_name": class_name,
        "method_kind": method_kind,
        "is_async": isinstance(target_func, ast.AsyncFunctionDef),
        "schema_version": "mock-scaffold-v2", "executable": False,
        "unknown_calls": unknown_calls, "trace_hints": "omitted-setup-is-not-an-oracle"
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
