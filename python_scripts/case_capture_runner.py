"""Capture one case-table row: patch its mocks, call the real target, record the outcome.

stdin:  {"version": "case-capture-request-v1", "file": ..., "target": "func" | "Class.method",
         "importPaths": [...], "dependencies": [{"name", "patch", "chain", "create"?}, ...],
         "row": {"id", "args", "kwargs", "setup"?, "mocks": [{"dependency", "behavior", "value"}]}}
stdout: {"version": "case-capture-v1", "id": ..., "status": "captured" | "capture-failed",
         "reason"?: ..., "actual"?: {"kind": "return" | "raise", "value": ...}, "exception"?: {...}}

One process per row, so module state never leaks between rows. The module is
imported and the target called inside runtime_policy.guarded_runtime, the same
external-operation guard the generated test runner uses. Mocks are patched where
the target looks them up (its module namespace), following the dependency
facts from case_table_facts.py; local call chains are configured on a MagicMock.
"""
import ast
import asyncio
import builtins
import importlib
import inspect
import json
import os
import sys
from contextlib import ExitStack
from unittest import mock

# Writing __pycache__ would be an external write under the guard (the runner is also launched with -B).
sys.dont_write_bytecode = True

REQUEST_VERSION = 'case-capture-request-v1'
REPORT_VERSION = 'case-capture-v1'


class CaptureFailure(Exception):
    def __init__(self, reason, detail=''):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _resolve(root, dotted):
    obj = root
    for part in dotted.split('.'):
        obj = getattr(obj, part)
    return obj


def resolve_exception(name, module):
    candidate = getattr(builtins, name, None) if '.' not in name else None
    if candidate is None:
        try:
            candidate = _resolve(module, name)
        except AttributeError:
            candidate = None
    if not (isinstance(candidate, type) and issubclass(candidate, BaseException)):
        raise CaptureFailure('mock-exception-unknown', name)
    return candidate


def exception_reference(exc_type, module):
    """How a generated test can name the exception class: builtin, or a path from the target module."""
    if getattr(builtins, exc_type.__name__, None) is exc_type:
        return {'kind': 'builtin', 'path': exc_type.__name__}
    namespace = vars(module)
    for key, value in namespace.items():
        if value is exc_type:
            return {'kind': 'module', 'path': key}
    for key, value in namespace.items():
        if inspect.ismodule(value) and getattr(value, exc_type.__name__, None) is exc_type:
            return {'kind': 'module', 'path': f'{key}.{exc_type.__name__}'}
    return None


def _literal(text, reason):
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        raise CaptureFailure(reason, str(text)[:80])


def build_patches(module, row, dependencies):
    """Return [(parent, attribute, replacement, create)] for the row's mocks."""
    by_name = {item['name']: item for item in dependencies}
    roots, direct = {}, set()
    for entry in row.get('mocks', []):
        dependency = by_name.get(entry['dependency'])
        if dependency is None:
            raise CaptureFailure('unknown-dependency', entry['dependency'])
        root = dependency['patch']
        target_mock = roots.setdefault(root, (mock.MagicMock(), bool(dependency.get('create'))))[0]
        chain = dependency.get('chain') or []
        if chain:
            if root in direct:
                raise CaptureFailure('mock-conflict', root)
            node = target_mock
            for step in chain[:-1]:
                node = node.return_value if step == '()' else getattr(node, step)
            node = node.return_value if chain[-1] == '()' else getattr(node, chain[-1])
        else:
            if root in direct:
                raise CaptureFailure('mock-conflict', root)
            direct.add(root)
            node = target_mock
        if entry['behavior'] == 'raise':
            node.side_effect = resolve_exception(entry['value'], module)
        else:
            node.return_value = _literal(entry['value'], 'mock-value-not-literal')
    patches = []
    for root, (replacement, create) in roots.items():
        parts = root.split('.')
        try:
            parent = _resolve(module, '.'.join(parts[:-1])) if len(parts) > 1 else module
            if not create:
                getattr(parent, parts[-1])
        except AttributeError:
            raise CaptureFailure('patch-target-missing', root)
        patches.append((parent, parts[-1], replacement, create))
    return patches


def is_literal(value):
    try:
        text = repr(value)
        return type(ast.literal_eval(text)) is type(value) and ast.literal_eval(text) == value, text
    except Exception:  # repr or comparison of arbitrary objects may raise anything
        return False, None


