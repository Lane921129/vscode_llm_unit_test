"""
dynamic_tracer.py
執行目標函式並記錄真實的 input -> output 對。
用法: python dynamic_tracer.py <file_path> <func_name> [<json_inputs>]

json_inputs: 可選，JSON 陣列，每個元素是傳給函式的 args list
若未提供，腳本會自動生成邊界值輸入嘗試執行
"""
import sys
import ast
import builtins
import json
import importlib.util
import os
import shutil
import socket
import subprocess
import traceback
import types
import asyncio
import inspect
import itertools
import io
import math
from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


class TraceSafetyError(RuntimeError):
    """Raised when tracing would perform an external side effect."""


def _blocked_trace_operation(operation):
    def blocked(*_args, **_kwargs):
        raise TraceSafetyError(f'Dynamic trace safety gate blocked {operation}')
    return blocked


@contextmanager
def block_trace_side_effects():
    """Prevent a traced module from mutating the host or contacting services.

    Dynamic Trace is evidence gathering, not an authorization to perform the
    target's real-world effects. Reads remain available so ordinary imports and
    pure parsers can execute; writes, process launches and network access are
    rejected and reported as unavailable trace evidence.
    """
    original_open = builtins.open
    original_socket = socket.socket

    def read_only_open(file, mode='r', *args, **kwargs):
        if any(flag in str(mode) for flag in ('w', 'a', 'x', '+')):
            raise TraceSafetyError('Dynamic trace safety gate blocked file write')
        return original_open(file, mode, *args, **kwargs)

    class TraceSocket(original_socket):
        """Allow local asyncio plumbing but reject outbound connections."""
        @staticmethod
        def _is_loopback(address):
            host = address[0] if isinstance(address, tuple) and address else address
            return host in ('127.0.0.1', '::1', 'localhost')

        def connect(self, address, *args, **kwargs):
            if self._is_loopback(address):
                return original_socket.connect(self, address, *args, **kwargs)
            raise TraceSafetyError('Dynamic trace safety gate blocked network connection')

        def connect_ex(self, address, *args, **kwargs):
            if self._is_loopback(address):
                return original_socket.connect_ex(self, address, *args, **kwargs)
            raise TraceSafetyError('Dynamic trace safety gate blocked network connection')

    with ExitStack() as stack:
        stack.enter_context(patch('builtins.open', read_only_open))
        for method in ('open', 'write_text', 'write_bytes', 'touch', 'mkdir', 'rename', 'replace', 'unlink', 'rmdir'):
            stack.enter_context(patch.object(Path, method, _blocked_trace_operation(f'Path.{method}')))
        for name in ('system', 'popen', 'remove', 'unlink', 'rmdir', 'replace'):
            stack.enter_context(patch.object(os, name, _blocked_trace_operation(f'os.{name}')))
        stack.enter_context(patch.object(shutil, 'rmtree', _blocked_trace_operation('shutil.rmtree')))
        for name in ('run', 'call', 'check_call', 'check_output', 'Popen'):
            stack.enter_context(patch.object(subprocess, name, _blocked_trace_operation(f'subprocess.{name}')))
        stack.enter_context(patch.object(socket, 'socket', TraceSocket))
        stack.enter_context(patch.object(socket, 'create_connection', _blocked_trace_operation('network connection')))
        yield


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


def _match_pattern_literals(pattern):
    """Extract only scalar literals from safe Python structural patterns."""
    match_value_type = getattr(ast, 'MatchValue', ())
    match_singleton_type = getattr(ast, 'MatchSingleton', ())
    match_or_type = getattr(ast, 'MatchOr', ())
    if match_value_type and isinstance(pattern, match_value_type):
        value = _literal_value(pattern.value)
        return [value] if isinstance(value, (str, int, float, bool)) else []
    if match_singleton_type and isinstance(pattern, match_singleton_type):
        return [pattern.value]
    if match_or_type and isinstance(pattern, match_or_type):
        values = []
        for nested in pattern.patterns:
            values.extend(_match_pattern_literals(nested))
        return values
    return []


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
        match_type = getattr(ast, 'Match', ())
        if match_type and isinstance(node, match_type):
            subject = _condition_subject(node.subject, parameter_names)
            if subject and subject[1] == 'value':
                name = subject[0]
                literals = []
                for case in node.cases:
                    literals.extend(_match_pattern_literals(case.pattern))
                for literal in literals:
                    add(name, literal)
                # A synthetic non-match reaches `case _` / the unmatched path
                # without relying on business vocabulary from the source.
                if any(isinstance(value, str) for value in literals):
                    add(name, '__other_value__')
                elif literals and all(isinstance(value, bool) for value in literals):
                    add(name, not literals[0])
                elif any(isinstance(value, (int, float)) and not isinstance(value, bool) for value in literals):
                    numeric = [value for value in literals if isinstance(value, (int, float)) and not isinstance(value, bool)]
                    add(name, max(numeric) + 1)

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

