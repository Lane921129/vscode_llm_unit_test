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
import typing
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
        stack.enter_context(patch('io.open', read_only_open))
        for method in ('open', 'write_text', 'write_bytes', 'touch', 'mkdir', 'rename', 'replace', 'unlink', 'rmdir', 'chmod', 'symlink_to', 'hardlink_to'):
            stack.enter_context(patch.object(Path, method, _blocked_trace_operation(f'Path.{method}')))
        for name in ('open', 'system', 'popen', 'remove', 'unlink', 'rmdir', 'replace'):
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


def _is_scalar_literal_node(node):
    value = _literal_value(node)
    return value is not None or (isinstance(node, ast.Constant) and node.value is None)


def _reversed_comparison_operator(operator):
    """Convert literal-first comparisons into an equivalent subject-first form."""
    reverse = {
        ast.Lt: ast.Gt,
        ast.LtE: ast.GtE,
        ast.Gt: ast.Lt,
        ast.GtE: ast.LtE,
        ast.Eq: ast.Eq,
        ast.NotEq: ast.NotEq,
        ast.Is: ast.Is,
        ast.IsNot: ast.IsNot,
    }
    operator_type = reverse.get(type(operator))
    return operator_type() if operator_type else None


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


def selected_function_scope_nodes(func_node):
    """Yield target-body nodes without inheriting nested callable conditions."""
    nodes = []

    def visit(node):
        if node is not func_node and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return
        nodes.append(node)
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in func_node.body:
        visit(statement)
    return nodes


