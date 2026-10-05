"""Load the canonical target in a fresh, side-effect-guarded process before LLM work."""
import importlib
import hashlib
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
from import_setup_advisor import advise_blocked_initialization


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
                'sourceVersionsVersion': 'loaded-project-sources-v1',
                'sourceVersions': loaded_source_versions(payload.get('sourceRoot') or package_root),
                'importFixtures': import_fixture_evidence(),
                'dependencies': resolve_loaded_dependencies(module, payload.get('dependencies', []),
                                                            payload.get('sourceRoot') or package_root)}
    except (Exception, SystemExit) as error:
        diagnostic = import_diagnostic(error, payload.get('sourceRoot') or package_root)
        if isinstance(error, TraceSafetyError):
            candidate = advise_blocked_initialization(error, payload.get('sourceRoot') or package_root)
            if candidate:
                diagnostic['initialization_candidate'] = candidate
        # Read built-in exception slots and module dictionaries, not arbitrary getters.
        if (isinstance(error, AttributeError)
                and 'name' in AttributeError.__dict__ and 'obj' in AttributeError.__dict__):
            name = AttributeError.__dict__['name'].__get__(error)
            owner = AttributeError.__dict__['obj'].__get__(error)
            if type(owner) is types.ModuleType and type(name) is str and name.isidentifier():
                namespace = vars(owner)
                module = namespace.get('__name__')
                if type(module) is str and all(part.isidentifier() for part in module.split('.')):
                    diagnostic['dependency_api'] = {'module': module, 'attribute': name}
        return {'ok': False, 'category': 'environment', 'stage': 'module-import',
                'importFixtures': import_fixture_evidence(),
                'reason': f'{safe_type_name(error)}: {exception_message(error)}', 'diagnostic': diagnostic, 'policy_version': POLICY_VERSION}


def loaded_source_versions(source_root):
    """Snapshot loaded project sources without importing or evaluating attributes.

    The prompt's callable inventory is intentionally narrower: constants, module
    aliases, reexports and transitive imports still affect execution provenance.
    Function-local imports not executed by preflight are outside this snapshot.
    """
    root = os.path.normcase(os.path.realpath(source_root))
    versions = {}
    for module in tuple(sys.modules.values()):
        if type(module) is not types.ModuleType:
            continue
        origin = vars(module).get('__file__')
        if type(origin) is not str:
            continue
        file = os.path.realpath(origin)
        try:
            if os.path.commonpath([root, os.path.normcase(file)]) != root:
                continue
        except ValueError:
            continue
        if not file.endswith('.py'):
            # Native dependencies are interpreter/environment provenance, not
            # Python source. Do not guess a source path from their module names.
            continue
        with open(file, 'rb') as stream:
            source = stream.read()
        versions[os.path.normcase(file)] = {'file': file, 'hash': hashlib.sha256(source).hexdigest()}
    return [versions[key] for key in sorted(versions)]


if __name__ == '__main__':
    print(json.dumps(preflight(json.loads(sys.stdin.read())), ensure_ascii=False))
