"""Source-bound, empty test resources; source files and module origins never move.

The host owns the outer lease and removes it after the complete child tree exits.
One worker owns one child directory, shared by its import and execution guards.
This augments runtime_policy, not an OS sandbox for hostile native extensions.
Resource handles returned to generated tests are outside the supported contract:
native file objects are not proxied because that would change their type semantics.
"""
from contextlib import ExitStack, contextmanager
import atexit
import builtins
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
import threading
from unittest.mock import patch

LEASE_ENV = 'LLM_UNIT_TEST_RESOURCE_LEASE'
LEASE_MARKER = '.llm-unit-test-resource-lease.json'
_ORIGINAL_OPEN = builtins.open
_ORIGINAL_STAT = os.stat
_ORIGINAL_LSTAT = os.lstat
_ORIGINAL_CONNECT = sqlite3.connect
_SESSIONS = {}
_GENERATED_TEST_FILES = set()
_REDIRECT_CODES = set()
_IDENTIFIER = re.compile(r'[A-Za-z_]\w{0,63}', re.ASCII)
_FORBIDDEN_SUFFIXES = {'.py', '.pyc', '.pyo', '.so', '.pyd', '.dll', '.exe', '.sh', '.bat', '.cmd', '.ps1'}


def absolute(path):
    return os.path.normcase(os.path.abspath(os.path.normpath(os.fsdecode(path))))


def inside(path, root):
    try:
        return os.path.commonpath((absolute(path), absolute(root))) == absolute(root)
    except (ValueError, TypeError):
        return False


def set_generated_test_file(path):
    """Runner registers the actual generated module before importing any tests."""
    if path:
        _GENERATED_TEST_FILES.add(absolute(path))


def is_redirect_frame(frame):
    return frame.f_code in _REDIRECT_CODES


def _has_link(path):
    """Reject links/junctions, including existing ancestors of a new resource."""
    current = Path(absolute(path))
    for item in (current, *current.parents):
        try:
            info = _ORIGINAL_LSTAT(item)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 1024:
            return True
    return False


def _relative_path(value):
    if (type(value) is not str or not 1 <= len(value) <= 240 or '\\' in value or ':' in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or any(char in value for char in '<>"|?*')
            or value.startswith('/') or any(part in ('', '.', '..') or part.endswith(('.', ' '))
                or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.I)
                for part in value.split('/'))
            or Path(value).suffix.lower() in _FORBIDDEN_SUFFIXES):
        raise ValueError('Invalid isolated resource path')
    return value


def _unsafe_raw_components(value):
    # Windows abspath normalizes away trailing dots/spaces. Inspect the spelling
    # before normalization, so an invalid requested name cannot become valid.
    tail = os.path.splitdrive(os.fsdecode(value))[1]
    return any(part not in ('', '.', '..') and (part.endswith(('.', ' '))
        or any(char in part for char in ':<>"|?*')
        or any(ord(char) < 32 or ord(char) == 127 for char in part)
        or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.I))
        for part in tail.replace('\\', '/').split('/'))


