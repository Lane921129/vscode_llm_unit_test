"""Load the canonical target in a fresh, side-effect-guarded process before LLM work."""
import importlib
import ast
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


RESOURCE_SCOPE_VERSION = 'loaded-resource-scope-v1'
RESOURCE_SCOPE_MAX_SOURCES = 256
RESOURCE_SCOPE_MAX_FILE_BYTES = 512 * 1024
RESOURCE_SCOPE_MAX_TOTAL_BYTES = 4 * 1024 * 1024
RESOURCE_SCOPE_MAX_AST_NODES = 100000
_DYNAMIC_IMPORT_MODULES = {'importlib', 'builtins', 'runpy', 'imp', 'pkgutil', 'zipimport'}
_DYNAMIC_IMPORT_NAMES = {
    '__import__', 'import_module', 'exec', 'eval', 'compile', 'execfile',
    'load_module', 'exec_module', 'find_spec', 'spec_from_file_location',
    'spec_from_loader', 'module_from_spec', 'SourceFileLoader', 'SourcelessFileLoader',
    'ExtensionFileLoader', 'run_module', 'run_path', '__loader__', '__spec__', '__builtins__',
}
_REFLECTIVE_LOADER_NAMES = {'getattr', 'setattr', 'delattr', 'globals', 'locals', 'vars', '__getattribute__', '__subclasses__'}
_SYS_LOADER_ATTRIBUTES = {'modules', 'meta_path', 'path', 'path_hooks', 'path_importer_cache'}


def resource_scope_evidence(versions):
    """Conservative known-syntax evidence, not a proof of arbitrary runtime closure.

    Every loaded project source must still match its snapshot and contain only
    direct module imports. Unknown/lazy/reflective loading keeps all resources.
    Read source only; never resolve or execute a new import for this evidence.
    """
    result = {'version': RESOURCE_SCOPE_VERSION, 'eligible': False, 'sourceSetHash': ''}

    def unknown(reason):
        return {**result, 'reason': reason}

    if not isinstance(versions, list) or not versions:
        return unknown('invalid-source-snapshot')
    try:
        identities = [[item['file'], item['hash']] for item in versions]
        if any(type(file) is not str or not os.path.isabs(file) or type(digest) is not str
               or len(digest) != 64 or any(char not in '0123456789abcdef' for char in digest)
               for file, digest in identities):
            return unknown('invalid-source-snapshot')
        if len({os.path.normcase(os.path.realpath(file)) for file, _ in identities}) != len(identities):
            return unknown('invalid-source-snapshot')
        result['sourceSetHash'] = hashlib.sha256(json.dumps(
            identities, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
    except (KeyError, TypeError, ValueError, UnicodeError):
        return unknown('invalid-source-snapshot')
    if len(versions) > RESOURCE_SCOPE_MAX_SOURCES:
        return unknown('source-budget')
    total_bytes = 0
    for file, digest in identities:
        try:
            with open(file, 'rb') as stream:
                source = stream.read(RESOURCE_SCOPE_MAX_FILE_BYTES + 1)
        except (OSError, ValueError):
            return unknown('source-unavailable')
        total_bytes += len(source)
        if len(source) > RESOURCE_SCOPE_MAX_FILE_BYTES or total_bytes > RESOURCE_SCOPE_MAX_TOTAL_BYTES:
            return unknown('source-budget')
        if hashlib.sha256(source).hexdigest() != digest:
            return unknown('source-changed')
        try:
            tree = ast.parse(source, filename=file)
        except (SyntaxError, ValueError, TypeError, MemoryError, RecursionError):
            return unknown('source-parse')
        nodes = []
        for count, node in enumerate(ast.walk(tree), 1):
            if count > RESOURCE_SCOPE_MAX_AST_NODES:
                return unknown('source-budget')
            nodes.append(node)
        direct_imports = {id(node) for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))}
        # Do not infer a receiver/factory/callback's runtime import behavior.
        # Only unambiguous direct calls to an undecorated function defined here
        # have a callee whose complete body is part of this same AST check.
        direct_functions = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                            and not node.decorator_list}
        definitions = {}
        rebound = set()
        for node in nodes:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                definitions[node.name] = definitions.get(node.name, 0) + 1
            if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                rebound.add(node.id)
            if isinstance(node, ast.arg):
                rebound.add(node.arg)
            if isinstance(node, ast.ExceptHandler) and node.name:
                rebound.add(node.name)
            if isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
                rebound.add(node.name)
            if isinstance(node, ast.MatchMapping) and node.rest:
                rebound.add(node.rest)
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                rebound.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
        direct_functions -= rebound | {name for name, count in definitions.items() if count > 1}
        sys_aliases = {'sys'}
        for node in tree.body:
            if isinstance(node, ast.Import):
                sys_aliases.update(alias.asname or 'sys' for alias in node.names if alias.name == 'sys')
        for node in nodes:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                if id(node) not in direct_imports:
                    return unknown('nested-import')
                modules = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or '']
                if any(name.split('.')[0] in _DYNAMIC_IMPORT_MODULES for name in modules):
                    return unknown('dynamic-import')
                if isinstance(node, ast.ImportFrom) and any(alias.name == '*' or alias.name in _DYNAMIC_IMPORT_NAMES
                        or (node.module == 'sys' and alias.name in _SYS_LOADER_ATTRIBUTES) for alias in node.names):
                    return unknown('dynamic-import')
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in _DYNAMIC_IMPORT_NAMES:
                return unknown('dynamic-import')
            if isinstance(node, ast.Attribute) and (node.attr in _DYNAMIC_IMPORT_NAMES | _REFLECTIVE_LOADER_NAMES
                    or (isinstance(node.value, ast.Name) and node.value.id in sys_aliases and node.attr in _SYS_LOADER_ATTRIBUTES)):
                return unknown('dynamic-import')
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in _REFLECTIVE_LOADER_NAMES:
                return unknown('dynamic-import')
        if any((isinstance(node, ast.Call) and not (isinstance(node.func, ast.Name) and node.func.id in direct_functions))
               or (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.decorator_list)
               or (isinstance(node, ast.ClassDef) and (node.bases or node.keywords)) for node in nodes):
            return unknown('unknown-dispatch')
    return {**result, 'eligible': True}


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
        source_versions = loaded_source_versions(payload.get('sourceRoot') or package_root)
        return {'ok': True, 'module': module_name, 'importPaths': roots, 'policy_version': POLICY_VERSION,
                'sourceVersionsVersion': 'loaded-project-sources-v1',
                'sourceVersions': source_versions, 'resourceScope': resource_scope_evidence(source_versions),
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
