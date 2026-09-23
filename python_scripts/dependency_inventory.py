"""Bounded AST import inventory. Never import application or dependency modules."""
import ast
import importlib.machinery
import json
import os
from pathlib import Path
import sys
import tokenize


EXCLUDED = {'.git', '.hg', '.svn', '.venv', 'venv', 'env', 'node_modules',
            '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.nox',
            'site-packages', 'dist', 'build', '.eggs'}
MAX_FILES = 5000
MAX_BYTES = 32 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_REFERENCES = 10000


def generated_directory(directory):
    """Recognize our artifacts by their manifest, not arbitrary user folder names."""
    manifest = directory / 'run_manifest.json'
    try:
        if manifest.is_file() and manifest.stat().st_size < 65536:
            value = json.loads(manifest.read_text(encoding='utf-8-sig'))
            return (isinstance(value, dict) and value.get('schemaVersion') == 2 and 'runId' in value
                    and 'sourceHash' in value and str(value.get('promptVersion', '')).startswith('role-contracts-'))
    except (OSError, ValueError):
        pass
    return False


class ImportVisitor(ast.NodeVisitor):
    def __init__(self):
        self.imports = []
        self.context = 'required'
        self.dynamic_calls = 0

    def visit_Import(self, node):
        self.imports.extend((alias.name, node.lineno, self.context) for alias in node.names)

    def visit_ImportFrom(self, node):
        self.imports.append(('.' * node.level + (node.module or ''), node.lineno, self.context))

    def visit_Call(self, node):
        # Aliased/computed dynamic imports cannot be exhaustively discovered statically.
        if ((isinstance(node.func, ast.Name) and node.func.id == '__import__') or
                (isinstance(node.func, ast.Attribute) and node.func.attr == 'import_module')):
            self.dynamic_calls += 1
        self.generic_visit(node)

    def visit_If(self, node):
        previous = self.context
        typing = ((isinstance(node.test, ast.Name) and node.test.id == 'TYPE_CHECKING') or
                  (isinstance(node.test, ast.Attribute) and node.test.attr == 'TYPE_CHECKING'))
        self.visit(node.test)
        self.context = 'typing' if typing else ('conditional' if previous == 'required' else previous)
        for child in node.body:
            self.visit(child)
        self.context = previous if typing else self.context
        for child in node.orelse:
            self.visit(child)
        self.context = previous

    def visit_Try(self, node):
        previous = self.context
        catches_import = any(handler.type and any(isinstance(part, ast.Name) and
                             part.id in ('ImportError', 'ModuleNotFoundError')
                             for part in ast.walk(handler.type)) for handler in node.handlers)
        if catches_import and previous == 'required':
            self.context = 'optional'
        for child in node.body:
            self.visit(child)
        self.context = 'conditional' if previous == 'required' else previous
        for handler in node.handlers:
            self.visit(handler)
        self.context = previous
        for child in [*node.orelse, *node.finalbody]:
            self.visit(child)


