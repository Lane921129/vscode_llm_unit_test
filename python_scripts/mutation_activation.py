"""Trusted function-body activation after the unchanged module has initialized.

Only plain top-level functions are eligible. This does not execute generated
setup or weaken the runtime guard; the module loader still runs under it.
"""
import ast
import copy
import hashlib
import importlib.machinery
import json
import os
from pathlib import Path
import sys
import types
from unittest.mock import patch

BACKEND = 'isolated-unittest-function-v2'
POLICY = 'after-module-initialization-v1'
SCHEMA = 'mutation-function-activation-v1'


def digest(value):
    return hashlib.sha256(value).hexdigest()


def eligible(tree, target):
    matches = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == target]
    return bool(len(matches) == 1 and not matches[0].decorator_list and not getattr(matches[0], 'type_params', []))


def _selected(tree, target):
    if not eligible(tree, target):
        raise ValueError('Function mutation activation target is unsupported')
    return next(node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == target)


def _outside_body(tree, target):
    tree = copy.deepcopy(tree)
    _selected(tree, target).body = [ast.Pass()]
    return ast.dump(tree, include_attributes=False)


def _function_code(code, name):
    found = [item for item in code.co_consts if type(item) is types.CodeType and item.co_name == name]
    if len(found) != 1 or found[0].co_freevars:
        raise ValueError('Function mutation activation code is ambiguous')
    return found[0]


def write_manifest(trial_root, source_bytes, target, targets, test_file):
    """Called by the mutation driver, never by a generated candidate."""
    root = Path(trial_root).resolve()
    originals = root / 'activation-original.source'
    manifest = root / 'activation.json'
    originals.write_bytes(source_bytes)
    files = []
    for file in targets:
        path = Path(file).resolve()
        relative = str(path.relative_to(root))
        if eligible(ast.parse(path.read_bytes()), target):
            files.append(relative)
    if not files:
        raise ValueError('Function mutation activation target is unsupported')
    data = {'schemaVersion': SCHEMA, 'policy': POLICY, 'target': target,
            'sourceHash': digest(source_bytes), 'original': originals.name,
            'test': str(Path(test_file).resolve().relative_to(root)),
            'testHash': digest(Path(test_file).read_bytes()),
            'targets': [{'file': file, 'variantHash': digest((root / file).read_bytes())} for file in files]}
    manifest.write_bytes(json.dumps(data).encode('utf-8'))
    return manifest


def validate_evidence(value, expected):
    fields = {'schemaVersion', 'policy', 'sourceHash', 'variantHash', 'testHash', 'target', 'status', 'activatedModules'}
    return (isinstance(value, dict) and set(value) == fields and value['schemaVersion'] == SCHEMA
            and value['policy'] == POLICY and value['status'] == 'activated'
            and type(value['activatedModules']) is int and 1 <= value['activatedModules'] <= 64
            and all(value[key] == expected[key] for key in ('sourceHash', 'variantHash', 'testHash', 'target')))


