"""case_capture_runner patches row mocks where the target looks them up and records the real outcome.

Each case runs the runner in a subprocess: the runtime guard installs audit hooks
that must not leak into the rest of the Python test process.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'case_capture_runner.py')
MODULE = '''
import sqlite3


class NotFound(LookupError):
    pass


def _connect():
    return sqlite3.connect("real.db")


def lookup(key, default=None):
    conn = _connect()
    cur = conn.cursor()
    row = cur.fetchone()
    if row is None:
        if default is None:
            raise NotFound(key)
        return default
    return {"key": key, "value": row[0]}


def ratio(a, b):
    return round(a / b, 2)


def make_object():
    return object()


class Box:
    def __init__(self, size):
        self.size = size

    def grow(self, extra):
        return self.size + extra
'''
DEPENDENCIES = [
    {'name': '_connect', 'patch': '_connect', 'chain': []},
    {'name': 'cur.fetchone', 'patch': '_connect', 'chain': ['()', 'cursor', '()', 'fetchone']},
]


class CaptureRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp()
        with open(os.path.join(cls.directory, 'sample_store.py'), 'w', encoding='utf-8') as handle:
            handle.write(MODULE)

    def capture(self, target, row):
        request = {'version': 'case-capture-request-v1', 'file': os.path.join(self.directory, 'sample_store.py'),
                   'target': target, 'importPaths': [self.directory], 'dependencies': DEPENDENCIES,
                   'row': {'id': 'C1', 'mocks': [], **row}}
        run = subprocess.run([sys.executable, '-E', '-B', RUNNER], input=json.dumps(request), capture_output=True,
                             text=True, encoding='utf-8', cwd=self.directory, timeout=60)
        return json.loads(run.stdout)

    def test_return_value_is_recorded_as_a_literal(self):
        report = self.capture('ratio', {'args': '(1, 3)', 'kwargs': '{}'})
        self.assertEqual((report['status'], report['actual']), ('captured', {'kind': 'return', 'value': '0.33'}))

    def test_builtin_and_module_exceptions_have_references(self):
        report = self.capture('ratio', {'args': '(1, 0)'})
        self.assertEqual(report['exception']['reference'], {'kind': 'builtin', 'path': 'ZeroDivisionError'})
        report = self.capture('lookup', {'args': "('k',)", 'mocks': [{'dependency': 'cur.fetchone', 'behavior': 'return', 'value': 'None'}]})
        self.assertEqual(report['actual'], {'kind': 'raise', 'value': 'NotFound'})
        self.assertEqual(report['exception']['reference'], {'kind': 'module', 'path': 'NotFound'})
        self.assertIn('LookupError', report['exception']['mro'])

    def test_chain_and_direct_mocks_and_raised_dependency(self):
        report = self.capture('lookup', {'args': "('k',)", 'mocks': [{'dependency': 'cur.fetchone', 'behavior': 'return', 'value': "('v',)"}]})
        self.assertEqual(report['actual'], {'kind': 'return', 'value': "{'key': 'k', 'value': 'v'}"})
        report = self.capture('lookup', {'args': "('k',)", 'mocks': [{'dependency': '_connect', 'behavior': 'raise', 'value': 'sqlite3.OperationalError'}]})
        self.assertEqual(report['exception']['reference'], {'kind': 'module', 'path': 'sqlite3.OperationalError'})

    def test_unmocked_external_access_is_blocked_for_that_row_only(self):
        self.assertEqual(self.capture('lookup', {'args': "('k',)"}), {'version': 'case-capture-v1', 'id': 'C1',
                                                                     'status': 'capture-failed', 'reason': 'isolation-blocked'})

    def test_row_problems_become_capture_failures(self):
        cases = [
            ('make_object', {'args': '()'}, 'return-not-literal'),
            ('lookup', {'args': "('k',)", 'mocks': [{'dependency': 'db.other', 'behavior': 'return', 'value': '1'}]}, 'unknown-dependency'),
            ('lookup', {'args': "('k',)", 'mocks': [{'dependency': '_connect', 'behavior': 'return', 'value': '1'},
                                                     {'dependency': 'cur.fetchone', 'behavior': 'return', 'value': 'None'}]}, 'mock-conflict'),
            ('lookup', {'args': "('k',)", 'mocks': [{'dependency': '_connect', 'behavior': 'raise', 'value': 'NoSuchError'}]}, 'mock-exception-unknown'),
            ('Box.grow', {'args': '(1,)'}, 'instance-required'),
            ('ratio', {'setup': 'args = [1, 2]'}, 'setup-invalid'),
            ('ratio', {'setup': 'raise RuntimeError("x")'}, 'setup-failed'),
        ]
        for target, row, reason in cases:
            with self.subTest(reason=reason):
                report = self.capture(target, row)
                self.assertEqual((report['status'], report['reason']), ('capture-failed', reason))

    def test_setup_builds_instance_and_args_and_bare_values_are_wrapped(self):
        report = self.capture('Box.grow', {'setup': 'instance = target_module.Box(2)\nargs = (3,)\nkwargs = {}'})
        self.assertEqual(report['actual'], {'kind': 'return', 'value': '5'})
        self.assertEqual(self.capture('lookup', {'args': "'k'", 'kwargs': "{'default': 7}",
                                                 'mocks': [{'dependency': 'cur.fetchone', 'behavior': 'return', 'value': 'None'}]})['actual'],
                         {'kind': 'return', 'value': '7'})


if __name__ == '__main__':
    unittest.main()