def package_module_context(file_path: str):
    """Return an importable module name and its package-root search path.

    Relative imports require ``__package__`` to be meaningful. A file inside
    ``package/submodule.py`` must therefore be loaded as
    ``package.submodule`` rather than merely ``submodule``.
    """
    target = Path(file_path).resolve()
    package_parts = []
    current = target.parent
    while (current / '__init__.py').is_file():
        package_parts.append(current.name)
        current = current.parent
    package_parts.reverse()
    module_name = '.'.join(package_parts + [target.stem]) if package_parts else target.stem
    return module_name, str(current), package_parts[0] if package_parts else None


def load_module_from_file(file_path: str):
    """Dynamically load a module while preserving Python package semantics."""
    module_name, package_root, package_prefix = package_module_context(file_path)
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
    if package_root not in sys.path:
        sys.path.insert(0, package_root)
    # A tracer process can inspect several temporary projects. Do not reuse a
    # same-named package left by an earlier trace, or relative imports could
    # silently resolve to that other project's source tree.
    if package_prefix:
        for loaded_name in list(sys.modules):
            if loaded_name == package_prefix or loaded_name.startswith(package_prefix + '.'):
                sys.modules.pop(loaded_name, None)
    try:
        sys.modules[module_name] = module
        spec.loader.exec_module(module)  # type: ignore
    except TraceSafetyError:
        sys.modules.pop(module_name, None)
        raise
    except Exception:
        sys.modules.pop(module_name, None)
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


def is_assertable_literal(value, seen=None):
    """Whether a value has a bounded, portable Python-literal oracle.

    Object repr values often include process-specific memory addresses. They
    remain useful as trace context, but cannot be used as deterministic test
    assertions. Keep the decision type-based instead of recognising domain
    classes or field names.
    """
    if value is None or isinstance(value, (bool, int, str, bytes)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, (tuple, list, dict)):
        seen = seen if seen is not None else set()
        identity = id(value)
        if identity in seen:
            return False
        seen.add(identity)
        try:
            if isinstance(value, dict):
                return all(is_assertable_literal(key, seen) and is_assertable_literal(item, seen)
                           for key, item in value.items())
            return all(is_assertable_literal(item, seen) for item in value)
        finally:
            seen.remove(identity)
    return False


def trace_repr_with_oracle(value):
    """Return display repr and whether it is safe for a deterministic assertion."""
    if not is_assertable_literal(value):
        # Do not call an arbitrary object's __repr__: it may expose a memory
        # address, perform I/O, or throw. The type is enough diagnostic context.
        return f'<non_assertable: {type(value).__name__}>', False
    rendered = repr(value)
    if len(rendered) > 100:
        return safe_repr(value), False
    return rendered, True


TRACE_COLLECTION_LIMIT = 100


def materialize_trace_result(value):
    """Turn a generator into a bounded, reproducible trace fact.

    Generator repr values include memory addresses and are unsuitable as test
    oracles. A bounded prefix keeps tracing safe while recording whether the
    sequence continued beyond that prefix.
    """
    if inspect.isgenerator(value):
        captured = list(itertools.islice(value, TRACE_COLLECTION_LIMIT + 1))
        return captured[:TRACE_COLLECTION_LIMIT], 'generator', len(captured) > TRACE_COLLECTION_LIMIT
    return value, type(value).__name__, False


