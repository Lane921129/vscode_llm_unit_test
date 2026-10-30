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
from probe_case_plan import deduplicate_planned_calls
import importlib.util
import os
import subprocess
import asyncio
import inspect
import itertools
import io
import math
import types
import traceback
import time
import hashlib
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from trace_observation_guard import observe_ambient_reads
from trace_value_codec import snapshot_value, snapshot_call, restore_value, safe_type_name, type_field
from probe_input_transport import prepare_probe_inputs
from static_type_shape import TYPE_SHAPE_VERSION, resolve_parameter_shapes
from input_planner import plan_inputs
from runtime_policy import POLICY_VERSION, RuntimePolicyError, BackgroundExecutionError, block_operation, guarded_runtime


class TraceSafetyError(RuntimePolicyError):
    """Raised when tracing would perform an external side effect."""
    prefix = 'Dynamic trace safety gate blocked '
    suffix = ''


def exception_message(error):
    arguments = BaseException.__dict__['args'].__get__(error)
    return arguments[0][:1500] if len(arguments) == 1 and type(arguments[0]) is str else trace_repr_with_oracle(arguments)[0]


def import_diagnostic(error, source_root=None):
    name, message = safe_type_name(error), exception_message(error)
    trace = BaseException.__dict__['__traceback__'].__get__(error)
    frames = traceback.extract_tb(trace)
    missing = ImportError.__dict__['name'].__get__(error) if isinstance(error, ModuleNotFoundError) else None
    diagnostic = {'stage': 'module-import', 'exception_type': name,
            'message': message,
            'missing_module': missing if type(missing) is str else None,
            'traceback': (''.join(traceback.format_list(frames)) + name + ': ' + message)[-5000:]}
    if isinstance(error, TraceSafetyError):
        diagnostic['blocked_operation'] = message.removeprefix('Dynamic trace safety gate blocked ')[:120]
    if source_root:
        root = os.path.normcase(os.path.realpath(source_root))
        tool_files = {os.path.normcase(os.path.realpath(path)) for path in
                      (__file__, os.path.join(os.path.dirname(__file__), 'module_preflight.py'),
                       os.path.join(os.path.dirname(__file__), 'runtime_policy.py'))}
        for frame in frames:
            file = os.path.normcase(os.path.realpath(frame.filename))
            if file in tool_files:
                continue
            try:
                if os.path.commonpath([root, file]) == root:
                    diagnostic['origin'] = {'file': os.path.relpath(file, root).replace('\\', '/'), 'line': frame.lineno}
            except ValueError:
                pass
    return diagnostic


def _blocked_trace_operation(operation):
    def blocked(*_args, **_kwargs):
        block_operation(operation, TraceSafetyError)
    return blocked


@contextmanager
def block_trace_side_effects():
    """Use the same strict import/I/O/SQLite policy as generated tests."""
    with guarded_runtime(error_type=TraceSafetyError, protect_profile=True) as violations:
        yield violations


def find_selected_ast_function(tree, selector):
    """Resolve a module function or an explicit top-level Class.method."""
    if '.' in selector:
        class_name, method_name = selector.rsplit('.', 1)
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name == class_name:
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == method_name:
                        return item
        return None
    return next(
        (
            node for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == selector
        ),
        None
    )


def plan_source_inputs(file_path, selector, method_kind):
    """Build input candidates from syntax only; annotations are never evaluated."""
    tree = ast.parse(Path(file_path).read_bytes().decode('utf-8'), filename=file_path)
    target = find_selected_ast_function(tree, selector)
    if target is None:
        return {'cases': [], 'schema_version': 'input-plan-v1', 'limits': {}, 'stats': {},
                'parameter_shapes': {}, 'type_shape_version': TYPE_SHAPE_VERSION,
                'diagnostics': [{'parameter': '', 'code': 'needs-input', 'reason': 'target-ast-unresolved'}]}
    positional = list(target.args.posonlyargs) + list(target.args.args)
    excluded = (positional[0].arg,) if positional and method_kind in ('instance', 'class', 'property') else ()
    shapes = resolve_parameter_shapes(tree, target, excluded_names=excluded)
    plan = plan_inputs(tree, target, shapes, method_kind=method_kind, excluded_names=excluded)
    plan.update(parameter_shapes=shapes, type_shape_version=TYPE_SHAPE_VERSION)
    return plan


