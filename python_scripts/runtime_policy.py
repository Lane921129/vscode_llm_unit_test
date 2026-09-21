"""One fail-closed external-operation policy for all Python execution phases.

Only import/traceback source reads, stdlib asyncio socketpair plumbing and
guarded independent in-memory SQLite are permitted. This process-local audit
guard is not an OS sandbox for hostile native extensions.
"""
from contextlib import contextmanager, ExitStack
import ast
import importlib._bootstrap_external
import linecache
import os
import sqlite3
import sys
import threading
import tokenize
import traceback
import types
from unittest.mock import patch
from trace_value_codec import type_field

POLICY_VERSION = 'python-execution-policy-v1'
ISOLATION_EXIT_CODE = 86
ISOLATION_MARKER = 'TEST_ISOLATION_BLOCKED'
_active = None
_THREAD_BOOTSTRAP_CODE = threading.Thread._bootstrap_inner.__code__
_THREAD_START_CODE = threading.Thread.start.__code__
_CURRENT_FRAMES = sys._current_frames
_THREAD_EXCEPT_ARGS = threading.ExceptHookArgs
_WAIT_EVENT = threading.Event
_LOADER_GET_DATA_CODE = importlib._bootstrap_external.FileLoader.get_data.__code__
_TOKENIZE_OPEN_CODE = tokenize.open.__code__
_LINECACHE_CODES = {value.__code__ for value in vars(linecache).values() if type(value) is types.FunctionType}
_TRACEBACK_CODES = {value.__code__ for value in vars(traceback).values() if type(value) is types.FunctionType}
for _owner in (traceback.FrameSummary, traceback.StackSummary, traceback.TracebackException):
    for _value in vars(_owner).values():
        if type(_value) is property:
            _value = _value.fget
        elif type(_value) in (classmethod, staticmethod):
            _value = _value.__func__
        if type(_value) is types.FunctionType:
            _TRACEBACK_CODES.add(_value.__code__)
_AST_PARSE_CODE = ast.parse.__code__


class RuntimePolicyError(RuntimeError):
    prefix = f'{ISOLATION_MARKER}: '
    suffix = '; mock the dependency at its target use point.'

    def __init__(self, operation):
        self.operation = operation
        super().__init__(self.prefix + operation + self.suffix)


class BackgroundExecutionError(RuntimeError):
    """Uncaught background exceptions invalidate a successful foreground call."""
    def __init__(self, failures):
        self.failures = tuple(failures[:10])
        super().__init__('Background execution failed: ' + ', '.join(self.failures))


def block_operation(operation, error_type=RuntimePolicyError):
    """Record before raising so application code cannot swallow a violation."""
    if _active is not None:
        _active['violations'].append(operation)
        error_type = _active['error_type']
    error = error_type(operation)
    if _active is not None and _active['first_error'] is None:
        _active['first_error'] = error
    raise error


class _MemoryConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        def authorize(action, *_args):
            if action == sqlite3.SQLITE_ATTACH:
                if _active is not None:
                    _active['violations'].append('SQLite ATTACH / VACUUM INTO')
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        super().set_authorizer(authorize)

    def set_authorizer(self, *args, **kwargs):
        block_operation('replacing SQLite isolation authorizer')


def _import_or_traceback_read(filename):
    # The direct operation owner must be the loader or traceback reader. An
    # application frame deeper under an import does not obtain read permission.
    frame = sys._getframe(2)
    while frame and frame.f_code.co_filename == __file__:
        frame = frame.f_back
    if not frame:
        return False
    if filename == '<unknown>' and frame.f_code is _AST_PARSE_CODE:
        caller = frame.f_back
        return bool(caller and caller.f_code in _TRACEBACK_CODES)
    if frame.f_code is _LOADER_GET_DATA_CODE:
        return True
    if frame.f_code is _TOKENIZE_OPEN_CODE:
        frame = frame.f_back
    # linecache is a general-purpose reader; calling getline() from an
    # application must not turn arbitrary file contents into allowed input.
    while frame and frame.f_code in _LINECACHE_CODES:
        frame = frame.f_back
    return bool(frame and frame.f_code in _TRACEBACK_CODES)


def _asyncio_socketpair():
    # Windows socketpair needs a loopback listener. This narrow stdlib frame
    # exception never permits arbitrary application loopback connections.
    frame = sys._getframe(2)
    while frame:
        if frame.f_globals.get('__name__') == 'socket' and frame.f_code.co_name == '_fallback_socketpair':
            return True
        frame = frame.f_back
    return False


