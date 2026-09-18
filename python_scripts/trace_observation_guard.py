"""Identify executed ambient reads without changing the value returned by them.

One successful call is not proof that a clock/random/process observation can be
replayed as a fixed assertion. This guard records actual callable identities,
not names in source, annotations or model suggestions. It is not a purity proof.
"""
import datetime
import importlib._bootstrap
import importlib._bootstrap_external
import os
import random
import sys
import threading
import time
import types
from contextlib import contextmanager

_DATETIME, _DATE = datetime.datetime, datetime.date
_RANDOM, _SYSTEM_RANDOM = random.Random, random.SystemRandom
_RNG_INIT, _RNG_SEED = _RANDOM.__init__.__code__, _RANDOM.seed.__code__
_IMPORT_GLOBALS = (vars(importlib._bootstrap), vars(importlib._bootstrap_external))

_C_READS = {
    id(getattr(module, name)): f'{module.__name__}.{name}'
    for module, names in (
        (time, ('time', 'time_ns', 'monotonic', 'monotonic_ns', 'perf_counter',
                'perf_counter_ns', 'process_time', 'process_time_ns', 'thread_time',
                'thread_time_ns', 'localtime', 'gmtime', 'ctime', 'asctime')),
        (os, ('urandom', 'getpid', 'getppid')),
    )
    for name in names if hasattr(module, name)
}


@contextmanager
def observe_ambient_reads(source_root, root_callables=(), importing=False):
    """Record clock/entropy reads in the target, its setup and called helpers.

    Runtime stdlib plumbing outside application frames (notably the asyncio
    loop's own clock) is excluded. Import-time reads in application modules are
    retained because they may initialize state used by later calls. Private RNGs
    born with explicit seeds during this invocation are controlled; shared RNGs
    and entropy-seeded instances are not. Explicit mocks never call the original
    primitive and therefore do not acquire ambient-read evidence.
    """
    source_root = os.path.normcase(os.path.realpath(source_root))
    root_codes = {getattr(getattr(fn, '__func__', fn), '__code__', None) for fn in root_callables}
    root_codes.discard(None)
    operations = set()
    application_codes = {}
    controlled_rngs = {}
    active = True

    def application_code(code):
        if code not in application_codes:
            filename = os.path.normcase(os.path.realpath(code.co_filename))
            try:
                local = os.path.commonpath([filename, source_root]) == source_root
            except ValueError:
                local = False
            parts = filename.replace('\\', '/').split('/')
            application_codes[code] = local and not any(
                part in ('.venv', 'site-packages', 'dist-packages') for part in parts)
        return application_codes[code]

    def belongs_to_target(frame):
        while frame:
            if frame.f_code in root_codes or application_code(frame.f_code):
                return True
            # Count calls made by an application initializer into a library
            # (e.g. TOKEN = uuid.uuid4()), not the library's own import setup.
            if importing and any(frame.f_globals is namespace for namespace in _IMPORT_GLOBALS):
                return False
            frame = frame.f_back
        return False

    def inspect_call(frame, event, called):
        if not active or event not in ('call', 'c_call'):
            return
        if event == 'call':
            if frame.f_code is _RNG_INIT and belongs_to_target(frame.f_back):
                instance = frame.f_locals.get('self')
                if frame.f_locals.get('x') is not None and not isinstance(instance, _SYSTEM_RANDOM):
                    controlled_rngs[id(instance)] = instance
            elif frame.f_code is _RNG_SEED:
                if frame.f_locals.get('a') is None:
                    controlled_rngs.pop(id(frame.f_locals.get('self')), None)
            return
        if not isinstance(called, types.BuiltinFunctionType):
            return
        operation = _C_READS.get(id(called))
        owner = called.__self__
        name = called.__name__
        if isinstance(owner, type) and name in ('now', 'utcnow', 'today'):
            if issubclass(owner, _DATETIME):
                operation = f'datetime.datetime.{name}'
            elif issubclass(owner, _DATE):
                operation = f'datetime.date.{name}'
        elif isinstance(owner, _RANDOM) and name in ('random', 'getrandbits'):
            if id(owner) not in controlled_rngs:
                operation = f'random.{name}'
        if operation and belongs_to_target(frame):
            operations.add(operation)

    previous = sys.getprofile()
    previous_thread = threading.getprofile()

    def profile(frame, event, arg):
        inspect_call(frame, event, arg)
        if previous:
            previous(frame, event, arg)

    def thread_profile(frame, event, arg):
        inspect_call(frame, event, arg)
        if previous_thread:
            previous_thread(frame, event, arg)

    sys.setprofile(profile)
    threading.setprofile(thread_profile)
    try:
        yield operations
    finally:
        active = False
        sys.setprofile(previous)
        threading.setprofile(previous_thread)
