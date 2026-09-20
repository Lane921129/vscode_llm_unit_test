"""Run generated unittest code under a process-local external-operation guard.

The guard supplements AST validation; it is not an OS sandbox for hostile native
extensions. Coverage starts/saves outside the guarded application execution.
"""
import argparse
import asyncio
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import unittest
from uuid import uuid4
from unittest.mock import patch


ISOLATION_EXIT_CODE = 86
ISOLATION_MARKER = 'TEST_ISOLATION_BLOCKED'
_active = None


class TestIsolationError(RuntimeError):
    pass


def _block(operation):
    if _active is not None:
        _active.append(operation)
    raise TestIsolationError(f'{ISOLATION_MARKER}: {operation}; mock the dependency at its target use point.')


class _MemoryConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        def authorize(action, *_args):
            if action == sqlite3.SQLITE_ATTACH:
                if _active is not None:
                    _active.append('SQLite ATTACH / VACUUM INTO')
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        super().set_authorizer(authorize)

    def set_authorizer(self, *args, **kwargs):
        _block('replacing SQLite isolation authorizer')


def _import_or_traceback_read(filename):
    # Only the standard loader and traceback source reader may read files.
    # Application reads, including aliases of open(), remain prohibited.
    frame = sys._getframe(2)
    while frame and frame.f_code.co_filename == __file__:
        frame = frame.f_back
    if not frame:
        return False
    name = frame.f_globals.get('__name__', '')
    # CPython 3.13 may attempt to read the synthetic AST filename while
    # traceback calculates caret positions. This is runner diagnostics.
    if filename == '<unknown>' and name == 'ast' and frame.f_code.co_name == 'parse':
        caller = frame.f_back
        return bool(caller and caller.f_globals.get('__name__') == 'traceback'
                    and caller.f_code.co_name in ('_extract_caret_anchors_from_line_segment', '_should_show_carets'))
    if name in ('importlib._bootstrap_external', '_frozen_importlib_external'):
        return frame.f_code.co_name in ('get_data',)
    if name == 'tokenize' and frame.f_code.co_name == 'open':
        frame = frame.f_back
    return bool(frame and frame.f_globals.get('__name__') == 'linecache')


def _asyncio_socketpair():
    # Windows implements socketpair using a local listener. Permit only that
    # stdlib implementation, not arbitrary loopback requests from a test.
    frame = sys._getframe(2)
    while frame:
        if frame.f_globals.get('__name__') == 'socket' and frame.f_code.co_name == '_fallback_socketpair':
            return True
        frame = frame.f_back
    return False


def _audit(event, args):
    if _active is None:
        return
    if event == 'sqlite3.connect' and not (type(args[0]) is str and args[0] == ':memory:'):
        _block('non-isolated SQLite connection')
    if event == 'sqlite3.connect/handle' and not isinstance(args[0], _MemoryConnection):
        _block('unguarded SQLite connection factory')
    if event == 'sqlite3.load_extension':
        _block('SQLite extension loading')
    if event == 'open':
        mode, flags = args[1], args[2]
        writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (
            isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        if writing or not _import_or_traceback_read(args[0]):
            _block('file write' if writing else 'file read')
    if event in ('os.remove', 'os.rename', 'os.rmdir', 'os.mkdir', 'os.chmod', 'os.chown',
                 'os.link', 'os.symlink', 'os.truncate', 'os.utime', 'os.chdir'):
        _block(event)
    if event in ('subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn', 'os.fork', 'os.forkpty'):
        _block('shell / subprocess')
    if event in ('socket.connect', 'socket.bind', 'socket.getaddrinfo', 'socket.sendto'):
        if not _asyncio_socketpair():
            _block('network connection')


sys.addaudithook(_audit)


@contextmanager
def guarded_test_runtime():
    global _active
    if _active is not None:
        raise RuntimeError('Nested generated-test guards are unsupported')
    violations = []
    connect = sqlite3.connect

    def memory_connect(*args, **kwargs):
        if len(args) > 5 or 'factory' in kwargs:
            _block('custom SQLite connection factory')
        return connect(*args, **kwargs, factory=_MemoryConnection)

    try:
        _active = violations
        with patch.object(sqlite3, 'connect', memory_connect), patch.object(sqlite3.dbapi2, 'connect', memory_connect), \
                patch.object(sqlite3, 'Connection', _MemoryConnection), patch.object(sqlite3.dbapi2, 'Connection', _MemoryConnection):
            yield violations
    except BaseException:
        if violations:
            raise TestIsolationError(f'{ISOLATION_MARKER}: {violations[0]}') from None
        raise
    finally:
        _active = None
    # unittest or the target may catch the exception; it still cannot pass.
    if violations:
        raise TestIsolationError(f'{ISOLATION_MARKER}: {violations[0]}')


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('test_module')
    parser.add_argument('--coverage-source')
    parser.add_argument('--violation-report')
    parser.add_argument('-v', '--verbose', action='store_true')
    args = parser.parse_args(argv)
    run_id = uuid4().hex

    def record(event, **detail):
        if args.violation_report:
            with open(args.violation_report, 'a', encoding='utf-8') as report:
                report.write(json.dumps({'runId': run_id, 'event': event, **detail}) + '\n')

    # An engine that fails to invoke/finish its guarded runner cannot certify
    # isolation merely because no violation file appeared.
    record('started')
    sys.dont_write_bytecode = True
    # Script execution otherwise places the extension's tool folder first.
    sys.path.insert(0, os.getcwd())
    coverage = None
    if args.coverage_source:
        from coverage import Coverage
        coverage = Coverage(branch=True, source=[args.coverage_source], config_file=False)
        coverage.start()
    exit_code = 1
    violation = None
    try:
        with guarded_test_runtime() as violations:
            suite = unittest.defaultTestLoader.loadTestsFromName(args.test_module)
            result = unittest.TextTestRunner(verbosity=2 if args.verbose else 1).run(suite)
            exit_code = 0 if result.wasSuccessful() and result.testsRun > 0 else 1
    except TestIsolationError:
        violation = violations[0] if violations else 'external operation'
    except SystemExit:
        # A test calling sys.exit(0) is not a successful unittest result.
        exit_code = 1
    finally:
        if coverage:
            coverage.stop()
            coverage.save()
    if violation:
        print(f'{ISOLATION_MARKER}: {violation}; mock the dependency at its target use point.', file=sys.stderr)
        record('completed', status='isolation-blocked', operation=violation)
        return ISOLATION_EXIT_CODE
    record('completed', status='passed' if exit_code == 0 else 'failed')
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