def _audit(event, args):
    if _active is None:
        return
    if event in ('_thread.start_new_thread', '_thread.start_joinable_thread'):
        # Thread.start waits for its bootstrap handshake. A raw low-level start
        # can return before a child frame exists and evade the drain boundary.
        if sys._getframe(1).f_code is not _THREAD_START_CODE:
            block_operation('unmanaged low-level thread startup')
    if event == 'sys.setprofile' and _active['protect_profile']:
        frame = sys._getframe(1)
        if not (frame.f_code is _THREAD_BOOTSTRAP_CODE
                and frame.f_globals.get('_profile_hook') is _active['thread_profile']):
            block_operation('replacing execution observer')
    if event == 'sqlite3.connect' and not (type(args[0]) is str and args[0] == ':memory:'):
        block_operation('non-isolated SQLite connection')
    if event == 'sqlite3.connect/handle' and not isinstance(args[0], _MemoryConnection):
        block_operation('unguarded SQLite connection factory')
    if event == 'sqlite3.load_extension':
        block_operation('SQLite extension loading')
    if event == 'open':
        mode, flags = args[1], args[2]
        writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (
            isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        if writing or not _import_or_traceback_read(args[0]):
            block_operation('file write' if writing else 'file read')
    if event in ('os.remove', 'os.rename', 'os.rmdir', 'os.mkdir', 'os.chmod', 'os.chown',
                 'os.link', 'os.symlink', 'os.truncate', 'os.utime', 'os.chdir'):
        block_operation(event)
    if event in ('subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn', 'os.fork', 'os.forkpty'):
        block_operation('shell / subprocess')
    if event in ('socket.connect', 'socket.bind', 'socket.getaddrinfo', 'socket.sendto') and not _asyncio_socketpair():
        block_operation('network connection')


sys.addaudithook(_audit)


def _drain_background_threads(initial_threads):
    """Keep policy/observers active until all newly-created Python threads exit.

    The owning worker/runner deadline bounds this wait and kills its process
    tree. Managed daemon/child threads are included; raw startup is rejected.
    """
    waiter = _WAIT_EVENT()
    interrupted = None
    while set(_CURRENT_FRAMES()) - initial_threads:
        try:
            waiter.wait(0.005)
        except BaseException as error:
            # An interrupt must not clear the guard while child code still runs.
            interrupted = error
    if interrupted is not None:
        raise interrupted


@contextmanager
def guarded_runtime(*, error_type=RuntimePolicyError, protect_profile=False):
    global _active
    if _active is not None:
        raise RuntimeError('Nested execution policy guards are unsupported')
    violations = []
    background_failures = []
    initial_threads = set(_CURRENT_FRAMES())
    connect = sqlite3.connect
    state = {'violations': violations, 'error_type': error_type, 'first_error': None,
             'protect_profile': protect_profile, 'thread_profile': threading.getprofile()}

    def memory_connect(*args, **kwargs):
        if len(args) > 5 or 'factory' in kwargs:
            block_operation('custom SQLite connection factory')
        return connect(*args, **kwargs, factory=_MemoryConnection)

    def observe_background_exception(args):
        name = type_field(args.exc_type, '__name__')[:120] if type(args) is _THREAD_EXCEPT_ARGS else 'unknown-background-error'
        background_failures.append(name)

    def block_profile_replacement(*_args, **_kwargs):
        block_operation('replacing execution observer')

    try:
        _active = state
        with ExitStack() as stack:
            for module in (sqlite3, sqlite3.dbapi2):
                stack.enter_context(patch.object(module, 'connect', memory_connect))
                stack.enter_context(patch.object(module, 'Connection', _MemoryConnection))
            stack.enter_context(patch.object(threading, 'excepthook', observe_background_exception))
            if protect_profile:
                for name in ('setprofile', 'setprofile_all_threads'):
                    if hasattr(threading, name):
                        stack.enter_context(patch.object(threading, name, block_profile_replacement))
            try:
                yield violations
            finally:
                if threading.excepthook is not observe_background_exception:
                    background_failures.append('background-exception-observer-replaced')
                _drain_background_threads(initial_threads)
                if threading.excepthook is not observe_background_exception:
                    background_failures.append('background-exception-observer-replaced')
    except BaseException as error:
        if violations:
            if isinstance(error, error_type):
                raise
            raise state['first_error'] or error_type(violations[0]) from None
        if background_failures:
            raise BackgroundExecutionError(background_failures) from None
        raise
    finally:
        _active = None
    if violations:
        raise state['first_error'] or error_type(violations[0])
    if background_failures:
        raise BackgroundExecutionError(background_failures)