def inventory(scan_root, project_root=None, excluded_paths=()):
    root = Path(scan_root).resolve()
    project = Path(project_root or root).resolve()
    if not root.is_relative_to(project):
        project = root
    excluded_paths = [Path(value).resolve() for value in excluded_paths if value]
    result = {'schemaVersion': 'dependency-inventory-v1', 'filesScanned': 0,
              'excludedDirectories': 0, 'complete': True, 'dynamicImports': 0,
              'imports': [], 'issues': [], 'missing': [], 'optionalMissing': []}
    records = {}
    total_bytes = 0
    references = 0
    files_seen = 0

    def issue(file, reason):
        result['complete'] = False
        if len(result['issues']) < 100:
            result['issues'].append({'file': file, 'reason': reason})

    if not root.is_dir() or (root / 'pyvenv.cfg').is_file():
        issue('.', 'invalid-source-directory')
        return result
    def walk_error(error):
        # Do not expose arbitrary OS errors or source text.
        issue('.', 'directory-unreadable')

    for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        folder = Path(directory)
        if generated_directory(folder) or (folder / 'pyvenv.cfg').is_file():
            dirs[:] = []
            result['excludedDirectories'] += 1
            continue
        kept = []
        for name in sorted(dirs):
            child = folder / name
            if (name.lower() in EXCLUDED or child.is_symlink() or
                    (hasattr(child, 'is_junction') and child.is_junction()) or
                    not child.resolve().is_relative_to(root) or
                    any(child.resolve() == excluded for excluded in excluded_paths)):
                result['excludedDirectories'] += 1
            else:
                kept.append(name)
        dirs[:] = kept
        for name in sorted(files):
            if not name.endswith('.py'):
                continue
            source = folder / name
            files_seen += 1
            relative = source.relative_to(root).as_posix()
            if source.is_symlink() or not source.resolve().is_relative_to(root):
                issue(relative, 'linked-source-skipped')
                continue
            if files_seen > MAX_FILES or total_bytes >= MAX_BYTES or references >= MAX_REFERENCES:
                issue(relative, 'scan-limit')
                return finish(result, records)
            try:
                size = source.stat().st_size
                total_bytes += size
                if size > MAX_FILE_BYTES or total_bytes > MAX_BYTES:
                    issue(relative, 'source-size-limit')
                    continue
                with tokenize.open(source) as stream:
                    tree = ast.parse(stream.read(), filename=relative)
            except (SyntaxError, UnicodeError, LookupError):
                issue(relative, 'source-parse-error')
                continue
            except (OSError, ValueError, RecursionError):
                issue(relative, 'source-unreadable')
                continue
            result['filesScanned'] += 1
            visitor = ImportVisitor()
            try:
                visitor.visit(tree)
            except RecursionError:
                issue(relative, 'source-depth-limit')
                continue
            result['dynamicImports'] += visitor.dynamic_calls
            roots = [source.parent, project, project / 'src']
            plain_ancestors = []
            ancestor = source.parent
            while ancestor != project and ancestor.is_relative_to(project):
                plain_ancestors.append(ancestor)
                if (ancestor / '__init__.py').is_file():
                    roots.append(ancestor.parent)
                ancestor = ancestor.parent
            for module, line, context in visitor.imports:
                references += 1
                if references > MAX_REFERENCES:
                    issue(relative, 'scan-limit')
                    return finish(result, records)
                top = module.split('.')[0]
                local = module.startswith('.') or any((base / (top + '.py')).is_file() or
                                                       (base / top).is_dir() for base in roots)
                kind = 'local' if local else 'stdlib' if top in getattr(sys, 'stdlib_module_names', sys.builtin_module_names) else 'external'
                if kind == 'external' and any((base / (top + '.py')).is_file() or (base / top).is_dir()
                                             for base in plain_ancestors):
                    kind = 'unresolved-local'
                key = (module, kind)
                record = records.setdefault(key, {'module': module, 'kind': kind, 'references': []})
                record['references'].append({'file': relative, 'line': line, 'context': context})
    if not result['filesScanned']:
        issue('.', 'no-python-files')
    return finish(result, records)


def finish(result, records):
    availability = {}
    for key in sorted(records):
        record = records[key]
        top = record['module'].split('.')[0]
        if record['kind'] == 'external':
            if top not in availability:
                try:
                    # Top-level spec lookup never executes a package __init__ or a submodule.
                    availability[top] = 'available' if importlib.machinery.PathFinder.find_spec(top) else 'missing'
                except (ImportError, AttributeError, ValueError, OSError):
                    availability[top] = 'unknown'
            record['availability'] = availability[top]
            if record['availability'] == 'missing':
                required = any(ref['context'] == 'required' for ref in record['references'])
                result['missing' if required else 'optionalMissing'].append(top)
            if record['availability'] == 'unknown':
                result['complete'] = False
                result['issues'].append({'file': record['references'][0]['file'], 'reason': 'package-lookup-failed'})
        else:
            record['availability'] = 'not-checked'
            if record['kind'] == 'unresolved-local':
                result['complete'] = False
                result['issues'].append({'file': record['references'][0]['file'], 'reason': 'local-import-root-unresolved'})
        result['imports'].append(record)
    result['missing'] = sorted(set(result['missing']))
    result['optionalMissing'] = sorted(set(result['optionalMissing']) - set(result['missing']))
    return result
