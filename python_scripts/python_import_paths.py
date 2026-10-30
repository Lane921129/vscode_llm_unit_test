"""Transport application search roots as data, never as Python startup paths."""
import json
import os
from pathlib import Path

IMPORT_PATHS_ENV = 'LLM_UNIT_TEST_IMPORT_PATHS'


def configured_import_paths(environment=None):
    environment = os.environ if environment is None else environment
    raw = environment.get(IMPORT_PATHS_ENV, '[]')
    if len(raw) > 128 * 1024:
        raise ValueError('Import path transport exceeds its limit')
    paths = json.loads(raw)
    if (type(paths) is not list or len(paths) > 256
            or any(type(item) is not str or not item or '\x00' in item for item in paths)):
        raise ValueError('Invalid import path transport')
    return list(dict.fromkeys(paths))


def tool_environment(environment=None, paths=None):
    result = dict(os.environ if environment is None else environment)
    transported = configured_import_paths(result)
    supplied = transported if paths is None else [*paths, *transported]
    inherited = result.pop('PYTHONPATH', '').split(os.pathsep)
    result.pop('PYTHONHOME', None)
    result.pop('PYTHONINSPECT', None)
    result[IMPORT_PATHS_ENV] = json.dumps(list(dict.fromkeys([*supplied, *filter(None, inherited)])))
    result['PYTHONIOENCODING'] = 'utf-8'
    return result


def package_context(file_path):
    target = Path(file_path).resolve()
    parts = []
    current = target.parent
    while (current / '__init__.py').is_file():
        parts.insert(0, current.name)
        current = current.parent
    module = parts if parts and target.stem == '__init__' else [*parts, target.stem]
    return '.'.join(module), str(current), parts[0] if parts else None


def source_import_paths(file_path, module_name=None, paths=()):
    """Exclude package interiors while retaining canonical and explicit roots.

    A namespace module's exact name can also establish its root. No application
    module is imported, and this helper grants no file or execution permission.
    """
    target = Path(file_path).resolve()
    inferred, package_root, _ = package_context(target)
    parts = (module_name or inferred).split('.')
    relative = Path(*parts) / '__init__.py' if target.name == '__init__.py' else Path(*parts).with_suffix('.py')
    root = target
    for _ in relative.parts:
        root = root.parent
    if os.path.normcase(str(root / relative)) != os.path.normcase(str(target)):
        root = Path(package_root)
    result = []
    for raw in [str(root), *paths]:
        candidate = Path(os.path.abspath(raw))
        # A package directory is not a top-level import root. In particular,
        # its email.py/types.py must not replace the standard library modules.
        if candidate != root and (candidate / '__init__.py').is_file():
            continue
        if candidate != root and candidate.is_relative_to(root) and target.is_relative_to(candidate):
            continue
        text = str(candidate)
        if text not in result:
            result.append(text)
    return result