def package_module_context(file_path: str):
    """Return an importable module name and its package-root search path.

    Relative imports require ``__package__`` to be meaningful. A file inside
    ``package/submodule.py`` must therefore be loaded as
    ``package.submodule`` rather than merely ``submodule``.
    """
    from python_import_paths import package_context
    return package_context(file_path)


def load_module_from_file(file_path: str):
    """Dynamically load a module while preserving Python package semantics."""
    module_name, package_root, package_prefix = package_module_context(file_path)
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    # 讓模組能找到同目錄以及上一層目錄（專案根目錄）的其他模組
    from python_import_paths import source_import_paths
    sys.path[:0] = [item for item in source_import_paths(file_path, module_name, [package_root]) if item not in sys.path]
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
    except (Exception, SystemExit):
        sys.modules.pop(module_name, None)
        raise
    return module

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
    if value is None or type(value) in (bool, int, str, bytes):
        return True
    if type(value) is float:
        return math.isfinite(value)
    if type(value) in (tuple, list, dict):
        seen = seen if seen is not None else set()
        identity = id(value)
        if identity in seen:
            return False
        seen.add(identity)
        try:
            if type(value) is dict:
                return all(is_assertable_literal(key, seen) and is_assertable_literal(item, seen)
                           for key, item in value.items())
            return all(is_assertable_literal(item, seen) for item in value)
        finally:
            seen.remove(identity)
    return False


def trace_repr_with_oracle(value):
    """Return display repr and whether it is safe for a deterministic assertion."""
    if not snapshot_value(value)['replayable'] or not is_assertable_literal(value):
        # Do not call an arbitrary object's __repr__: it may expose a memory
        # address, perform I/O, or throw. The type is enough diagnostic context.
        return f'<non_assertable: {safe_type_name(value)}>', False
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
    return value, safe_type_name(value), False


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

