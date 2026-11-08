"""Validate case-table-v1 rows against the target's real signature and dependencies.

Reads one JSON request on stdin and writes one JSON report on stdout:

    request: {"version": "case-row-validation-request-v1", "source": "<module text>",
              "target": "func" | "Class.method", "dependencies": ["db.fetchone", ...],
              "rows": [{"id": "C1", "args": "(1,)", "kwargs": "{}", "mocks": [...]},
                       {"id": "C2", "needsSetup": "...", "mocks": [...]}]}
    report:  {"version": "case-row-validation-v1", "results": [{"id": "C1", "valid": true}, ...]}

The target module is parsed, never imported or executed: the signature is rebuilt
from the AST as a parameter-only stub, so binding checks cannot run user code.
Each row is judged on its own; a bad row never changes another row's verdict.
"""
import ast
import inspect
import json
import re
import sys

REQUEST_VERSION = 'case-row-validation-request-v1'
REPORT_VERSION = 'case-row-validation-v1'
MAX_LITERAL_CHARS = 20000
DOTTED_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$')
_STUB_NAME = '__case_row_target__'


class RequestError(Exception):
    """The request itself is unusable (tool problem), as opposed to an invalid row."""


class RowRejection(Exception):
    def __init__(self, reason, detail=''):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _decorator_names(node):
    names = set()
    for decorator in node.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        if isinstance(target, ast.Name):
            names.add(target.id)
        elif isinstance(target, ast.Attribute):
            names.add(target.attr)
    return names


def _find_definition(tree, target):
    """Return (function node, is_method) for `func` or `Class.method` (nested classes allowed)."""
    parts = target.split('.')
    body = tree.body
    for index, name in enumerate(parts):
        last = index == len(parts) - 1
        kinds = (ast.FunctionDef, ast.AsyncFunctionDef) if last else (ast.ClassDef,)
        matches = [node for node in body if isinstance(node, kinds) and node.name == name]
        if not matches:
            raise RequestError('target-not-found')
        node = matches[-1]  # Python keeps the last definition of a name.
        if last:
            return node, index > 0
        body = node.body
    raise RequestError('target-not-found')


def _strip_bound_parameter(arguments):
    """Drop self/cls, which the caller never passes."""
    if arguments.posonlyargs:
        arguments.posonlyargs = arguments.posonlyargs[1:]
    elif arguments.args:
        arguments.args = arguments.args[1:]
        if len(arguments.defaults) > len(arguments.args):
            arguments.defaults = arguments.defaults[1:]


def target_signature(source, target):
    """Build an inspect.Signature for the target from source text without executing it."""
    if not isinstance(target, str) or not DOTTED_NAME.match(target):
        raise RequestError('invalid-target')
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        raise RequestError('source-syntax-error')
    node, is_method = _find_definition(tree, target)
    arguments = ast.arguments(
        posonlyargs=[ast.arg(arg=item.arg) for item in node.args.posonlyargs],
        args=[ast.arg(arg=item.arg) for item in node.args.args],
        vararg=ast.arg(arg=node.args.vararg.arg) if node.args.vararg else None,
        kwonlyargs=[ast.arg(arg=item.arg) for item in node.args.kwonlyargs],
        kw_defaults=[None if default is None else ast.Constant(value=None) for default in node.args.kw_defaults],
        kwarg=ast.arg(arg=node.args.kwarg.arg) if node.args.kwarg else None,
        defaults=[ast.Constant(value=None) for _ in node.args.defaults],
    )
    if is_method and 'staticmethod' not in _decorator_names(node):
        _strip_bound_parameter(arguments)
    # Unparse the parameter list into source so the stub does not depend on
    # version-specific FunctionDef fields (e.g. type_params in Python 3.12+).
    stub = f'def {_STUB_NAME}({ast.unparse(arguments)}):\n    pass\n'
    namespace = {}
    exec(compile(stub, '<case-row-signature>', 'exec'), {'__builtins__': {}}, namespace)
    return inspect.signature(namespace[_STUB_NAME])


def _literal(text, field):
    if not isinstance(text, str):
        raise RowRejection('invalid-row', f'{field} must be a string')
    if len(text) > MAX_LITERAL_CHARS:
        raise RowRejection(f'{field}-too-long')
    try:
        return ast.literal_eval(text.strip())
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        raise RowRejection(f'{field}-not-literal')


def _check_call(row, signature):
    args = _literal(row.get('args'), 'args')
    if not isinstance(args, tuple):
        raise RowRejection('args-not-tuple')
    kwargs = _literal(row.get('kwargs', '{}'), 'kwargs')
    if not isinstance(kwargs, dict) or not all(isinstance(key, str) for key in kwargs):
        raise RowRejection('kwargs-not-dict')
    try:
        signature.bind(*args, **kwargs)
    except TypeError as failure:
        raise RowRejection('signature-mismatch', str(failure))


def _check_mocks(mocks, dependencies):
    if not isinstance(mocks, list):
        raise RowRejection('invalid-row', 'mocks must be a list')
    for mock in mocks:
        if not isinstance(mock, dict):
            raise RowRejection('invalid-row', 'each mock must be an object')
        dependency, behavior, value = mock.get('dependency'), mock.get('behavior'), mock.get('value')
        if not isinstance(dependency, str) or dependency not in dependencies:
            raise RowRejection('unknown-dependency', str(dependency))
        if behavior == 'raise':
            if not isinstance(value, str) or not DOTTED_NAME.match(value):
                raise RowRejection('mock-exception-invalid', str(value))
        elif behavior == 'return':
            _literal(value, 'mock-value')
        else:
            raise RowRejection('invalid-row', 'mock behavior must be return or raise')


def validate_row(row, signature, dependencies):
    """Return the verdict for one row; never raises for row content."""
    row_id = row.get('id') if isinstance(row, dict) else None
    try:
        if not isinstance(row_id, str) or not row_id:
            raise RowRejection('invalid-row', 'row id must be a non-empty string')
        setup = row.get('needsSetup')
        if setup is not None:
            if not isinstance(setup, str) or not setup.strip():
                raise RowRejection('invalid-row', 'needsSetup must be a non-empty string')
        else:
            _check_call(row, signature)
        _check_mocks(row.get('mocks', []), dependencies)
    except RowRejection as rejection:
        verdict = {'id': row_id, 'valid': False, 'reason': rejection.reason}
        if rejection.detail:
            verdict['detail'] = rejection.detail
        return verdict
    return {'id': row_id, 'valid': True}


def validate_request(request):
    """Validate every row of a request; request-level problems produce {"error": code}."""
    try:
        if not isinstance(request, dict) or request.get('version') != REQUEST_VERSION:
            raise RequestError('invalid-request')
        source, rows, dependencies = request.get('source'), request.get('rows'), request.get('dependencies')
        if not isinstance(source, str) or not isinstance(rows, list) or not isinstance(dependencies, list) \
                or not all(isinstance(name, str) for name in dependencies):
            raise RequestError('invalid-request')
        signature = target_signature(source, request.get('target'))
    except RequestError as failure:
        return {'version': REPORT_VERSION, 'error': str(failure)}
    known = set(dependencies)
    return {'version': REPORT_VERSION, 'target': request['target'],
            'results': [validate_row(row, signature, known) for row in rows]}


def main(stdin=None, stdout=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    try:
        request = json.loads(stdin.read())
    except ValueError:
        report = {'version': REPORT_VERSION, 'error': 'invalid-json'}
    else:
        report = validate_request(request)
    stdout.write(json.dumps(report, ensure_ascii=False))
    return 1 if 'error' in report else 0


if __name__ == '__main__':
    sys.exit(main())