def capture(request):
    if request.get('version') != REQUEST_VERSION:
        return {'version': REPORT_VERSION, 'error': 'invalid-request'}
    row = request['row']
    report = {'version': REPORT_VERSION, 'id': row.get('id')}
    file, target = request['file'], request['target']
    if row.get('setup'):
        from case_row_assertions import validate_setup
        verdict = validate_setup({'setup': row['setup'], 'module': os.path.splitext(os.path.basename(file))[0], 'target': target})
        if not verdict['accepted']:
            return {**report, 'status': 'capture-failed', 'reason': 'setup-forbidden-mutation'}
    import_paths = [path for path in request.get('importPaths', []) if isinstance(path, str)]
    from runtime_policy import RuntimePolicyError, guarded_runtime
    try:
        with guarded_runtime(import_paths=import_paths or [os.path.dirname(file)]):
            for path in reversed(import_paths or [os.path.dirname(file)]):
                if path not in sys.path:
                    sys.path.insert(0, path)
            try:
                module = importlib.import_module(os.path.splitext(os.path.basename(file))[0])
            except RuntimePolicyError:
                raise
            except Exception as failure:  # the target module itself fails to import
                raise CaptureFailure('module-import-failed', type(failure).__name__)
            parts = target.split('.')
            owner = _resolve(module, '.'.join(parts[:-1])) if len(parts) > 1 else None
            static_kind = inspect.getattr_static(owner, parts[-1], None) if owner is not None else None
            namespace = {'target_module': module, 'mock': mock}
            if row.get('setup'):
                try:
                    exec(compile(row['setup'], '<case-row-setup>', 'exec'), namespace)
                except RuntimePolicyError:
                    raise
                except Exception as failure:
                    raise CaptureFailure('setup-failed', type(failure).__name__)
                args = namespace.get('args', ())
                kwargs = namespace.get('kwargs', {})
                if not isinstance(args, tuple) or not isinstance(kwargs, dict):
                    raise CaptureFailure('setup-invalid', 'setup must define args (tuple) and kwargs (dict)')
            else:
                args = _literal(row.get('args', '()'), 'args-not-literal')
                kwargs = _literal(row.get('kwargs') or '{}', 'kwargs-not-literal')
                if not isinstance(args, tuple):
                    args = (args,)
            if owner is not None and inspect.isclass(owner) and not isinstance(static_kind, (staticmethod, classmethod)):
                instance = namespace.get('instance')
                if instance is None:
                    raise CaptureFailure('instance-required')
                callable_target = getattr(instance, parts[-1])
            else:
                callable_target = _resolve(module, target)
            with ExitStack() as stack:
                for parent, attribute, replacement, create in build_patches(module, row, request.get('dependencies', [])):
                    stack.enter_context(mock.patch.object(parent, attribute, replacement, create=create))
                try:
                    result = callable_target(*args, **kwargs)
                    if inspect.iscoroutine(result):
                        result = asyncio.run(result)
                except RuntimePolicyError:
                    raise
                except Exception as failure:  # the observed outcome of the real target
                    exc_type = type(failure)
                    report.update(status='captured', actual={'kind': 'raise', 'value': exc_type.__name__},
                                  exception={'name': exc_type.__name__,
                                             'mro': [cls.__name__ for cls in exc_type.__mro__ if cls is not object],
                                             'reference': exception_reference(exc_type, module)})
                    return report
            literal, text = is_literal(result)
            if not literal:
                raise CaptureFailure('return-not-literal', type(result).__name__)
            report.update(status='captured', actual={'kind': 'return', 'value': text})
            return report
    except CaptureFailure as failure:
        report.update(status='capture-failed', reason=failure.reason)
        if failure.detail:
            report['detail'] = failure.detail
        return report
    except RuntimePolicyError:
        report.update(status='capture-failed', reason='isolation-blocked')
        return report


def main(stdin=None, stdout=None):
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    try:
        request = json.loads(stdin.read())
        report = capture(request)
    except (ValueError, KeyError, TypeError):
        report = {'version': REPORT_VERSION, 'error': 'invalid-request'}
    stdout.write(json.dumps(report, ensure_ascii=False))
    return 1 if 'error' in report else 0


if __name__ == '__main__':
    sys.exit(main())
