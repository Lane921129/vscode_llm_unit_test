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


def _literal_value(node):
    """Return a safe Python literal used in a source-level condition, if any."""
    try:
        value = ast.literal_eval(node)
        return value if isinstance(value, (str, int, float, bool, type(None))) else None
    except Exception:
        return None


def _condition_subject(node, parameter_names):
    """Recognise a direct parameter or len(parameter), never arbitrary calls."""
    if isinstance(node, ast.Name) and node.id in parameter_names:
        return node.id, 'value'
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == 'len'
        and len(node.args) == 1
        and isinstance(node.args[0], ast.Name)
        and node.args[0].id in parameter_names
    ):
        return node.args[0].id, 'length'
    return None


def infer_condition_guided_inputs(file_path: str, func_name: str, positional_args: list,
                                  annotations: dict = None, keyword_only_args: list = None) -> list:
    """
    Derive a small set of safe scalar inputs from the target function's own
    comparisons. This is intentionally syntax-only: it recognises parameter
    equality, numeric boundaries and length boundaries, without encoding domain
    vocabulary or attempting to execute source expressions.
    """
    keyword_only_args = keyword_only_args or []
    parameter_names = set(positional_args + keyword_only_args)
    if not parameter_names:
        return []

    try:
        with open(file_path, encoding='utf-8') as source_file:
            tree = ast.parse(source_file.read(), filename=file_path)
    except (OSError, SyntaxError, UnicodeError):
        return []

    target = next(
        (
            node for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name
        ),
        None
    )
    if target is None:
        return []

    annotations = annotations or {}
    candidates = {name: [] for name in parameter_names}

    def add(name, value):
        if value not in candidates[name]:
            candidates[name].append(value)

    for node in ast.walk(target):
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            subject = _condition_subject(node.operand, parameter_names)
            if subject and subject[1] == 'value':
                annotation = str(annotations.get(subject[0], '')).lower()
                add(subject[0], '' if 'str' in annotation else 0)

        if not isinstance(node, ast.Compare) or len(node.ops) != 1 or len(node.comparators) != 1:
            continue
        subject = _condition_subject(node.left, parameter_names)
        if not subject:
            continue
        name, subject_kind = subject
        operator = node.ops[0]
        right = node.comparators[0]

        if isinstance(operator, (ast.In, ast.NotIn)) and subject_kind == 'value' and isinstance(right, (ast.List, ast.Tuple, ast.Set)):
            literal_items = [_literal_value(item) for item in right.elts]
            for item in literal_items:
                if item is not None:
                    add(name, item)
            if any(isinstance(item, str) for item in literal_items):
                add(name, '__other_value__')
            continue

        literal = _literal_value(right)
        if literal is None and not (isinstance(right, ast.Constant) and right.value is None):
            continue

        if subject_kind == 'length':
            if isinstance(literal, int) and not isinstance(literal, bool) and literal >= 0:
                for length in (max(0, literal - 1), literal, literal + 1):
                    add(name, 'x' * length)
            continue

        add(name, literal)
        if isinstance(operator, (ast.Eq, ast.NotEq, ast.Is, ast.IsNot)):
            if isinstance(literal, str):
                add(name, '__other_value__')
            elif isinstance(literal, bool):
                add(name, not literal)
            elif literal is None:
                annotation = str(annotations.get(name, '')).lower()
                add(name, '' if 'str' in annotation else 0)
        elif isinstance(literal, (int, float)) and not isinstance(literal, bool):
            add(name, literal - 1)
            add(name, literal + 1)

    if not any(candidates.values()):
        return []

    def default_value(name):
        annotation = str(annotations.get(name, '')).lower()
        if 'bool' in annotation:
            return True
        if 'str' in annotation:
            return 'test_value'
        if any(number_type in annotation for number_type in ('int', 'float', 'decimal')):
            return 1
        return 'test_value'

    def build_input(values):
        args = [values[name] for name in positional_args]
        kwargs = {name: values[name] for name in keyword_only_args}
        return {'args': args, 'kwargs': kwargs} if kwargs else tuple(args)

    baseline = {name: default_value(name) for name in parameter_names}
    results = []
    for name in positional_args + keyword_only_args:
        for value in candidates[name]:
            values = dict(baseline)
            values[name] = value
            results.append(build_input(values))

    unique_results = []
    seen = set()
    for value in results:
        serialized = json.dumps(value, sort_keys=True, default=repr)
        if serialized not in seen:
            seen.add(serialized)
            unique_results.append(value)
    return unique_results[:12]

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