def literal_annotation_values(annotation):
    """Extract scalar ``typing.Literal`` values without evaluating source text.

    Literal annotations are an explicit, source-declared finite input domain.
    They are useful Trace probes but are never an output oracle.  String
    annotations are parsed as Python syntax only; calls, attributes and other
    non-literal expressions are deliberately ignored.
    """
    values = []
    origin = typing.get_origin(annotation)
    if origin is typing.Literal:
        values = list(typing.get_args(annotation))
    elif isinstance(annotation, str):
        try:
            parsed = ast.parse(annotation, mode='eval').body
        except (SyntaxError, ValueError, TypeError):
            return []
        if not isinstance(parsed, ast.Subscript):
            return []
        base = parsed.value
        is_literal = (
            isinstance(base, ast.Name) and base.id == 'Literal'
        ) or (
            isinstance(base, ast.Attribute) and base.attr == 'Literal'
        )
        if not is_literal:
            return []
        elements = list(parsed.slice.elts) if isinstance(parsed.slice, ast.Tuple) else [parsed.slice]
        for element in elements:
            if not isinstance(element, ast.Constant) or not isinstance(element.value, (str, int, float, bool, type(None))):
                return []
            values.append(element.value)
    else:
        return []

    unique, seen = [], set()
    for value in values:
        if not isinstance(value, (str, int, float, bool, type(None))):
            return []
        key = (type(value), repr(value))
        if key not in seen:
            seen.add(key)
            unique.append(value)
    return unique[:8]


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

    target = find_selected_ast_function(tree, func_name)
    if target is None:
        return []

    annotations = annotations or {}
    candidates = {name: [] for name in parameter_names}
    joint_assignments = []

    def add(name, value):
        if value not in candidates[name]:
            candidates[name].append(value)

    def compare_components(node):
        """Resolve a direct parameter comparison to parameter, kind, op, rhs."""
        if not isinstance(node, ast.Compare) or len(node.ops) != 1 or len(node.comparators) != 1:
            return None
        subject = _condition_subject(node.left, parameter_names)
        operator = node.ops[0]
        right = node.comparators[0]
        if not subject:
            subject = _condition_subject(right, parameter_names)
            if not subject or not _is_scalar_literal_node(node.left):
                return None
            operator = _reversed_comparison_operator(operator)
            if operator is None:
                return None
            right = node.left
        return subject[0], subject[1], operator, right

    def satisfying_assignment(node):
        """Produce one syntax-proven truth input for a direct condition.

        The result is only an execution candidate. It deliberately does not
        imply the target's output or that a larger boolean expression is
        reachable in every runtime environment.
        """
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            subject = _condition_subject(node.operand, parameter_names)
            if subject and subject[1] == 'value':
                annotation = str(annotations.get(subject[0], '')).lower()
                return subject[0], '' if 'str' in annotation else 0

        parts = compare_components(node)
        if not parts:
            return None
        name, subject_kind, operator, right = parts
        if isinstance(operator, (ast.In, ast.NotIn)) and subject_kind == 'value' and isinstance(right, (ast.List, ast.Tuple, ast.Set)):
            literals = [_literal_value(item) for item in right.elts]
            valid = [item for item in literals if item is not None]
            if not valid:
                return None
            if isinstance(operator, ast.In):
                return name, valid[0]
            if any(isinstance(item, str) for item in valid):
                return name, '__other_value__'
            numeric = [item for item in valid if isinstance(item, (int, float)) and not isinstance(item, bool)]
            return (name, max(numeric) + 1) if numeric else None

        literal = _literal_value(right)
        if not _is_scalar_literal_node(right):
            return None
        if subject_kind == 'length':
            if not isinstance(literal, int) or isinstance(literal, bool) or literal < 0:
                return None
            if isinstance(operator, (ast.Lt, ast.LtE)):
                length = max(0, literal - 1) if isinstance(operator, ast.Lt) else literal
            elif isinstance(operator, (ast.Gt, ast.GtE)):
                length = literal + 1 if isinstance(operator, ast.Gt) else literal
            elif isinstance(operator, (ast.Eq, ast.Is)):
                length = literal
            elif isinstance(operator, (ast.NotEq, ast.IsNot)):
                length = literal + 1
            else:
                return None
            return name, 'x' * length

        if isinstance(operator, (ast.Eq, ast.Is)):
            return name, literal
        if isinstance(operator, (ast.NotEq, ast.IsNot)):
            if isinstance(literal, str):
                return name, '__other_value__'
            if isinstance(literal, bool):
                return name, not literal
            if literal is None:
                annotation = str(annotations.get(name, '')).lower()
                return name, '' if 'str' in annotation else 0
            if isinstance(literal, (int, float)):
                return name, literal + 1
            return None
        if isinstance(literal, (int, float)) and not isinstance(literal, bool):
            if isinstance(operator, ast.Lt):
                return name, literal - 1
            if isinstance(operator, ast.LtE):
                return name, literal
            if isinstance(operator, ast.Gt):
                return name, literal + 1
            if isinstance(operator, ast.GtE):
                return name, literal
        return None

    def flattened_and_terms(node):
        if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.And):
            terms = []
            for value in node.values:
                terms.extend(flattened_and_terms(value))
            return terms
        return [node]

    scoped_nodes = selected_function_scope_nodes(target)
    for node in scoped_nodes:
        match_type = getattr(ast, 'Match', ())
        if match_type and isinstance(node, match_type):
            subject = _condition_subject(node.subject, parameter_names)
            if subject and subject[1] == 'value':
                name = subject[0]
                literals = []
                for case in node.cases:
                    if case.guard is None:
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

        parts = compare_components(node)
        if not parts:
            continue
        name, subject_kind, operator, right = parts

        if isinstance(operator, (ast.In, ast.NotIn)) and subject_kind == 'value' and isinstance(right, (ast.List, ast.Tuple, ast.Set)):
            literal_items = [_literal_value(item) for item in right.elts]
            for item in literal_items:
                if item is not None:
                    add(name, item)
            if any(isinstance(item, str) for item in literal_items):
                add(name, '__other_value__')
            continue

        literal = _literal_value(right)
        if not _is_scalar_literal_node(right):
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

    # A one-parameter-at-a-time probe cannot reach ``a == X and b == Y`` when
    # the baseline values satisfy neither side. Build only the jointly true
    # inputs that direct syntax proves, then let real tracing establish results.
    for node in scoped_nodes:
        if not isinstance(node, ast.BoolOp) or not isinstance(node.op, ast.And):
            continue
        assignments = {}
        for term in flattened_and_terms(node):
            assignment = satisfying_assignment(term)
            if assignment is None:
                assignments = None
                break
            name, value = assignment
            if name in assignments and assignments[name] != value:
                assignments = None
                break
            assignments[name] = value
        if assignments and len(assignments) >= 2 and assignments not in joint_assignments:
            joint_assignments.append(assignments)

    if not any(candidates.values()):
        return []

    def default_value(name):
        declared_values = literal_annotation_values(annotations.get(name))
        if declared_values:
            return declared_values[0]
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
    # Keep conjunction candidates first so the bounded probe budget cannot
    # crowd out a branch that requires multiple parameters to cooperate.
    results = []
    for assignment in joint_assignments:
        values = dict(baseline)
        values.update(assignment)
        results.append(build_input(values))
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
        raw_annotation = (annotations or {}).get(arg_name, '')
        declared_values = literal_annotation_values(raw_annotation)
        if declared_values:
            per_arg_candidates.append(declared_values)
            continue
        annotation = str(raw_annotation).lower()
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

    # Two independent numeric inputs often need different relative magnitudes
    # to expose arithmetic or comparison branches. Zip-style probes only use
    # matching positions (for example 50, 50), which can miss those branches.
    # Add a tiny fixed set of domain-neutral scale pairs. We do this only when
    # there are exactly two non-string/non-boolean parameters, so ordinary
    # string APIs and higher-arity functions do not get an input explosion.
    def numeric_or_unknown(name):
        annotation = str((annotations or {}).get(name, '')).lower()
        return 'str' not in annotation and 'bool' not in annotation

    if len(all_args) == 2 and all(numeric_or_unknown(name) for name in all_args):
        relative_scale_pairs = [
            (10, 200),
            (50, 150),
            (100, 200),
            (200, 100),
        ]
        results.extend(build_input(pair) for pair in relative_scale_pairs)

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
    except Exception as sig_err:
        print(f"[dynamic_tracer] warning: could not inspect signature for {func_name!r}: {sig_err}", file=sys.stderr)

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
    constructor_template = None
    # Call-site AST facts can safely establish how to instantiate the selected
    # class. Keep them separate from the member arguments: ``Service('x').run
    # (1)`` means constructor=['x'] and method=[1], never run('x', 1).
    if func_is_method or func_is_property:
        for candidate in caller_inputs:
            if not isinstance(candidate, dict):
                continue
            constructor_args = candidate.get('constructor_args')
            constructor_kwargs = candidate.get('constructor_kwargs')
            if isinstance(constructor_args, (list, tuple)) and isinstance(constructor_kwargs, dict):
                constructor_template = {
                    'constructor_args': list(constructor_args),
                    'constructor_kwargs': dict(constructor_kwargs)
                }
                break
    coverage_inputs = list(guided_inputs)
    if test_inputs is None:
        coverage_inputs.extend(infer_boundary_inputs(
            positional,
            inferred_annotations,
            keyword_only
        ))
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
        serialized = json.dumps(candidate, sort_keys=True, default=repr)
        if serialized not in seen_inputs:
            seen_inputs.add(serialized)
            merged_inputs.append(candidate)
    test_inputs = merged_inputs

    # 執行每個測試輸入。呼叫站提供的字面值可包含 args/kwargs；舊格式 list
    # 仍相容，避免將 AST 變數名稱當成真實字串輸入。
    for inp in test_inputs:
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
        try:
            # Keep stdout/stderr from constructors, target calls and generator
            # materialisation out of the JSON document printed by this script.
            with block_trace_side_effects(), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if func_is_method or func_is_property:
                    # 將 class 實例化後呼叫 method
                    cls_obj = getattr(module, method_class_name)
                    try:
                        instance = cls_obj(*constructor_args, **constructor_kwargs)
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
                        ret = getattr(instance, selected_method_name)
                    else:
                        ret = getattr(instance, selected_method_name)(*inp, **kwargs)
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
            formatted_constructor_args = [trace_repr_with_oracle(argument) for argument in constructor_args]
            formatted_constructor_kwargs = {
                name: trace_repr_with_oracle(value)
                for name, value in constructor_kwargs.items()
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
                formatted_constructor_args = [trace_repr_with_oracle(argument) for argument in constructor_args]
                formatted_constructor_kwargs = {
                    name: trace_repr_with_oracle(value)
                    for name, value in constructor_kwargs.items()
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