def _trace_function_local(file_path: str, func_name: str, test_inputs: list = None,
                          *, exact_inputs=False, prepare_only=False) -> dict:
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
        "cases": [],
        "load_error": None,
        "blocked_operations": []
    }
    _, observation_root, _ = package_module_context(file_path)
    import_reads = set()

    # 載入模組
    # The CLI protocol is JSON on stdout. Target modules may print or configure
    # noisy imports, but their output is trace evidence rather than protocol.
    try:
        with observe_ambient_reads(observation_root, importing=True) as import_reads, \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), block_trace_side_effects():
            module = load_module_from_file(file_path)
    except TraceSafetyError as error:
        result["load_error"] = str(error)
        result['load_diagnostic'] = import_diagnostic(error)
        result["blocked_operations"].append(str(error))
        return result
    except (Exception, SystemExit) as error:
        result['load_diagnostic'] = import_diagnostic(error)
        result['load_error'] = f'{safe_type_name(error)}: {exception_message(error)}'
        return result
    if module is None:
        result["load_error"] = f"Failed to load module from {file_path}"
        return result

    # Resolve an explicit Class.method before falling back to the legacy bare
    # method search. This prevents same-named methods from another class from
    # supplying trace facts for the selected target.
    selected_class_name = None
    selected_method_name = func_name
    if '.' in func_name:
        selected_class_name, selected_method_name = func_name.rsplit('.', 1)

    # 取得函式（支援頂層函式與 class method）
    func = getattr(module, selected_method_name, None) if selected_class_name is None else None
    func_is_method = False
    func_is_property = False
    method_class_name = None
    method_kind = 'module'

    if selected_class_name is not None:
        cls_obj = getattr(module, selected_class_name, None)
        if isinstance(cls_obj, type):
            descriptor = cls_obj.__dict__.get(selected_method_name)
            method = getattr(cls_obj, selected_method_name, None)
            if (isinstance(descriptor, property) and callable(descriptor.fget)) or is_cached_property_descriptor(descriptor):
                func = descriptor.fget if isinstance(descriptor, property) else descriptor.func
                method_kind = 'property'
                func_is_property = True
                method_class_name = selected_class_name
            elif method and callable(method):
                func = method
                method_kind = (
                    'static' if isinstance(descriptor, staticmethod)
                    else 'class' if isinstance(descriptor, classmethod)
                    else 'instance'
                )
                func_is_method = method_kind == 'instance'
                method_class_name = selected_class_name

    if (func is None or not callable(func)) and selected_class_name is None:
        # 在模組中找 class method
        for attr_name in dir(module):
            cls_obj = getattr(module, attr_name, None)
            if isinstance(cls_obj, type):
                descriptor = cls_obj.__dict__.get(selected_method_name)
                method = getattr(cls_obj, selected_method_name, None)
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

    # Bind the actual callable without rendering/evaluating runtime annotations.
    # A module parameter named self/cls is an ordinary input, not a receiver.
    call_signature = None
    try:
        sig = inspect.signature(func, eval_str=False)
        trace_params = list(sig.parameters.values())
        if (func_is_method or func_is_property) and trace_params:
            trace_params = trace_params[1:]
        call_signature = sig.replace(parameters=trace_params)
        result["args"] = [p.name for p in trace_params]
    except (TypeError, ValueError):
        pass

    caller_inputs = list(test_inputs) if test_inputs is not None else []
    constructor_template = None
    if func_is_method or func_is_property:
        for candidate in caller_inputs:
            if type(candidate) is not dict:
                continue
            constructor_args = candidate.get('constructor_args')
            constructor_kwargs = candidate.get('constructor_kwargs')
            if type(constructor_args) in (list, tuple) and type(constructor_kwargs) is dict:
                constructor_template = {'constructor_args': list(constructor_args),
                                        'constructor_kwargs': dict(constructor_kwargs)}
                break

    coverage_inputs = []
    if not exact_inputs:
        selector = f'{method_class_name}.{selected_method_name}' if method_class_name else func_name
        plan = plan_source_inputs(file_path, selector, method_kind)
        for planned in plan.pop('cases'):
            metadata = planned['metadata']
            # Preserve a known caller and add source conditions, rather than
            # repeating arbitrary type baselines for that already known call.
            if test_inputs is not None and metadata['source'] != 'source-condition':
                continue
            source = {'kind': 'source_guided', 'detail': metadata['source'],
                      'generator_version': plan['schema_version'],
                      'reason': metadata['reason'], 'intent': metadata.get('intent', 'valid')}
            source.update({key: metadata[key] for key in ('parameter', 'line') if key in metadata})
            coverage_inputs.append({'args': planned['args'], 'kwargs': planned['kwargs'], 'source': source})
        if (func_is_method or func_is_property) and not constructor_template:
            # Unknown required setup is a fixture need, not target exception evidence.
            try:
                with block_trace_side_effects():
                    inspect.signature(getattr(module, method_class_name), eval_str=False).bind()
            except (TypeError, ValueError, TraceSafetyError):
                coverage_inputs = []
                plan['diagnostics'].append({'parameter': '', 'code': 'needs-fixture',
                                            'reason': 'constructor-input-required'})
        plan['status'] = ('partial' if plan['diagnostics'] else 'ready') if coverage_inputs or caller_inputs else 'needs-input'
        plan['generated_cases'] = len(coverage_inputs)
        result['input_plan'] = plan

    if constructor_template:
        enriched_coverage_inputs = []
        for candidate in coverage_inputs:
            if isinstance(candidate, dict):
                enriched = dict(candidate)
            else:
                enriched = {'args': list(candidate) if isinstance(candidate, tuple) else candidate, 'kwargs': {}}
            enriched.setdefault('constructor_args', constructor_template['constructor_args'])
            enriched.setdefault('constructor_kwargs', constructor_template['constructor_kwargs'])
            enriched_coverage_inputs.append(enriched)
        coverage_inputs = enriched_coverage_inputs
    seen_inputs = set()
    merged_inputs = []
    for candidate in caller_inputs + coverage_inputs:
        serialized = json.dumps(snapshot_value(candidate), sort_keys=True)
        if serialized not in seen_inputs:
            seen_inputs.add(serialized)
            merged_inputs.append(candidate)
    test_inputs = merged_inputs

    if prepare_only:
        result['planned_inputs'] = [snapshot_value(candidate) for candidate in test_inputs]
        return result

    # 執行每個測試輸入。呼叫站提供的字面值可包含 args/kwargs；舊格式 list
    # 仍相容，避免將 AST 變數名稱當成真實字串輸入。
    for case_index, inp in enumerate(test_inputs):
        source = inp.get('source') if type(inp) is dict else None
        source = source if type(source) is dict else {'kind': 'unknown'}
        kwargs = {}
        constructor_args, constructor_kwargs = [], {}
        constructor_context_supplied = False
        if isinstance(inp, dict):
            kwargs = inp.get('kwargs', {})
            constructor_args = inp.get('constructor_args', [])
            constructor_kwargs = inp.get('constructor_kwargs', {})
            constructor_context_supplied = 'constructor_args' in inp and 'constructor_kwargs' in inp
            inp = inp.get('args', [])
        if not isinstance(inp, (list, tuple)):
            inp = (inp,)
        if not isinstance(constructor_args, (list, tuple)):
            constructor_args = []
        if not isinstance(constructor_kwargs, dict):
            constructor_kwargs = {}
        ambient_reads = set()
        input_before = snapshot_call(inp, kwargs, constructor_args, constructor_kwargs)
        # These immutable display strings must describe values before constructor
        # and target execution. Mutating input containers never rewrite history.
        formatted_args = [trace_repr_with_oracle(argument) for argument in inp]
        formatted_kwargs = {name: trace_repr_with_oracle(value) for name, value in kwargs.items()}
        formatted_constructor_args = [trace_repr_with_oracle(argument) for argument in constructor_args]
        formatted_constructor_kwargs = {name: trace_repr_with_oracle(value) for name, value in constructor_kwargs.items()}
        case = {'case_id': f'local-{case_index}', 'source': source, 'input_before': input_before}
        started = time.monotonic()
        stage = 'setup'
        setup_callable = getattr(getattr(module, method_class_name), '__init__', None) if method_class_name else None
        try:
            if call_signature is not None:
                try:
                    call_signature.bind(*inp, **kwargs)
                except TypeError:
                    case.update(status='not_started', reason='signature-mismatch')
                    continue
            # Keep stdout/stderr from constructors, target calls and generator
            # materialisation out of the JSON document printed by this script.
            with observe_ambient_reads(observation_root, (func, setup_callable)) as ambient_reads, \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), block_trace_side_effects():
                if func_is_method or func_is_property:
                    # 將 class 實例化後呼叫 method
                    cls_obj = getattr(module, method_class_name)
                    instance = cls_obj(*constructor_args, **constructor_kwargs)
                    stage = 'target'
                    if func_is_property:
                        if inp or kwargs:
                            raise TypeError(f"Property '{func_name}' does not accept call arguments")
                        ret = getattr(instance, selected_method_name)
                    else:
                        ret = getattr(instance, selected_method_name)(*inp, **kwargs)
                else:
                    stage = 'target'
                    ret = func(*inp, **kwargs)
                if inspect.isasyncgen(ret):
                    ret, result_type, result_truncated = asyncio.run(materialize_async_generator(ret))
                else:
                    if inspect.isawaitable(ret):
                        ret = asyncio.run(ret)
                    ret, result_type, result_truncated = materialize_trace_result(ret)
            formatted_result, result_assertable = trace_repr_with_oracle(ret)
            case['status'] = 'returned'
            case['result_snapshot'] = snapshot_value(ret)
            example = {
                "args": [rendered for rendered, _ in formatted_args],
                "result": formatted_result,
                "result_type": result_type
            }
            if import_reads or ambient_reads:
                example.update(call_assertable=False, result_assertable=False,
                               non_deterministic_operations=sorted(import_reads | ambient_reads),
                               oracle_reason='uncontrolled-ambient-read')
            if not result_assertable:
                example['result_assertable'] = False
            if not all(assertable for _, assertable in formatted_args) or not all(
                assertable for _, assertable in formatted_kwargs.values()
            ) or not input_before['replayable']:
                example['call_assertable'] = False
            if result_type in ('generator', 'async_generator'):
                example['result_truncated'] = result_truncated
                example['result_collection_limit'] = TRACE_COLLECTION_LIMIT
            if kwargs:
                example["kwargs"] = {name: rendered for name, (rendered, _) in formatted_kwargs.items()}
            if (func_is_method or func_is_property) and constructor_context_supplied:
                example['constructor_args'] = [rendered for rendered, _ in formatted_constructor_args]
                if formatted_constructor_kwargs:
                    example['constructor_kwargs'] = {
                        name: rendered for name, (rendered, _) in formatted_constructor_kwargs.items()
                    }
                if not all(assertable for _, assertable in formatted_constructor_args) or not all(
                    assertable for _, assertable in formatted_constructor_kwargs.values()
                ):
                    example['call_assertable'] = False
            result["examples"].append(example)
            case['_example'] = example
        except TraceSafetyError as error:
            # A blocked operation is diagnostic only, never a claimed target
            # exception that an LLM should turn into assertRaises(RuntimeError).
            if str(error) not in result["blocked_operations"]:
                result["blocked_operations"].append(str(error))
            case.update(status='blocked', stage=stage, diagnostic=str(error))
        except BackgroundExecutionError as error:
            case.update(status='worker_error', stage=stage, diagnostic=str(error), reason='background-execution-failed')
        except Exception as e:
            exc_type = safe_type_name(e)
            # Exception subclasses may override __str__ with arbitrary code.
            # A builtin args tuple gives bounded diagnostics without that hook.
            exc_msg = exception_message(e)[:200]
            if stage == 'setup':
                case.update(status='setup_error', stage='setup', exception=exc_type, diagnostic=exc_msg)
                continue
            # 記錄目標引發的有效例外，排除非目標行為的嚴重系統錯誤
            if exc_type not in ('MemoryError', 'RecursionError', 'SystemExit', 'KeyboardInterrupt'):
                case.update(status='raised', exception=exc_type)
                error_record = {
                    "args": [rendered for rendered, _ in formatted_args],
                    "exception": exc_type,
                    "message": exc_msg
                }
                if import_reads or ambient_reads:
                    error_record.update(call_assertable=False,
                                        non_deterministic_operations=sorted(import_reads | ambient_reads),
                                        oracle_reason='uncontrolled-ambient-read')
                exception_type = type(e)
                exception_module = type_field(exception_type, '__module__')
                exception_qualname = type_field(exception_type, '__qualname__')
                owner = sys.modules.get(exception_module) if type(exception_module) is str else None
                parts = exception_qualname.split('.') if type(exception_qualname) is str else []
                for part in parts:
                    namespace = vars(owner) if type(owner) is types.ModuleType else type_field(owner, '__dict__') if isinstance(owner, type) else {}
                    owner = namespace.get(part)
                if owner is exception_type and parts and all(part.isidentifier() for part in parts):
                    error_record['exception_module'] = exception_module
                    error_record['exception_qualname'] = exception_qualname
                else:
                    error_record['call_assertable'] = False
                if not all(assertable for _, assertable in formatted_args) or not all(
                    assertable for _, assertable in formatted_kwargs.values()
                ) or not input_before['replayable']:
                    error_record['call_assertable'] = False
                if kwargs:
                    error_record["kwargs"] = {name: rendered for name, (rendered, _) in formatted_kwargs.items()}
                if (func_is_method or func_is_property) and constructor_context_supplied:
                    error_record['constructor_args'] = [rendered for rendered, _ in formatted_constructor_args]
                    if formatted_constructor_kwargs:
                        error_record['constructor_kwargs'] = {
                            name: rendered for name, (rendered, _) in formatted_constructor_kwargs.items()
                        }
                    if not all(assertable for _, assertable in formatted_constructor_args) or not all(
                        assertable for _, assertable in formatted_constructor_kwargs.values()
                    ):
                        error_record['call_assertable'] = False
                result["errors"].append(error_record)
                case['_error'] = error_record
            else:
                case.update(status='worker_error', exception=exc_type, diagnostic=exc_msg)
            # 其他例外（ImportError 等）靜默跳過
        except (SystemExit, KeyboardInterrupt) as error:
            case.update(status='worker_error', exception=type(error).__name__, diagnostic='Target terminated execution')
        finally:
            case['input_after'] = snapshot_call(inp, kwargs, constructor_args, constructor_kwargs)
            case['inputs_mutated'] = case['input_after'] != input_before
            case['duration_ms'] = round((time.monotonic() - started) * 1000, 3)
            example, error = case.pop('_example', None), case.pop('_error', None)
            for observation in (example, error):
                if observation is not None:
                    observation.update({key: case[key] for key in ('case_id', 'source', 'input_before', 'input_after', 'inputs_mutated')})
            result['cases'].append(case)

    return result