def infer_boundary_inputs(positional_args: list, annotations: dict = None, keyword_only_args: list = None) -> list:
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

    keyword_only_args = keyword_only_args or []
    all_args = positional_args + keyword_only_args
    per_arg_candidates = []
    for arg_name in all_args:
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

    def build_input(values):
        args = list(values[:len(positional_args)])
        kwargs = {
            name: values[len(positional_args) + index]
            for index, name in enumerate(keyword_only_args)
        }
        return {'args': args, 'kwargs': kwargs} if kwargs else tuple(args)

    if len(per_arg_candidates) == 0:
        return [()]
    if len(per_arg_candidates) == 1:
        return [build_input((candidate,)) for candidate in per_arg_candidates[0][:8]]

    # zip-style：每個參數取相同 index 的候選值，最多 10 組
    results = []
    max_candidates = max(len(c) for c in per_arg_candidates)
    for i in range(min(max_candidates, 10)):
        combo = tuple(c[i % len(c)] for c in per_arg_candidates)
        results.append(build_input(combo))

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
    func_is_property = False
    method_class_name = None
    method_kind = 'module'

    if func is None or not callable(func):
        # 在模組中找 class method
        for attr_name in dir(module):
            cls_obj = getattr(module, attr_name, None)
            if isinstance(cls_obj, type):
                descriptor = cls_obj.__dict__.get(func_name)
                method = getattr(cls_obj, func_name, None)
                if isinstance(descriptor, property) and callable(descriptor.fget):
                    func = descriptor.fget
                    method_kind = 'property'
                    func_is_property = True
                    method_class_name = attr_name
                    break
                if method and callable(method):
                    func = method
                    method_kind = (
                        'static' if isinstance(descriptor, staticmethod)
                        else 'class' if isinstance(descriptor, classmethod)
                        else 'instance'
                    )
                    func_is_method = method_kind == 'instance'
                    method_class_name = attr_name
                    break

    if func is None or not callable(func):
        result["load_error"] = f"Function '{func_name}' not found or not callable"
        return result

    # 取得參數名稱（class method 去除 self/cls）
    try:
        sig = inspect.signature(func)
        all_params = list(sig.parameters.values())
        # 未綁定 method 可能包含 self，將其去除
        trace_params = [p for p in all_params if p.name not in ('self', 'cls')]
        result["args"] = [p.name for p in trace_params]
        annotations = {
            parameter.name: parameter.annotation
            for parameter in trace_params
            if parameter.annotation is not inspect.Parameter.empty
        }
        required_positional_args = [
            parameter.name for parameter in trace_params
            if parameter.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
            and parameter.default is inspect.Parameter.empty
        ]
        required_keyword_only_args = [
            parameter.name for parameter in trace_params
            if parameter.kind is inspect.Parameter.KEYWORD_ONLY
            and parameter.default is inspect.Parameter.empty
        ]
    except Exception:
        pass

    # Combine literal call-site facts with generic source-derived coverage.
    # A real caller example is valuable, but must not suppress other reachable
    # branches just because the caller happened to use one fixed value.
    positional = required_positional_args if 'required_positional_args' in locals() else result["args"]
    keyword_only = required_keyword_only_args if 'required_keyword_only_args' in locals() else []
    inferred_annotations = annotations if 'annotations' in locals() else {}
    guided_inputs = infer_condition_guided_inputs(
        file_path,
        func_name,
        positional,
        inferred_annotations,
        keyword_only
    )
    # With a known caller, retain that concrete I/O and only add inputs that
    # exercise source-derived conditions. Generic type boundaries remain useful
    # when no caller information exists, but would otherwise add noisy samples
    # without improving a fixed caller trace.
    caller_inputs = list(test_inputs) if test_inputs is not None else []
    coverage_inputs = list(guided_inputs)
    if test_inputs is None:
        coverage_inputs.extend(infer_boundary_inputs(
            positional,
            inferred_annotations,
            keyword_only
        ))
    seen_inputs = set()
    merged_inputs = []
    for candidate in caller_inputs + coverage_inputs:
        serialized = json.dumps(candidate, sort_keys=True, default=repr)
        if serialized not in seen_inputs:
            seen_inputs.add(serialized)
            merged_inputs.append(candidate)
    test_inputs = merged_inputs

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
            if func_is_method or func_is_property:
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
                if func_is_property:
                    if inp or kwargs:
                        raise TypeError(f"Property '{func_name}' does not accept call arguments")
                    ret = getattr(instance, func_name)
                else:
                    ret = getattr(instance, func_name)(*inp, **kwargs)
            else:
                ret = func(*inp, **kwargs)
            if inspect.isawaitable(ret):
                ret = asyncio.run(ret)
            example = {
                "args": [safe_repr(a) for a in inp],
                "result": safe_repr(ret),
                "result_type": type(ret).__name__
            }
            if kwargs:
                example["kwargs"] = {name: safe_repr(value) for name, value in kwargs.items()}
            result["examples"].append(example)
        except Exception as e:
            exc_type = type(e).__name__
            exc_msg = str(e)[:200]
            # 只記錄「預期的」例外（ValueError, TypeError, KeyError 等），不記錄系統錯誤
            if exc_type in ('ValueError', 'TypeError', 'KeyError', 'AttributeError',
                            'IndexError', 'RuntimeError', 'PermissionError', 'FileNotFoundError',
                            'NotImplementedError', 'AssertionError', 'ZeroDivisionError'):
                error_record = {
                    "args": [safe_repr(a) for a in inp],
                    "exception": exc_type,
                    "message": exc_msg
                }
                if kwargs:
                    error_record["kwargs"] = {name: safe_repr(value) for name, value in kwargs.items()}
                result["errors"].append(error_record)
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
