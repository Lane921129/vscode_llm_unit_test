"""Load the canonical target in a fresh, side-effect-guarded process before LLM work."""
import importlib
import io
import json
import keyword
import os
import sys
import types
from contextlib import redirect_stdout, redirect_stderr
from dynamic_tracer import TraceSafetyError, import_diagnostic, package_module_context, safe_type_name, exception_message
from runtime_policy import POLICY_VERSION, guarded_runtime
from import_fixtures import evidence as import_fixture_evidence


def resolve_loaded_dependencies(module, dependencies, source_root):
    """Use the modules actually loaded by the guarded import, never guess a batch root.

    Only ordinary Python functions defined in that module and inside the selected
    source tree can supply source. No new imports or dynamic attributes execute.
    """
    resolved = []
    root = os.path.realpath(source_root)
    for dependency in dependencies:
        item = {key: dependency.get(key) for key in ('module', 'name', 'level')}
        try:
            name = '.' * (dependency.get('level') or 0) + dependency['module']
            absolute = importlib.util.resolve_name(name, vars(module).get('__package__')) if name.startswith('.') else name
            loaded = sys.modules.get(absolute)
            namespace = vars(loaded) if type(loaded) is types.ModuleType else {}
            origin = namespace.get('__file__')
            symbol = namespace.get(dependency['name'])
            if not origin or type(symbol) is not types.FunctionType:
                item['reason'] = 'unresolved-loaded-function'
            elif symbol.__module__ != absolute or symbol.__name__ != dependency['name']:
                item['reason'] = 'reexported-or-rebound-function'
            else:
                file = os.path.realpath(origin)
                if not file.endswith('.py') or os.path.normcase(os.path.realpath(symbol.__code__.co_filename)) != os.path.normcase(file):
                    item['reason'] = 'dynamic-or-non-source-function'
                elif os.path.commonpath([os.path.normcase(root), os.path.normcase(file)]) != os.path.normcase(root):
                    item['reason'] = 'outside-selected-source-tree'
                else:
                    item.update(file=file, resolvedModule=absolute)
        except (ValueError, TypeError, KeyError, ImportError):
            item['reason'] = 'unresolved-loaded-function'
        resolved.append(item)
    return resolved


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
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), guarded_runtime(error_type=TraceSafetyError):
            module = importlib.import_module(module_name)
        actual = getattr(module, '__file__', None)
        if not actual or os.path.normcase(os.path.realpath(actual)) != os.path.normcase(target):
            return {'ok': False, 'category': 'environment', 'stage': 'module-resolution',
                    'reason': f'Canonical import {module_name} does not resolve to the selected source file.'}
        return {'ok': True, 'module': module_name, 'importPaths': roots, 'policy_version': POLICY_VERSION,
                'importFixtures': import_fixture_evidence(),
                'dependencies': resolve_loaded_dependencies(module, payload.get('dependencies', []),
                                                            payload.get('sourceRoot') or package_root)}
    except (Exception, SystemExit) as error:
        diagnostic = import_diagnostic(error, payload.get('sourceRoot') or package_root)
        return {'ok': False, 'category': 'environment', 'stage': 'module-import',
                'importFixtures': import_fixture_evidence(),
                'reason': f'{safe_type_name(error)}: {exception_message(error)}', 'diagnostic': diagnostic, 'policy_version': POLICY_VERSION}


if __name__ == '__main__':
    print(json.dumps(preflight(json.loads(sys.stdin.read())), ensure_ascii=False))