async def materialize_async_generator(value):
    """Turn an async generator into a bounded, reproducible trace fact."""
    captured = []
    async for item in value:
        captured.append(item)
        if len(captured) > TRACE_COLLECTION_LIMIT:
            break
    return captured[:TRACE_COLLECTION_LIMIT], 'async_generator', len(captured) > TRACE_COLLECTION_LIMIT


def is_cached_property_descriptor(descriptor):
    """Recognise functools.cached_property without accepting arbitrary descriptors."""
    descriptor_type = type(descriptor)
    return (
        descriptor_type.__module__ == 'functools'
        and descriptor_type.__name__ == 'cached_property'
        and callable(getattr(descriptor, 'func', None))
    )

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
        "load_error": None,
        "blocked_operations": []
    }

    # 載入模組
    # The CLI protocol is JSON on stdout. Target modules may print or configure
    # noisy imports, but their output is trace evidence rather than protocol.
    try:
        with block_trace_side_effects(), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            module = load_module_from_file(file_path)
    except TraceSafetyError as error:
        result["load_error"] = str(error)
        result["blocked_operations"].append(str(error))
        return result
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
                if (isinstance(descriptor, property) and callable(descriptor.fget)) or is_cached_property_descriptor(descriptor):
                    func = descriptor.fget if isinstance(descriptor, property) else descriptor.func
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
            # Keep stdout/stderr from constructors, target calls and generator
            # materialisation out of the JSON document printed by this script.
            with block_trace_side_effects(), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if func_is_method or func_is_property:
                    # 將 class 實例化後呼叫 method
                    cls_obj = getattr(module, method_class_name)
                    try:
                        instance = cls_obj()
                    except TraceSafetyError:
                        raise
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
                if inspect.isasyncgen(ret):
                    ret, result_type, result_truncated = asyncio.run(materialize_async_generator(ret))
                else:
                    if inspect.isawaitable(ret):
                        ret = asyncio.run(ret)
                    ret, result_type, result_truncated = materialize_trace_result(ret)
            formatted_args = [trace_repr_with_oracle(argument) for argument in inp]
            formatted_kwargs = {
                name: trace_repr_with_oracle(value)
                for name, value in kwargs.items()
            }
            formatted_result, result_assertable = trace_repr_with_oracle(ret)
            example = {
                "args": [rendered for rendered, _ in formatted_args],
                "result": formatted_result,
                "result_type": result_type
            }
            if not result_assertable:
                example['result_assertable'] = False
            if not all(assertable for _, assertable in formatted_args) or not all(
                assertable for _, assertable in formatted_kwargs.values()
            ):
                example['call_assertable'] = False
            if result_type in ('generator', 'async_generator'):
                example['result_truncated'] = result_truncated
                example['result_collection_limit'] = TRACE_COLLECTION_LIMIT
            if kwargs:
                example["kwargs"] = {name: rendered for name, (rendered, _) in formatted_kwargs.items()}
            result["examples"].append(example)
        except TraceSafetyError as error:
            # A blocked operation is diagnostic only, never a claimed target
            # exception that an LLM should turn into assertRaises(RuntimeError).
            if str(error) not in result["blocked_operations"]:
                result["blocked_operations"].append(str(error))
        except Exception as e:
            exc_type = type(e).__name__
            exc_msg = str(e)[:200]
            # 只記錄「預期的」例外（ValueError, TypeError, KeyError 等），不記錄系統錯誤
            if exc_type in ('ValueError', 'TypeError', 'KeyError', 'AttributeError',
                            'IndexError', 'RuntimeError', 'PermissionError', 'FileNotFoundError',
                            'NotImplementedError', 'AssertionError', 'ZeroDivisionError'):
                formatted_args = [trace_repr_with_oracle(argument) for argument in inp]
                formatted_kwargs = {
                    name: trace_repr_with_oracle(value)
                    for name, value in kwargs.items()
                }
                error_record = {
                    "args": [rendered for rendered, _ in formatted_args],
                    "exception": exc_type,
                    "message": exc_msg
                }
                if not all(assertable for _, assertable in formatted_args) or not all(
                    assertable for _, assertable in formatted_kwargs.values()
                ):
                    error_record['call_assertable'] = False
                if kwargs:
                    error_record["kwargs"] = {name: rendered for name, (rendered, _) in formatted_kwargs.items()}
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