def validate_resources(rule):
    """Validate Python-side too; the worker never trusts a host environment alone."""
    specs = rule.get('resources', [])
    if type(specs) is not list or len(specs) > 16:
        raise ValueError('Invalid isolated resource list')
    approved = rule.get('resourceSourceHash')
    if specs and (type(approved) is not str or not re.fullmatch('[a-f0-9]{64}', approved)
                  or approved != rule.get('sourceHash')):
        raise ValueError('Isolated resource source approval expired')
    if not specs and approved is not None:
        raise ValueError('Isolated resource approval has no resources')
    for spec in specs:
        if type(spec) is not dict or spec.get('kind') not in ('directory', 'text', 'sqlite'):
            raise ValueError('Invalid isolated resource kind')
        _relative_path(spec.get('path'))
        allowed = {'path', 'kind'} | ({'text'} if spec['kind'] == 'text' else {'tables'} if spec['kind'] == 'sqlite' else set())
        if set(spec) - allowed:
            raise ValueError('Invalid isolated resource fields')
        if spec['kind'] == 'text' and (type(spec.get('text')) is not str or len(spec['text'].encode('utf-8')) > 65536):
            raise ValueError('Invalid isolated resource text')
        if spec['kind'] != 'sqlite':
            continue
        tables = spec.get('tables', [])
        if type(tables) is not list or len(tables) > 16:
            raise ValueError('Invalid isolated SQLite tables')
        names = set()
        for table in tables:
            if (type(table) is not dict or set(table) - {'name', 'columns', 'rows'}
                    or type(table.get('name')) is not str or not _IDENTIFIER.fullmatch(table['name'])
                    or table['name'].lower().startswith('sqlite_') or table['name'].lower() in names):
                raise ValueError('Invalid isolated SQLite table')
            names.add(table['name'].lower())
            columns = table.get('columns')
            if type(columns) is not list or not 1 <= len(columns) <= 32:
                raise ValueError('Invalid isolated SQLite columns')
            column_names = set()
            primary_keys = 0
            for column in columns:
                if (type(column) is not dict or set(column) - {'name', 'type', 'primaryKey', 'notNull'}
                        or type(column.get('name')) is not str or not _IDENTIFIER.fullmatch(column['name'])
                        or column['name'].lower() in column_names
                        or column.get('type') not in ('INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC')
                        or any(key in column and type(column[key]) is not bool for key in ('primaryKey', 'notNull'))):
                    raise ValueError('Invalid isolated SQLite column')
                column_names.add(column['name'].lower())
                primary_keys += column.get('primaryKey', False)
            if primary_keys > 1:
                raise ValueError('Composite SQLite primary keys require an explicit supported schema')
            rows = table.get('rows', [])
            if type(rows) is not list or len(rows) > 256:
                raise ValueError('Invalid isolated SQLite rows')
            exact_names = {column['name'] for column in columns}
            for row in rows:
                if type(row) is not dict or set(row) - exact_names:
                    raise ValueError('Invalid isolated SQLite row columns')
                for value in row.values():
                    if (value is not None and (type(value) not in (str, int, float, bool)
                            or type(value) is str and len(value) > 4096
                            or type(value) is int and not -(2 ** 63) <= value < 2 ** 63
                            or type(value) is float and not math.isfinite(value))):
                        raise ValueError('Invalid isolated SQLite cell')
    return specs


