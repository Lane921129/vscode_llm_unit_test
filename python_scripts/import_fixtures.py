"""Declarative import-only mocks shared by every guarded Python execution phase.

Original modules execute unchanged. A retained alias stops mocking when its
caller is no longer a declared module body, even while the guard is active.
"""
from contextlib import ExitStack
import ast
import builtins
import configparser
import hashlib
import importlib
import inspect
import json
import os
from pathlib import Path
import re
import sys
from unittest.mock import patch
from isolated_resources import validate_resources

ENVIRONMENT_KEY = 'LLM_UNIT_TEST_IMPORT_FIXTURES'
_last_evidence = None


def evidence():
    return _last_evidence


def _absolute(path):
    return os.path.normcase(os.path.realpath(path))


def _inside(path, root):
    try:
        return os.path.commonpath([_absolute(path), _absolute(root)]) == _absolute(root)
    except ValueError:
        return False


def read_plan(environment=None):
    raw = (os.environ if environment is None else environment).get(ENVIRONMENT_KEY, '')
    if not raw:
        return None
    if len(raw.encode('utf-8')) > 524288:
        raise ValueError('Import fixture plan exceeds size limit')
    plan = json.loads(raw)
    if (not isinstance(plan, dict) or plan.get('schemaVersion') != 'import-fixtures-v1'
            or not isinstance(plan.get('root'), str) or not os.path.isabs(plan['root'])
            or not re.fullmatch(r'[a-f0-9]{64}', str(plan.get('id', '')))
            or not isinstance(plan.get('rules'), list) or len(plan['rules']) > 256):
        raise ValueError('Invalid import fixture plan')
    return plan


