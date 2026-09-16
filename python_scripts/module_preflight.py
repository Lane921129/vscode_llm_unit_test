"""Load the canonical target in a fresh, side-effect-guarded process before LLM work."""
import importlib
import io
import json
import keyword
import os
import sys
from contextlib import redirect_stdout, redirect_stderr
from dynamic_tracer import block_trace_side_effects, import_diagnostic, package_module_context


def preflight(payload):
    target = os.path.realpath(payload['file'])
    module_name = payload['module']
    if not module_name or any(not part.isidentifier() or keyword.iskeyword(part) for part in module_name.split('.')):
        return {'ok': False, 'category': 'environment', 'stage': 'module-resolution',
                'reason': f'Invalid Python module path: {module_name}'}
    _, package_root, _ = package_module_context(target)
    roots = list(dict.fromkeys([*payload.get('importPaths', []), package_root]))
    sys.path[:0] = roots
    sys.dont_write_bytecode = True
    try:
        with block_trace_side_effects(), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            module = importlib.import_module(module_name)
        actual = getattr(module, '__file__', None)
        if not actual or os.path.normcase(os.path.realpath(actual)) != os.path.normcase(target):
            return {'ok': False, 'category': 'environment', 'stage': 'module-resolution',
                    'reason': f'Canonical import {module_name} does not resolve to the selected source file.'}
        return {'ok': True, 'module': module_name, 'importPaths': roots}
    except (Exception, SystemExit) as error:
        diagnostic = import_diagnostic(error)
        return {'ok': False, 'category': 'environment', 'stage': 'module-import',
                'reason': f'{type(error).__name__}: {error}', 'diagnostic': diagnostic}


if __name__ == '__main__':
    print(json.dumps(preflight(json.loads(sys.stdin.read())), ensure_ascii=False))