def _spec_key(spec):
    return json.dumps(spec, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


class IsolatedResources:
    def __init__(self, plan):
        self.plan = plan
        self.pid = os.getpid()
        self.root = absolute(plan['root'])
        self.trial_root = absolute(plan['trialRoot']) if plan.get('trialRoot') else None
        self.worker = None
        self.active = False
        self.local = threading.local()
        self.operations = {}
        self.connections = []
        self.mounts = []
        self.specs = {}
        self.block = None
        sources = [absolute(rule.get('resolvedFile') or os.path.join(self.root, rule['file'])) for rule in plan['rules']]
        for rule in plan['rules']:
            specs = validate_resources(rule)
            for spec in specs:
                logical = absolute(os.path.join(self.root, spec['path']))
                if not inside(logical, self.root) or logical == self.root or _has_link(logical):
                    raise ValueError('Isolated resource path escapes source root or uses a link')
                if any(logical == source or spec['kind'] == 'directory' and inside(source, logical) for source in sources):
                    raise ValueError('Isolated resources cannot contain source files')
                previous = self.specs.get(logical)
                if previous is not None and _spec_key(previous) != _spec_key(spec):
                    raise ValueError('Conflicting isolated resource specifications')
                self.specs[logical] = spec
                aliases = [logical]
                if rule.get('resolvedFile'):
                    original = absolute(os.path.join(self.root, rule['file']))
                    derived = absolute(os.path.join(os.path.dirname(rule['resolvedFile']),
                        os.path.relpath(logical, os.path.dirname(original))))
                    if self.trial_root and inside(derived, self.trial_root):
                        aliases.append(derived)
                for alias in aliases:
                    if _has_link(alias):
                        raise ValueError('Isolated resource alias uses a link')
                    self.mounts.append((alias, logical, spec['kind']))
        for logical, spec in self.specs.items():
            if spec['kind'] != 'directory' and any(other != logical and inside(other, logical) for other in self.specs):
                raise ValueError('An isolated file resource cannot contain another resource')
        self.mounts = sorted(set(self.mounts), key=lambda item: len(item[0]), reverse=True)
        aliases = {}
        for alias, logical, _ in self.mounts:
            if alias in aliases and aliases[alias] != logical:
                raise ValueError('Ambiguous isolated resource mutation binding')
            aliases[alias] = logical
        lease = os.environ.get(LEASE_ENV, '')
        if not lease or not os.path.isabs(lease):
            raise ValueError('Isolated resource host lease is required')
        self.lease = absolute(lease)
        if (_has_link(self.lease) or inside(self.lease, self.root) or inside(self.root, self.lease)
                or self.trial_root and inside(self.lease, self.trial_root)):
            raise ValueError('Invalid isolated resource host lease location')
        marker_path = os.path.join(self.lease, LEASE_MARKER)
        if _has_link(marker_path):
            raise ValueError('Invalid isolated resource host lease marker link')
        with _ORIGINAL_OPEN(marker_path, 'rb') as stream:
            raw = stream.read(1025)
        marker = json.loads(raw) if len(raw) <= 1024 else None
        if (type(marker) is not dict or marker.get('schemaVersion') != 'isolated-resource-lease-v1'
                or type(marker.get('ownerPid')) is not int or marker['ownerPid'] <= 0):
            raise ValueError('Invalid isolated resource host lease marker')
        self.worker = tempfile.mkdtemp(prefix=f'worker-{self.pid}-', dir=self.lease)
        self.data = os.path.join(self.worker, 'data')
        try:
            os.mkdir(self.data)
            # A single logical tree makes directory mounts and nested explicit
            # seeds share one path, without copying any existing project data.
            for logical, spec in sorted(self.specs.items(), key=lambda item: len(item[0])):
                physical = self._physical(logical)
                if spec['kind'] == 'directory':
                    os.makedirs(physical, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(physical), exist_ok=True)
                    if spec['kind'] == 'text':
                        with _ORIGINAL_OPEN(physical, 'w', encoding='utf-8', newline='') as stream:
                            stream.write(spec['text'])
                    else:
                        self._seed_database(physical, spec)
        except BaseException:
            self.cleanup()
            raise
        atexit.register(self.cleanup)

    def _physical(self, logical):
        return absolute(os.path.join(self.data, os.path.relpath(logical, self.root)))

    @staticmethod
    def _seed_database(physical, spec):
        connection = _ORIGINAL_CONNECT(physical)
        try:
            with connection:
                for table in spec.get('tables', []):
                    columns = []
                    for column in table['columns']:
                        columns.append('"' + column['name'] + '" ' + column['type']
                            + (' PRIMARY KEY' if column.get('primaryKey') else '')
                            + (' NOT NULL' if column.get('notNull') else ''))
                    connection.execute('CREATE TABLE "' + table['name'] + '" (' + ','.join(columns) + ')')
                    for row in table.get('rows', []):
                        if row:
                            names = list(row)
                            connection.execute('INSERT INTO "' + table['name'] + '" ('
                                + ','.join('"' + name + '"' for name in names) + ') VALUES ('
                                + ','.join('?' for _ in names) + ')', [row[name] for name in names])
                        else:
                            connection.execute('INSERT INTO "' + table['name'] + '" DEFAULT VALUES')
        finally:
            connection.close()

    def cleanup(self):
        if os.getpid() != self.pid or not self.worker:
            return
        for connection in self.connections:
            try:
                connection.close()
            except sqlite3.Error:
                pass
        self.connections.clear()
        worker = self.worker
        if inside(worker, self.lease) and absolute(worker) != self.lease and not _has_link(worker):
            try:
                shutil.rmtree(worker)
            except OSError:
                # The host still owns final cleanup after process close, also
                # when SQLite or another library retains an open handle.
                return
            self.worker = None

    def evidence(self):
        return {'planId': self.plan['id'], 'scope': 'fresh-process', 'resourceCount': len(self.specs),
                'operations': self.operations}

    def covers(self, value):
        if not isinstance(value, (str, bytes, os.PathLike)):
            return False
        logical = self._logical(value)
        return any(logical == alias or kind == 'directory' and inside(logical, alias)
                   for alias, _, kind in self.mounts)

    def _logical(self, value):
        raw = os.fsdecode(value)
        return absolute(raw if os.path.isabs(raw) else os.path.join(self.root, raw))

    def _application_caller(self):
        frame = sys._getframe(1)
        while frame:
            filename = frame.f_code.co_filename
            if os.path.isabs(filename):
                canonical = absolute(filename)
                if canonical in _GENERATED_TEST_FILES:
                    return False
                if inside(canonical, self.root) or self.trial_root and inside(canonical, self.trial_root):
                    # Tool output and generated test files are registered by
                    # the runner; the nearest app frame determines ownership.
                    return True
            frame = frame.f_back
        return False

    def require_application_caller(self):
        if self.active and not self._application_caller():
            self.block('generated test direct resource I/O')

    def translate(self, value, operation):
        if not self.active or not isinstance(value, (str, bytes, os.PathLike)):
            return value, False
        if type(value) is str and value.startswith('file:'):
            self.block('SQLite URI is not an isolated resource path')
        logical = self._logical(value)
        for alias, origin, kind in self.mounts:
            if logical == alias or kind == 'directory' and inside(logical, alias):
                if _unsafe_raw_components(value):
                    self.block('isolated resource executable or unsupported filename')
                if not self._application_caller():
                    self.block('generated test direct resource I/O')
                mapped = self._physical(os.path.join(origin, os.path.relpath(logical, alias)))
                if not inside(mapped, self.data) or _has_link(mapped):
                    self.block('isolated resource path escape or symlink')
                try:
                    _relative_path(os.path.relpath(mapped, self.data).replace(os.sep, '/'))
                except ValueError:
                    self.block('isolated resource executable or unsupported filename')
                self.operations[operation] = min(self.operations.get(operation, 0) + 1, 1000000)
                return mapped, True
        return value, False

    @contextmanager
    def authorize(self, paths):
        previous = getattr(self.local, 'authorized', ())
        self.local.authorized = (*previous, *paths)
        try:
            yield
        finally:
            self.local.authorized = previous

    def allows_audit(self, event, args):
        if not self.active or not args or not isinstance(args[0], (str, bytes, os.PathLike)):
            return False
        paths = [args[0], args[1]] if event == 'os.rename' else [args[0]]
        permitted = getattr(self.local, 'authorized', ())
        return all(isinstance(item, (str, bytes, os.PathLike)) and absolute(item) in permitted
                   and inside(item, self.data) and not _has_link(item) for item in paths)

    def sqlite_connect(self, connect, args, kwargs):
        value = args[0] if args else kwargs.get('database')
        if value == ':memory:':
            return connect(*args, **kwargs)
        # URI forms, shared caches and custom factories are deliberately absent.
        if kwargs.get('uri') or len(args) > 7 and args[7]:
            self.block('SQLite URI is not an isolated resource path')
        mapped, matched = self.translate(value, 'sqlite3.connect')
        if not matched:
            self.block('non-isolated SQLite connection')
        args, kwargs = list(args), dict(kwargs)
        if args:
            args[0] = mapped
        else:
            kwargs['database'] = mapped
        with self.authorize((absolute(mapped),)):
            connection = connect(*args, **kwargs)
        self.connections.append(connection)
        return connection

    @contextmanager
    def guarding(self, block):
        self.block = block
        self.active = True
        def wrapper(function, operation, path_index=0):
            def redirected(*args, **kwargs):
                if not self.active:
                    return function(*args, **kwargs)
                args, kwargs = list(args), dict(kwargs)
                key = 'file' if operation in ('open', 'io.open') else 'path'
                value = args[path_index] if len(args) > path_index else kwargs.get(key)
                mapped, matched = self.translate(value, operation)
                if not matched:
                    return function(*args, **kwargs)
                if (kwargs.get('dir_fd') is not None or kwargs.get('opener') is not None
                        or operation in ('open', 'io.open') and len(args) > 7 and args[7] is not None
                        or kwargs.get('follow_symlinks') is False):
                    block('unsupported isolated resource descriptor or symlink operation')
                if len(args) > path_index:
                    args[path_index] = mapped
                else:
                    kwargs[key] = mapped
                with self.authorize((absolute(mapped),)):
                    return function(*args, **kwargs)
            _REDIRECT_CODES.add(redirected.__code__)
            return redirected
        try:
            with ExitStack() as stack:
                for module, name, operation in ((builtins, 'open', 'open'), (io, 'open', 'io.open'),
                        *((os, name, 'os.' + name) for name in ('open', 'mkdir', 'stat', 'lstat', 'listdir', 'scandir',
                                                               'remove', 'unlink', 'rmdir'))):
                    stack.enter_context(patch.object(module, name, wrapper(getattr(module, name), operation)))
                yield self
        finally:
            self.active = False
            self.block = None


def for_plan(plan):
    """Allocate once per PID/plan/lease, never once per guard or inherited fork."""
    if not plan or not any(rule.get('resources') for rule in plan['rules']):
        return None
    encoded = json.dumps(plan, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    key = (os.getpid(), hashlib.sha256(encoded.encode()).hexdigest(), os.environ.get(LEASE_ENV, ''))
    if key not in _SESSIONS:
        _SESSIONS[key] = IsolatedResources(plan)
    return _SESSIONS[key]