class ImportFixtures:
    def __init__(self):
        global _last_evidence
        self.plan = read_plan()
        self.active = False
        self.rules = {}
        self.operations = []
        self.stack = ExitStack()
        self.installed_entries = set()
        self.installing_entries = False
        self.resources = None
        _last_evidence = None
        if not self.plan:
            return
        root = _absolute(self.plan['root'])
        # Rebasing is generated solely by the trusted mutation driver.
        for rule in self.plan['rules']:
            if not isinstance(rule, dict) or not isinstance(rule.get('file'), str):
                raise ValueError('Invalid import fixture source')
            filename = rule.get('resolvedFile') or os.path.join(root, rule['file'])
            filename = _absolute(filename)
            if not rule.get('resolvedFile') and not _inside(filename, root):
                raise ValueError('Import fixture source escapes project')
            if filename in self.rules or not filename.endswith('.py'):
                raise ValueError('Duplicate or invalid import fixture source')
            if hashlib.sha256(Path(filename).read_bytes()).hexdigest() != rule.get('sourceHash'):
                raise ValueError('Import fixture source changed; rebuild the test setup')
            configs = rule.get('configFiles', {})
            entries = rule.get('entryPoints', [])
            entry_lines = rule.get('entryPointLines', {})
            approved_source = rule.get('entryPointSourceHash')
            if (type(rule.get('mkdir', False)) is not bool or not isinstance(configs, dict) or len(configs) > 8
                    or any(not isinstance(name, str) or not re.fullmatch(r'[\w.-]+\.ini', name, re.I)
                           or not isinstance(value, str) or len(value) > 65536 for name, value in configs.items())
                    or not isinstance(entries, list) or len(entries) > 8
                    or any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+', name) for name in entries)
                    or not isinstance(entry_lines, dict) or len(entry_lines) > 8
                    or any(name not in entries or not isinstance(lines, list) or not 1 <= len(lines) <= 32
                           or any(type(line) is not int or line < 1 for line in lines) for name, lines in entry_lines.items())
                    or approved_source is not None and (not entry_lines or not isinstance(approved_source, str)
                                                        or not re.fullmatch(r'[a-f0-9]{64}', approved_source))):
                raise ValueError('Invalid import fixture operation')
            if approved_source is not None and not rule.get('resolvedFile') and approved_source != rule.get('sourceHash'):
                raise ValueError('Startup fixture source approval expired')
            validate_resources(rule)
            self.rules[filename] = rule
        _last_evidence = {'id': self.plan['id'], 'operations': self.operations}

    def match(self, frame):
        if not self.active or frame.f_code.co_name != '<module>':
            return None
        filename = _absolute(frame.f_code.co_filename)
        if _absolute(frame.f_globals.get('__file__', '')) != filename:
            return None
        return self.rules.get(filename)

    def record(self, rule, operation, frame):
        if len(self.operations) >= 1024:
            raise RuntimeError('Import fixture operation limit exceeded')
        self.operations.append({'file': rule['file'], 'operation': operation, 'line': frame.f_lineno})

    def install_entries(self):
        """Patch only dependencies actually imported; never add imports to the app."""
        if not self.active or self.installing_entries:
            return
        self.installing_entries = True
        try:
            for entry in sorted({name for rule in self.rules.values() for name in rule.get('entryPoints', [])}):
                module_name, attribute = entry.rsplit('.', 1)
                module = sys.modules.get(module_name)
                if module is None or getattr(getattr(module, '__spec__', None), '_initializing', False):
                    continue
                key = (id(module), attribute)
                if key in self.installed_entries:
                    continue
                origin = getattr(module, '__file__', None)
                if (not origin or _inside(origin, self.plan['root'])
                        or self.plan.get('trialRoot') and _inside(origin, self.plan['trialRoot'])):
                    raise ValueError('Startup fixture must target an external dependency')
                original = vars(module).get(attribute)
                if not callable(original) or isinstance(original, type):
                    raise ValueError('Startup fixture requires a concrete callable, not a class')
                code = getattr(original, '__code__', None)
                if code and (_inside(code.co_filename, self.plan['root'])
                             or self.plan.get('trialRoot') and _inside(code.co_filename, self.plan['trialRoot'])):
                    raise ValueError('Startup fixture cannot replace application code')

                def wrapper(function, name):
                    try:
                        signature = inspect.signature(function)
                    except (TypeError, ValueError):
                        signature = None
                    def entry_mock(*args, **kwargs):
                        frame = sys._getframe(1)
                        rule = self.match(frame)
                        allowed_lines = rule.get('entryPointLines', {}).get(name) if rule else None
                        if rule and name in rule.get('entryPoints', []) and (allowed_lines is None or frame.f_lineno in allowed_lines):
                            if signature:
                                signature.bind(*args, **kwargs)
                            self.record(rule, name, frame)
                            return None
                        return function(*args, **kwargs)
                    return entry_mock

                self.stack.enter_context(patch.object(module, attribute, wrapper(original, entry)))
                self.installed_entries.add(key)
        finally:
            self.installing_entries = False

    def __enter__(self):
        if not self.plan:
            return self
        self.active = True
        original_mkdir = Path.mkdir
        mkdir_signature = inspect.signature(original_mkdir)
        original_exists = Path.exists
        original_read = configparser.ConfigParser.read

        def mkdir(path, *args, **kwargs):
            frame = sys._getframe(1)
            rule = self.match(frame)
            if self.resources and self.resources.covers(path):
                return original_mkdir(path, *args, **kwargs)
            if rule and rule.get('mkdir'):
                mkdir_signature.bind(path, *args, **kwargs)
                self.record(rule, 'pathlib.Path.mkdir', frame)
                return None
            return original_mkdir(path, *args, **kwargs)

        def fixture_text(rule, frame, filename):
            if not rule or not isinstance(filename, (str, os.PathLike)):
                return None
            absolute = _absolute(filename)
            for name, text in rule.get('configFiles', {}).items():
                if absolute == _absolute(os.path.join(os.path.dirname(frame.f_code.co_filename), name)):
                    return text
            return None

        def exists(path, *args, **kwargs):
            frame = sys._getframe(1)
            rule = self.match(frame)
            if self.resources and self.resources.covers(path):
                return original_exists(path, *args, **kwargs)
            if fixture_text(rule, frame, path) is not None:
                self.record(rule, 'config-fixture.exists', frame)
                return True
            return original_exists(path, *args, **kwargs)

        def read(parser, filenames, encoding=None):
            frame = sys._getframe(1)
            rule = self.match(frame)
            if not rule:
                return original_read(parser, filenames, encoding=encoding)
            names = [filenames] if isinstance(filenames, (str, os.PathLike)) else list(filenames)
            if self.resources and any(self.resources.covers(name) for name in names):
                return original_read(parser, names, encoding=encoding)
            if rule and names and all(fixture_text(rule, frame, name) is not None for name in names):
                for name in names:
                    parser.read_string(fixture_text(rule, frame, name), source='<declared-test-fixture>')
                self.record(rule, 'configparser.ConfigParser.read', frame)
                return [os.fspath(name) for name in names]
            return original_read(parser, names, encoding=encoding)

        try:
            self.stack.enter_context(patch.object(Path, 'mkdir', mkdir))
            self.stack.enter_context(patch.object(Path, 'exists', exists))
            self.stack.enter_context(patch.object(configparser.ConfigParser, 'read', read))
            if any(rule.get('entryPoints') for rule in self.rules.values()):
                original_import = builtins.__import__
                original_import_module = importlib.import_module

                def importing(*args, **kwargs):
                    module = original_import(*args, **kwargs)
                    self.install_entries()
                    return module

                def importing_module(*args, **kwargs):
                    module = original_import_module(*args, **kwargs)
                    self.install_entries()
                    return module

                self.stack.enter_context(patch.object(builtins, '__import__', importing))
                self.stack.enter_context(patch.object(importlib, 'import_module', importing_module))
                self.install_entries()
            return self
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def __exit__(self, *exc):
        self.active = False
        self.stack.__exit__(*exc)


