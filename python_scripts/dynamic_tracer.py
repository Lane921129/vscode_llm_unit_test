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
import subprocess
import asyncio
import inspect
import itertools
import io
import math
import typing
import types
import traceback
import time
import hashlib
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from trace_observation_guard import observe_ambient_reads
from trace_value_codec import snapshot_value, snapshot_call, restore_value, safe_type_name, type_field
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
    equality, numeric boundaries, length boundaries, and direct annotated
    boolean truthiness checks, without encoding domain vocabulary or attempting
    to execute source expressions.
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

        # Only a direct ``if enabled`` / ``if not enabled`` condition backed
        # by a bool annotation warrants both boolean probes.  Inferring bool
        # from an unannotated truthiness check would be a type guess: the
        # parameter could instead be a string, collection, or custom object.
        if isinstance(node, (ast.If, ast.While, ast.IfExp)):
            boolean_parameter = None
            if isinstance(node.test, ast.Name) and node.test.id in parameter_names:
                boolean_parameter = node.test.id
            elif (
                isinstance(node.test, ast.UnaryOp)
                and isinstance(node.test.op, ast.Not)
                and isinstance(node.test.operand, ast.Name)
                and node.test.operand.id in parameter_names
            ):
                boolean_parameter = node.test.operand.id
            if boolean_parameter and 'bool' in str(annotations.get(boolean_parameter, '')).lower():
                add(boolean_parameter, True)
                add(boolean_parameter, False)

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
    module_parts = package_parts if package_parts and target.stem == '__init__' else package_parts + [target.stem]
    module_name = '.'.join(module_parts)
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
    except (Exception, SystemExit):
        sys.modules.pop(module_name, None)
        raise
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
    guided_inputs = [] if exact_inputs else infer_condition_guided_inputs(
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
    def sourced(candidate, detail):
        candidate = dict(candidate) if type(candidate) is dict else {'args': list(candidate), 'kwargs': {}}
        candidate['source'] = {'kind': 'source_guided', 'detail': detail}
        return candidate

    coverage_inputs = [sourced(candidate, 'condition') for candidate in guided_inputs]
    if test_inputs is None and not exact_inputs:
        coverage_inputs.extend(sourced(candidate, 'type_boundary') for candidate in infer_boundary_inputs(
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
                   progress_path=None) -> dict:
    """Plan in one guarded worker, then execute each case in a fresh process.

    Deadlines include imports and setup. Completed cases are appended to an
    optional host-owned JSONL journal immediately; target workers never see it.
    This is process state isolation, not an OS sandbox for hostile native code.
    """
    def positive_timeout(value, fallback):
        return min(float(value), 300.0) if type(value) in (int, float) and math.isfinite(value) and value > 0 else fallback

    case_timeout = positive_timeout(case_timeout_seconds, 2.0)
    total_timeout = positive_timeout(total_timeout_seconds, 12.0)
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
    supplied = None if test_inputs is None else [snapshot_value(candidate) for candidate in test_inputs]
    valid_supplied = None if supplied is None else [value for value in supplied if value['replayable']]
    invalid_supplied = [] if supplied is None else [value for value in supplied if not value['replayable']]

    def case_base(encoded, index):
        digest = hashlib.sha256((os.path.abspath(file_path) + '\n' + func_name + '\n' + json.dumps(encoded, sort_keys=True)).encode()).hexdigest()[:20]
        if encoded.get('replayable'):
            before, source = _candidate_context(restore_value(encoded))
        else:
            before, source = {'unavailable_input': encoded}, {'kind': 'unknown'}
        # The digest identifies input content; run/index identifies this actual
        # attempt, including duplicate supplied inputs when planning fails.
        return {'case_id': f'probe-{run_id}-{index}-{digest}', 'case_index': index, 'source': source,
                'input_before': before, 'input_after': None, 'duration_ms': 0}

    def append_case(case, observations=None):
        observations = observations or {}
        examples, errors = observations.get('examples', []), observations.get('errors', [])
        for record in examples + errors:
            record['case_id'] = case['case_id']
            record['source'] = case['source']
        result['cases'].append(case)
        result['examples'].extend(examples)
        result['errors'].extend(errors)
        blocked = observations.get('blocked_operations', [])
        for operation in blocked:
            if operation not in result['blocked_operations']:
                result['blocked_operations'].append(operation)
        journal('case_completed', case=case, examples=examples, errors=errors, blocked_operations=blocked)

    for index, encoded in enumerate(invalid_supplied):
        case = case_base(encoded, index)
        case.update(status='not_started', reason='unsupported-input-snapshot')
        append_case(case)

    plan_started = time.monotonic()
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired('trace planning', total_timeout)
        planned = _worker_result({'mode': 'plan', 'file_path': file_path, 'func_name': func_name,
                                  'inputs': valid_supplied}, min(5.0, remaining))
        result['args'] = planned.get('args', [])
        result['load_error'] = planned.get('load_error')
        if planned.get('load_diagnostic'):
            result['load_diagnostic'] = planned['load_diagnostic']
        result['blocked_operations'] = planned.get('blocked_operations', [])
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
    pending = planned.get('planned_inputs', []) if not result['load_error'] else (valid_supplied or [])
    journal('planning_completed', planning=result['planning'], args=result['args'], load_error=result['load_error'],
            load_diagnostic=result.get('load_diagnostic'), blocked_operations=result['blocked_operations'],
            planned_cases=[case_base(encoded, index + len(invalid_supplied)) for index, encoded in enumerate(pending)])
    for index, encoded in enumerate(pending):
        case = case_base(encoded, index + len(invalid_supplied))
        if result['load_error']:
            case.update(status='not_started', reason='planning-unavailable')
            append_case(case)
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            case.update(status='not_started', reason='total-deadline')
            append_case(case)
            continue
        if not encoded.get('replayable'):
            case.update(status='not_started', reason='unsupported-input-snapshot')
            append_case(case)
            continue
        case_started = time.monotonic()
        observations = None
        journal('case_started', case=case)
        try:
            observations = _worker_result({'mode': 'case', 'file_path': file_path,
                                           'func_name': func_name, 'inputs': [encoded]}, min(case_timeout, remaining))
            completed_cases = observations.get('cases', [])
            if len(completed_cases) != 1:
                case.update(status='setup_error' if observations.get('load_error') else 'worker_error',
                            reason='case-import-failed' if observations.get('load_error') else 'missing-case-result',
                            diagnostic=observations.get('load_error'))
            else:
                case.update({key: value for key, value in completed_cases[0].items() if key not in ('case_id', 'case_index')})
        except subprocess.TimeoutExpired:
            case.update(status='timeout', reason='total-deadline' if remaining < case_timeout else 'case-deadline')
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
            test_inputs = json.loads(sys.argv[3])
        except Exception:
            pass

    options = {}
    if len(sys.argv) >= 5:
        try:
            supplied_options = json.loads(sys.argv[4])
            if type(supplied_options) is dict:
                options = {name: supplied_options[name] for name in (
                    'case_timeout_seconds', 'total_timeout_seconds', 'progress_path') if name in supplied_options}
        except (ValueError, TypeError):
            pass
    output = trace_function(file_path, func_name, test_inputs, **options)
    print(json.dumps(output, ensure_ascii=False))
