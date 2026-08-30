"""
dynamic_tracer.py
執行目標函式並記錄真實的 input -> output 對。
用法: python dynamic_tracer.py <file_path> <func_name> [<json_inputs>]

json_inputs: 可選，JSON 陣列，每個元素是傳給函式的 args list
若未提供，腳本會自動生成邊界值輸入嘗試執行
"""
import sys
import ast
import json
import importlib.util
import os
import traceback
import types
import asyncio
import inspect

def load_module_from_file(file_path: str):
    """動態載入 Python 模組"""
    module_name = os.path.basename(file_path).replace('.py', '')
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    # 讓模組能找到同目錄以及上一層目錄（專案根目錄）的其他模組
    target_dir = os.path.dirname(file_path)
    parent_dir = os.path.dirname(target_dir)
    if target_dir not in sys.path:
        sys.path.insert(0, target_dir)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    try:
        spec.loader.exec_module(module)  # type: ignore
    except Exception as e:
        return None
    return module

def infer_boundary_inputs(func_args: list, annotations: dict = None) -> list:
    """
    根據參數名稱猜測常見型別，產生通用邊界值組合。
    目的：快速取得「函式是否可正常執行」的初始 I/O 樣本。
    注意：函式特定的邊界策略由語意分析師（Semantic Analyzer）的 test_strategy 決定，
          這裡只做型別推測，不做領域特化。
    回傳: list of arg-tuples，每個 tuple 是一組呼叫參數
    """
    scalar_candidates = [0, 1, -1, 100, -100, 0.5, 10.0]
    str_candidates = ["", "a", "hello", "test_value", "1234567890"]
    bool_candidates = [True, False]
    none_candidate = [None]

    per_arg_candidates = []
    for arg_name in func_args:
        annotation = str((annotations or {}).get(arg_name, '')).lower()
        if 'bool' in annotation:
            per_arg_candidates.append(bool_candidates + none_candidate)
        elif 'str' in annotation:
            per_arg_candidates.append(str_candidates + none_candidate)
        elif any(number_type in annotation for number_type in ('int', 'float', 'decimal')):
            per_arg_candidates.append(scalar_candidates + none_candidate)
        else:
            # Domain-specific inputs belong to the Semantic Analyzer. The generic
            # tracer intentionally uses only annotation-based or mixed probes.
            per_arg_candidates.append(str_candidates[:2] + scalar_candidates[:3] + none_candidate)

    if len(per_arg_candidates) == 0:
        return [()]
    if len(per_arg_candidates) == 1:
        return [(c,) for c in per_arg_candidates[0][:8]]

    # zip-style：每個參數取相同 index 的候選值，最多 10 組
    results = []
    max_candidates = max(len(c) for c in per_arg_candidates)
    for i in range(min(max_candidates, 10)):
        combo = tuple(c[i % len(c)] for c in per_arg_candidates)
        results.append(combo)

    return results


def safe_repr(val) -> str:
    """安全地把值轉成 repr，截斷過長的字串"""
    r = repr(val)
    if len(r) > 100:
        r = r[:100] + '...'
    return r

def trace_function(file_path: str, func_name: str, test_inputs: list = None) -> dict:
    """
    載入模組、執行函式、記錄 I/O
    回傳: {
        "func_name": str,
        "args": [str],          # 參數名稱
        "examples": [           # 成功執行的範例
            {"args": [...], "result": "...", "result_repr": "..."},
        ],
        "errors": [             # 預期例外
            {"args": [...], "exception": "ExceptionType", "message": "..."},
        ],
        "load_error": str | null
    }
    """
    result = {
        "func_name": func_name,
        "args": [],
        "examples": [],
        "errors": [],
        "load_error": None
    }

    # 載入模組
    module = load_module_from_file(file_path)
    if module is None:
        result["load_error"] = f"Failed to load module from {file_path}"
        return result

    # 取得函式（支援頂層函式與 class method）
    func = getattr(module, func_name, None)
    func_is_method = False
    method_class_name = None

    if func is None or not callable(func):
        # 在模組中找 class method
        for attr_name in dir(module):
            cls_obj = getattr(module, attr_name, None)
            if isinstance(cls_obj, type):
                method = getattr(cls_obj, func_name, None)
                if method and callable(method):
                    func = method
                    func_is_method = True
                    method_class_name = attr_name
                    break

    if func is None or not callable(func):
        result["load_error"] = f"Function '{func_name}' not found or not callable"
        return result

    # 取得參數名稱（class method 去除 self/cls）
    try:
        sig = inspect.signature(func)
        all_params = list(sig.parameters.keys())
        # 未綁定 method 可能包含 self，將其去除
        result["args"] = [p for p in all_params if p not in ('self', 'cls')]
        annotations = {
            name: parameter.annotation
            for name, parameter in sig.parameters.items()
            if parameter.annotation is not inspect.Parameter.empty
        }
    except Exception:
        pass

    # 決定測試輸入
    if test_inputs is None:
        test_inputs = infer_boundary_inputs(result["args"], annotations if 'annotations' in locals() else {})

    # 執行每個測試輸入。呼叫站提供的字面值可包含 args/kwargs；舊格式 list
    # 仍相容，避免將 AST 變數名稱當成真實字串輸入。
    for inp in test_inputs:
        kwargs = {}
        if isinstance(inp, dict):
            kwargs = inp.get('kwargs', {})
            inp = inp.get('args', [])
        if not isinstance(inp, (list, tuple)):
            inp = (inp,)
        try:
            if func_is_method:
                # 將 class 實例化後呼叫 method
                cls_obj = getattr(module, method_class_name)
                try:
                    instance = cls_obj()
                except Exception as constructor_error:
                    result["load_error"] = (
                        f"Cannot safely instantiate class '{method_class_name}' for dynamic trace: "
                        f"{type(constructor_error).__name__}: {constructor_error}"
                    )
                    result["examples"] = []
                    result["errors"] = []
                    return result
                ret = getattr(instance, func_name)(*inp, **kwargs)
            else:
                ret = func(*inp, **kwargs)
            if inspect.isawaitable(ret):
                ret = asyncio.run(ret)
            result["examples"].append({
                "args": [safe_repr(a) for a in inp],
                "result": safe_repr(ret),
                "result_type": type(ret).__name__
            })
        except Exception as e:
            exc_type = type(e).__name__
            exc_msg = str(e)[:200]
            # 只記錄「預期的」例外（ValueError, TypeError, KeyError 等），不記錄系統錯誤
            if exc_type in ('ValueError', 'TypeError', 'KeyError', 'AttributeError',
                            'IndexError', 'RuntimeError', 'PermissionError', 'FileNotFoundError',
                            'NotImplementedError', 'AssertionError', 'ZeroDivisionError'):
                result["errors"].append({
                    "args": [safe_repr(a) for a in inp],
                    "exception": exc_type,
                    "message": exc_msg
                })
            # 其他例外（ImportError 等）靜默跳過

    return result


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({"load_error": "Usage: dynamic_tracer.py <file_path> <func_name> [json_inputs]"}))
        sys.exit(1)

    file_path = sys.argv[1]
    func_name = sys.argv[2]
    test_inputs = None

    if len(sys.argv) >= 4:
        try:
            test_inputs = json.loads(sys.argv[3])
        except Exception:
            pass

    output = trace_function(file_path, func_name, test_inputs)
    print(json.dumps(output, ensure_ascii=False))