def _worker_result(payload, timeout):
    """A worker never receives the host progress path or runtime options."""
    worker = os.path.join(os.path.dirname(__file__), 'trace_case_worker.py')
    completed = subprocess.run(
        [sys.executable, '-B', worker], input=json.dumps(payload, ensure_ascii=True),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', errors='replace',
        timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
    )
    if completed.returncode != 0:
        # Raw stderr may include source text. Keep only a tool-owned diagnosis.
        raise RuntimeError(f'Trace worker exited with code {completed.returncode}')
    result = json.loads(completed.stdout)
    if type(result) is not dict:
        raise ValueError('Invalid trace worker envelope')
    return result


def _candidate_context(candidate):
    if type(candidate) is dict:
        args, kwargs = candidate.get('args', []), candidate.get('kwargs', {})
        constructor_args = candidate.get('constructor_args', [])
        constructor_kwargs = candidate.get('constructor_kwargs', {})
        source = candidate.get('source')
    else:
        args, kwargs, constructor_args, constructor_kwargs, source = candidate, {}, [], {}, None
    if type(args) not in (list, tuple):
        args = (args,)
    return snapshot_call(args, kwargs, constructor_args, constructor_kwargs), source if type(source) is dict else {'kind': 'unknown'}


def trace_function(file_path: str, func_name: str, test_inputs: list = None, *,
                   case_timeout_seconds=2.0, total_timeout_seconds=12.0,
                   planning_timeout_seconds=5.0, progress_path=None) -> dict:
    """Plan in one guarded worker, then execute each case in a fresh process.

    Inputs may be the legacy Python list or a probe-inputs-v1 typed envelope.
    Invalid envelope cases remain independent diagnostics, never target values.
    Deadlines include imports and setup. Completed cases are appended to an
    optional host-owned JSONL journal immediately; target workers never see it.
    This is process state isolation, not an OS sandbox for hostile native code.
    """
    def positive_timeout(value, fallback):
        return min(float(value), 300.0) if type(value) in (int, float) and math.isfinite(value) and value > 0 else fallback

    case_timeout = positive_timeout(case_timeout_seconds, 2.0)
    total_timeout = positive_timeout(total_timeout_seconds, 12.0)
    planning_timeout = positive_timeout(planning_timeout_seconds, 5.0)
    started = time.monotonic()
    deadline = started + total_timeout
    result = {
        'schema_version': 'behavior-observations-v2', 'func_name': func_name,
        'policy_version': POLICY_VERSION,
        'args': [], 'examples': [], 'errors': [], 'cases': [],
        'load_error': None, 'blocked_operations': [], 'isolation': 'fresh-process-per-case',
    }
    run_id = hashlib.sha256(f'{os.getpid()}:{time.monotonic_ns()}'.encode()).hexdigest()[:20]
    result['run_id'] = run_id
    if progress_path is not None and (type(progress_path) is not str or not os.path.isabs(progress_path)):
        raise ValueError('Trace progress_path must be an absolute host-owned path')

    def journal(event, **data):
        if progress_path:
            try:
                with open(progress_path, 'a', encoding='utf-8') as stream:
                    stream.write(json.dumps({'run_id': run_id, 'event': event, **data}, ensure_ascii=True) + '\n')
                    stream.flush()
            except OSError as error:
                result['journal_error'] = f'{type(error).__name__}: progress journal unavailable'

    journal('run_started', schema_version=result['schema_version'], func_name=func_name,
            policy_version=POLICY_VERSION, isolation=result['isolation'])
    valid_supplied, invalid_supplied = prepare_probe_inputs(test_inputs)
    source_sites_by_index = {}

    def case_base(encoded, index):
        digest = hashlib.sha256((os.path.abspath(file_path) + '\n' + func_name + '\n' + json.dumps(encoded, sort_keys=True)).encode()).hexdigest()[:20]
        if encoded.get('replayable'):
            before, source = _candidate_context(restore_value(encoded))
        else:
            before, source = {'unavailable_input': encoded}, {'kind': 'unknown'}
        # The digest identifies input content; run/index identifies this actual
        # attempt, including duplicate supplied inputs when planning fails.
        return {'case_id': f'probe-{run_id}-{index}-{digest}', 'case_index': index, 'source': source,
                **({'source_sites': source_sites_by_index[index]} if index in source_sites_by_index else {}),
                'input_before': before, 'input_after': None, 'duration_ms': 0,
                'allocated_timeout_seconds': 0}

    def append_case(case, observations=None):
        observations = observations or {}
        examples, errors = observations.get('examples', []), observations.get('errors', [])
        fixtures = observations.get('importFixtures')
        for record in examples + errors:
            record['case_id'] = case['case_id']
            record['source'] = case['source']
            if case.get('source_sites'):
                record['source_sites'] = case['source_sites']
            if fixtures:
                record['importFixtures'] = fixtures
        if fixtures:
            case['importFixtures'] = fixtures
        result['cases'].append(case)
        result['examples'].extend(examples)
        result['errors'].extend(errors)
        blocked = observations.get('blocked_operations', [])
        for operation in blocked:
            if operation not in result['blocked_operations']:
                result['blocked_operations'].append(operation)
        journal('case_completed', case=case, examples=examples, errors=errors, blocked_operations=blocked)

    for index, (encoded, source, reason) in enumerate(invalid_supplied):
        case = case_base(encoded, index)
        case.update(status='not_started', reason=reason, source=source)
        append_case(case)

    plan_started = time.monotonic()
    planning_allocated = 0.0
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired('trace planning', total_timeout)
        planning_allocated = min(planning_timeout, remaining)
        planned = _worker_result({'mode': 'plan', 'file_path': file_path, 'func_name': func_name,
                                  'inputs': valid_supplied}, planning_allocated)
        result['args'] = planned.get('args', [])
        if planned.get('importFixtures'):
            result['importFixtures'] = planned['importFixtures']
        result['load_error'] = planned.get('load_error')
        if planned.get('load_diagnostic'):
            result['load_diagnostic'] = planned['load_diagnostic']
        result['blocked_operations'] = planned.get('blocked_operations', [])
        if 'input_plan' in planned:
            result['input_plan'] = planned['input_plan']
        result['planning'] = {'status': 'failed' if result['load_error'] else 'completed'}
    except subprocess.TimeoutExpired:
        planned = {}
        result['load_error'] = 'Trace planning timed out before cases could be prepared'
        result['planning'] = {'status': 'timeout'}
    except (OSError, ValueError, RuntimeError) as error:
        planned = {}
        result['load_error'] = f'Trace planning failed: {type(error).__name__}'
        result['planning'] = {'status': 'worker_error'}
    result['planning']['duration_ms'] = round((time.monotonic() - plan_started) * 1000, 3)
    result['planning']['configured_timeout_seconds'] = planning_timeout
    result['planning']['allocated_timeout_seconds'] = planning_allocated
    # Every case repeats process startup and guarded import. A successful plan
    # measures a conservative allowance for that work (including planning),
    # not the target's runtime. Keep the original total deadline unchanged.
    calibrated = result['planning']['status'] == 'completed' and not result['load_error']
    effective_case_timeout = case_timeout + result['planning']['duration_ms'] / 1000 if calibrated else case_timeout
    result['case_timing'] = {
        'configured_timeout_seconds': case_timeout,
        'effective_timeout_seconds': effective_case_timeout,
        'calibration_reason': 'completed-planning-startup' if calibrated else 'planning-unavailable',
    }
    pending = planned.get('planned_inputs', []) if not result['load_error'] else (valid_supplied or [])
    if not result['load_error']:
        entries, result['input_deduplication'] = deduplicate_planned_calls(pending, _candidate_context)
        pending = [entry['input'] for entry in entries]
        source_sites_by_index = {index + len(invalid_supplied): entry['source_sites'] for index, entry in enumerate(entries)}
    journal('planning_completed', planning=result['planning'], args=result['args'], load_error=result['load_error'],
            case_timing=result['case_timing'],
            **({'importFixtures': result['importFixtures']} if result.get('importFixtures') else {}),
            load_diagnostic=result.get('load_diagnostic'), blocked_operations=result['blocked_operations'],
            input_plan=result.get('input_plan'),
            input_deduplication=result.get('input_deduplication'),
            planned_cases=[case_base(encoded, index + len(invalid_supplied)) for index, encoded in enumerate(pending)])
    total_deadline_exhausted = False
    for index, encoded in enumerate(pending):
        case = case_base(encoded, index + len(invalid_supplied))
        if result['load_error']:
            case.update(status='not_started', reason='planning-unavailable')
            append_case(case)
            continue
        remaining = deadline - time.monotonic()
        if total_deadline_exhausted or remaining <= 0:
            case.update(status='not_started', reason='total-deadline')
            append_case(case)
            continue
        if not encoded.get('replayable'):
            case.update(status='not_started', reason='unsupported-input-snapshot')
            append_case(case)
            continue
        case_started = time.monotonic()
        case_remaining = max(0, deadline - case_started)
        allocated_timeout = min(effective_case_timeout, case_remaining)
        total_deadline_limited = case_remaining <= effective_case_timeout
        if allocated_timeout <= 0:
            case.update(status='not_started', reason='total-deadline')
            append_case(case)
            continue
        case['allocated_timeout_seconds'] = allocated_timeout
        observations = None
        journal('case_started', case=case)
        try:
            observations = _worker_result({'mode': 'case', 'file_path': file_path,
                                           'func_name': func_name, 'inputs': [encoded]}, allocated_timeout)
            completed_cases = observations.get('cases', [])
            if len(completed_cases) != 1:
                case.update(status='setup_error' if observations.get('load_error') else 'worker_error',
                            reason='case-import-failed' if observations.get('load_error') else 'missing-case-result',
                            diagnostic=observations.get('load_error'))
            else:
                case.update({key: value for key, value in completed_cases[0].items()
                             if key not in ('case_id', 'case_index', 'allocated_timeout_seconds')})
        except subprocess.TimeoutExpired:
            # A worker that exhausted the total allocation consumes that budget
            # even if platform timeout rounding returns just before monotonic's
            # deadline. Do not launch another process on a sub-millisecond tail.
            if total_deadline_limited:
                total_deadline_exhausted = True
            case.update(status='timeout', reason='total-deadline' if total_deadline_limited else 'case-deadline')
        except (OSError, ValueError, RuntimeError) as error:
            case.update(status='worker_error', diagnostic=f'Trace worker failed: {type(error).__name__}')
        case['duration_ms'] = round((time.monotonic() - case_started) * 1000, 3)
        append_case(case, observations)
    result['duration_ms'] = round((time.monotonic() - started) * 1000, 3)
    result['complete'] = not result['load_error'] and all(case['status'] not in ('not_started', 'timeout', 'worker_error') for case in result['cases'])
    journal('run_completed', complete=result['complete'], duration_ms=result['duration_ms'])
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
            # The host uses stdin so bounded typed containers cannot exceed the
            # platform's command-line limit. Keep positional JSON compatibility.
            serialized = sys.stdin.read(1024 * 1024 + 1) if sys.argv[3] == '-' else sys.argv[3]
            if len(serialized) > 1024 * 1024:
                raise ValueError('Probe input transport budget exceeded')
            test_inputs = json.loads(serialized)
        except (ValueError, TypeError):
            test_inputs = {'schema_version': 'invalid-probe-inputs', 'cases': [{}]}

    options = {}
    if len(sys.argv) >= 5:
        try:
            supplied_options = json.loads(sys.argv[4])
            if type(supplied_options) is dict:
                options = {name: supplied_options[name] for name in (
                    'case_timeout_seconds', 'total_timeout_seconds', 'planning_timeout_seconds',
                    'progress_path') if name in supplied_options}
        except (ValueError, TypeError):
            pass
    output = trace_function(file_path, func_name, test_inputs, **options)
    print(json.dumps(output, ensure_ascii=True))