def _rebase_entry_lines(original, candidate, rule):
    """AST unparse moves lines; preserve the same unchanged top-level call identity."""
    if hashlib.sha256(original.read_bytes()).hexdigest() != rule['sourceHash']:
        raise ValueError('Startup fixture source changed before mutation')
    old = ast.parse(original.read_bytes()).body
    new = ast.parse(candidate.read_bytes()).body
    mapped = {}
    for operation, lines in rule['entryPointLines'].items():
        mapped[operation] = []
        for line in lines:
            owners = [node for node in old if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                      and node.lineno <= line <= node.end_lineno]
            if len(owners) != 1:
                raise ValueError('Startup fixture call has no unique source position')
            shape = ast.dump(owners[0], include_attributes=False)
            before = [node for node in old if ast.dump(node, include_attributes=False) == shape]
            after = [node for node in new if ast.dump(node, include_attributes=False) == shape]
            if len(before) != len(after):
                raise ValueError('Startup fixture call changed in mutation copy')
            mapped[operation].append(after[before.index(owners[0])].value.lineno)
    return mapped


def mutation_environment(environment, trial_root, source_file, copy_bindings):
    """Bind setup only to copies in the actual test import layout.

    A binding is (original, destination, is_package). It comes from the trusted
    mutation driver, never from the fixture plan or target. Do not infer extra
    bindings by scanning all ancestors for coincidentally matching filenames.
    """
    plan = read_plan(environment)
    if not plan:
        return environment
    plan = dict(plan, trialRoot=str(Path(trial_root).resolve()), rules=[dict(rule) for rule in plan['rules']])
    source_file, trial_root = Path(source_file).resolve(), Path(trial_root).resolve()
    extra = []
    seen = {}
    for rule in plan['rules']:
        original = Path(plan['root'], rule['file']).resolve()
        for copied_source, destination, is_package in copy_bindings:
            copied_source, destination = Path(copied_source).resolve(), Path(destination).resolve()
            if is_package:
                if not original.is_relative_to(copied_source):
                    continue
                candidate = (destination / original.relative_to(copied_source)).resolve()
            elif original == copied_source:
                candidate = destination
            else:
                continue
            if not candidate.is_relative_to(trial_root):
                raise ValueError('Mutation fixture copy escapes trial')
            if not candidate.is_file():
                continue
            key = _absolute(candidate)
            if key in seen:
                if seen[key] != _absolute(original):
                    raise ValueError('Ambiguous mutation fixture source binding')
                continue
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            if original != source_file and digest != rule['sourceHash']:
                raise ValueError('Mutation fixture dependency changed during copy')
            seen[key] = _absolute(original)
            copy = dict(rule, resolvedFile=str(candidate), sourceHash=digest)
            if rule.get('resources'):
                if rule.get('resourceSourceHash') != rule.get('sourceHash'):
                    raise ValueError('Isolated resource source approval expired before mutation')
                copy['resourceSourceHash'] = digest
            if rule.get('entryPointLines') and digest != rule['sourceHash']:
                copy['entryPointLines'] = _rebase_entry_lines(original, candidate, rule)
            extra.append(copy)
    plan['rules'].extend(extra)
    return {**environment, ENVIRONMENT_KEY: json.dumps(plan, ensure_ascii=True)}
