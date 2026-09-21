"""Read-only interpreter/package inspection; target imports retain the regular safety gate."""
import ast
import importlib
import io
import json
import os
import sys
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

from module_preflight import preflight


def target_module(file):
    """Match the regular resolver's package/namespace-import rules without executing source."""
    target = Path(file)
    directory = target.parent
    parts = []
    while (directory / '__init__.py').is_file():
        parts.insert(0, directory.name)
        directory = directory.parent
    if parts:
        return '.'.join(parts if target.stem == '__init__' else parts + [target.stem])
    tree = ast.parse(target.read_text(encoding='utf-8-sig'))
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            imported = (node.module or '').split('.')
            if target.parent.name in imported:
                index = len(imported) - 1 - imported[::-1].index(target.parent.name)
                return '.'.join(imported[:index + 1] + [target.stem])
            if node.level == 1:
                return target.parent.name + '.' + target.stem
        elif isinstance(node, ast.Import):
            for alias in node.names:
                imported = alias.name.split('.')
                if target.parent.name in imported:
                    index = len(imported) - 1 - imported[::-1].index(target.parent.name)
                    return '.'.join(imported[:index + 1] + [target.stem])
    return target.stem


def inspect_environment(payload):
    try:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            importlib.import_module('coverage')
        coverage = True
    except (Exception, SystemExit):
        coverage = False
    result = {'python': sys.executable, 'version': list(sys.version_info[:3]),
              'virtual': sys.prefix != sys.base_prefix, 'coverage': coverage}
    if payload.get('scanRoot'):
        from dependency_inventory import inventory
        scan = inventory(payload['scanRoot'], payload.get('sourceRoot'), payload.get('excludedPaths', []))
        status = 'import-error' if not scan['complete'] else 'missing' if scan['missing'] else 'ready'
        return dict(result, status=status, inventory=scan,
                    missing=next(iter(scan['missing']), None), stage='dependency-scan')
    if not payload.get('file'):
        return dict(result, status='interpreter-only')
    try:
        payload = dict(payload, module=target_module(payload['file']))
    except (SyntaxError, OSError, UnicodeError):
        return dict(result, status='import-error', stage='static-analysis')
    check = preflight(payload)
    if check.get('ok'):
        return dict(result, status='ready')
    diagnostic = check.get('diagnostic') or {}
    missing = diagnostic.get('missing_module')
    if diagnostic.get('exception_type') == 'ModuleNotFoundError' and isinstance(missing, str):
        top = missing.split('.')[0]
        roots = [*payload.get('importPaths', []), payload.get('sourceRoot', '')]
        local = any(root and (os.path.exists(os.path.join(root, top + '.py')) or
                              os.path.isdir(os.path.join(root, top))) for root in roots)
        if top in getattr(sys, 'stdlib_module_names', ()):
            kind = 'stdlib'
        elif local or '.' in missing or top == payload['module'].split('.')[0]:
            kind = 'local-or-submodule'
        else:
            kind = 'missing'
        return dict(result, status=kind, missing=missing)
    # Never copy a traceback, source, or arbitrary exception message into setup logs.
    return dict(result, status='blocked' if diagnostic.get('blocked_operation') else 'import-error',
                stage=check.get('stage'), operation=diagnostic.get('blocked_operation'),
                origin=diagnostic.get('origin'))


if __name__ == '__main__':
    print(json.dumps(inspect_environment(json.loads(sys.stdin.read())), ensure_ascii=False))