class FunctionMutationActivation:
    def __init__(self, manifest):
        if not isinstance(manifest, (str, os.PathLike)) or str(manifest).startswith(('\\\\', '//', '\\??\\')):
            raise ValueError('Function mutation activation manifest is not local')
        path = Path(manifest).absolute()
        if path.name != 'activation.json' or path.parent.resolve() != Path.cwd().resolve():
            raise ValueError('Function mutation activation manifest escapes trial')
        for part in (path, *path.parents):
            if part.is_symlink() or getattr(part, 'is_junction', lambda: False)():
                raise ValueError('Function mutation activation manifest is linked')
        path = path.resolve()
        self.root = path.parent
        if path.stat().st_size > 65536:
            raise ValueError('Function mutation activation manifest exceeds limit')
        data = json.loads(path.read_bytes())
        if (not isinstance(data, dict) or set(data) != {'schemaVersion', 'policy', 'target', 'sourceHash', 'original', 'test', 'testHash', 'targets'}
                or data['schemaVersion'] != SCHEMA or data['policy'] != POLICY
                or not isinstance(data['target'], str) or not data['target'].isidentifier()
                or not isinstance(data['targets'], list) or not 1 <= len(data['targets']) <= 8):
            raise ValueError('Invalid function mutation activation manifest')
        self.data = data
        original = self._read(data['original'])
        self.test_file = self._file(data['test'])
        if digest(original) != data['sourceHash'] or digest(self.test_file.read_bytes()) != data['testHash']:
            raise ValueError('Function mutation activation source or test changed')
        baseline_tree = ast.parse(original)
        baseline_function = _selected(baseline_tree, data['target'])
        self.copies, self.modules = {}, []
        for entry in data['targets']:
            if not isinstance(entry, dict) or set(entry) != {'file', 'variantHash'}:
                raise ValueError('Invalid function mutation activation target')
            file = self._file(entry['file'])
            value = self._read(entry['file'])
            if digest(value) != entry['variantHash']:
                raise ValueError('Function mutation activation variant changed')
            variant_tree = ast.parse(value)
            if sum(1 for _ in ast.walk(variant_tree)) > 100000:
                raise ValueError('Function mutation activation AST exceeds limit')
            if _outside_body(baseline_tree, data['target']) != _outside_body(variant_tree, data['target']):
                raise ValueError('Function mutation activation changed outside selected body')
            initialization_tree = copy.deepcopy(variant_tree)
            selected = _selected(initialization_tree, data['target'])
            body = copy.deepcopy(baseline_function.body)
            for statement in body:
                ast.increment_lineno(statement, selected.lineno - baseline_function.lineno)
            selected.body = body
            selected.end_lineno = max(selected.end_lineno, *(getattr(n, 'end_lineno', selected.lineno) or selected.lineno for n in ast.walk(selected)))
            ast.fix_missing_locations(initialization_tree)
            initialization = compile(initialization_tree, str(file), 'exec', dont_inherit=True)
            variant = _function_code(compile(variant_tree, str(file), 'exec', dont_inherit=True), data['target'])
            initial = _function_code(initialization, data['target'])
            key = os.path.normcase(str(file))
            if key in self.copies:
                raise ValueError('Duplicate function mutation activation target')
            self.copies[key] = (file, entry['variantHash'], initialization, initial, variant)

    def _file(self, value):
        if (not isinstance(value, str) or not value or Path(value).is_absolute() or Path(value).drive
                or any(part in ('.', '..') for part in Path(value).parts)):
            raise ValueError('Function mutation activation path escapes trial')
        file = self.root / value
        for part in (file, *file.parents):
            if part == self.root.parent:
                break
            if part.is_symlink() or getattr(part, 'is_junction', lambda: False)():
                raise ValueError('Function mutation activation path is linked')
        file = file.resolve()
        if not file.is_relative_to(self.root) or not file.is_file():
            raise ValueError('Function mutation activation file is missing')
        return file

    def _read(self, value):
        file = self._file(value)
        if file.stat().st_size > 2097152:
            raise ValueError('Function mutation activation source exceeds limit')
        return file.read_bytes()

    def __enter__(self):
        owner = self
        loader_type = importlib.machinery.SourceFileLoader
        original_code, original_execute = loader_type.get_code, loader_type.exec_module

        def copy_for(loader):
            return owner.copies.get(os.path.normcase(os.path.realpath(loader.path))) if type(loader) is loader_type else None

        def get_code(loader, fullname):
            item = copy_for(loader)
            if item is None:
                return original_code(loader, fullname)
            # Use the real loader read under the original audit policy.
            if digest(loader.get_data(loader.path)) != item[1]:
                raise ValueError('Function mutation activation copy changed before import')
            return item[2]

        def execute(loader, module):
            item = copy_for(loader)
            original_execute(loader, module)
            if item is None:
                return
            if type(module) is not types.ModuleType:
                raise ValueError('Function mutation activation module changed')
            function = vars(module).get(owner.data['target'])
            if (type(function) is not types.FunctionType or function.__globals__ is not vars(module)
                    or function.__code__ is not item[3] or function.__closure__
                    or len(owner.modules) >= 64):
                raise ValueError('Function mutation activation binding changed')
            function.__code__ = item[4]
            owner.modules.append((module, function, item))

        self.code_patch, self.execute_patch = patch.object(loader_type, 'get_code', get_code), patch.object(loader_type, 'exec_module', execute)
        self.code_patch.__enter__()
        self.execute_patch.__enter__()
        self.hooks, self.intact = (loader_type, get_code, execute), True
        return self

    def __exit__(self, *error):
        loader_type, get_code, execute = self.hooks
        self.intact = loader_type.get_code is get_code and loader_type.exec_module is execute
        self.execute_patch.__exit__(*error)
        self.code_patch.__exit__(*error)

    def evidence(self):
        valid = bool(self.modules) and self.intact
        hashes = set()
        for module, function, item in self.modules:
            valid = valid and sys.modules.get(vars(module).get('__name__')) is module
            valid = valid and vars(module).get(self.data['target']) is function and function.__code__ is item[4]
            valid = valid and digest(item[0].read_bytes()) == item[1]
            hashes.add(item[1])
        valid = valid and len(hashes) == 1 and digest(self.test_file.read_bytes()) == self.data['testHash']
        return {'schemaVersion': SCHEMA, 'policy': POLICY, 'sourceHash': self.data['sourceHash'],
                'variantHash': next(iter(hashes)) if len(hashes) == 1 else '0' * 64,
                'testHash': self.data['testHash'], 'target': self.data['target'],
                'status': 'activated' if valid else 'invalidated' if self.modules else 'not-activated',
                'activatedModules': len(self.modules)}
