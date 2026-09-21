import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest

TOOLS = Path(__file__).resolve().parent


class GeneratedRunnerTests(unittest.TestCase):
    def run_case(self, body, target='', coverage=False, setup='', target_name=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'sample.py').write_text(target, encoding='utf-8')
            code = 'import unittest\n' + setup + '\nclass Cases(unittest.TestCase):\n    def test_case(self):\n' + textwrap.indent(body, '        ')
            (root / 'generated.py').write_text(code, encoding='utf-8')
            args = [sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'), 'generated', '-v',
                    '--violation-report', str(root / 'violations.jsonl')]
            if coverage:
                args += ['--coverage-source', folder]
            if target_name:
                args += ['--target-file', str(root / 'sample.py'), '--target-name', target_name,
                         '--target-evidence', str(root / 'target_evidence.json'), '--target-run-id', 'neutral-run',
                         '--target-test-file', str(root / 'generated.py')]
            result = subprocess.run(args, cwd=folder, capture_output=True, text=True, encoding='utf-8',
                                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=20)
            result.events = [json.loads(line) for line in (root / 'violations.jsonl').read_text(encoding='utf-8').splitlines()]
            if target_name:
                result.target_evidence = json.loads((root / 'target_evidence.json').read_text(encoding='utf-8'))
                if coverage:
                    evidence = subprocess.run([
                        sys.executable, '-B', str(TOOLS / 'coverage_read.py'), str(root / 'sample.py'), target_name,
                        str(root / '.coverage'), '--invocation-evidence', str(root / 'target_evidence.json'),
                        '--expected-run-id', 'neutral-run', '--expected-test-hash', result.target_evidence['testHash'],
                    ], cwd=folder, capture_output=True, text=True, encoding='utf-8', timeout=20)
                    self.assertEqual(evidence.returncode, 0, evidence.stderr)
                    result.coverage_evidence = json.loads(evidence.stdout)
            return result, [p.name for p in root.iterdir()]

    def test_target_invocation_distinguishes_call_from_import_and_same_named_nested_callable(self):
        source = 'def target(): return 2\ndef outer():\n    def target(): return 3\n    return target()\n'
        for body, observed in [
            ('from sample import target\nself.assertEqual(target(), 2)\n', True),
            ('from sample import target\nself.assertTrue(True)\n', False),
            ('from sample import outer\nself.assertEqual(outer(), 3)\n', False),
        ]:
            with self.subTest(observed=observed, body=body):
                result, _ = self.run_case(body, source, coverage=True, target_name='target')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIs(result.target_evidence['observed'], observed)
                self.assertEqual(result.target_evidence['status'], 'passed')
                self.assertEqual(len(result.target_evidence['coverageDataHash']), 64)

    def test_target_invocation_keeps_qualified_class_identity(self):
        source = 'class First:\n    def target(self): return 2\nclass Second:\n    def target(self): return 3\n'
        result, _ = self.run_case('from sample import Second\nself.assertEqual(Second().target(), 3)\n',
                                  source, target_name='First.target')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(result.target_evidence['observed'])

    def test_target_invocation_observes_joined_worker_and_verifies_coverage_evidence(self):
        source = 'def target(): return 2\ndef outer():\n    def target(): return 3\n    return target()\n'
        for called, expected, observed in [('target', 2, True), ('outer', 3, False)]:
            with self.subTest(called=called):
                body = (f'from sample import {called}\nimport threading\nresults = []\n'
                        f'worker = threading.Thread(target=lambda: results.append({called}()))\n'
                        f'worker.start()\nworker.join()\nself.assertEqual(results, [{expected}])\n')
                result, _ = self.run_case(body, source, coverage=True, target_name='target')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIs(result.target_evidence['observed'], observed)
                self.assertTrue(result.target_evidence['profileIntact'])
                self.assertEqual(result.target_evidence['status'], 'passed')
                self.assertTrue(result.coverage_evidence['available'], result.coverage_evidence)
                self.assertEqual(result.coverage_evidence['scopeStatus'], 'verified')
                self.assertIs(result.coverage_evidence['invocation']['observed'], observed)
                if observed:
                    self.assertTrue(set(result.coverage_evidence['targetStatements']) <=
                                    set(result.coverage_evidence['executedStatements']))

    def test_target_cannot_disable_profile_and_swallow_the_violation(self):
        result, _ = self.run_case('import sys\ntry:\n    sys.setprofile(None)\nexcept Exception:\n    pass\nself.assertTrue(True)\n',
                                  'def target(): return 2\n', target_name='target')
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertNotEqual(result.target_evidence['status'], 'passed')

    def test_target_cannot_disable_thread_profile_and_swallow_the_violation(self):
        bodies = [
            'import threading\ntry:\n    threading.setprofile(None)\nexcept Exception:\n    pass\nself.assertTrue(True)\n',
            ('import threading\nimport sys\ndef worker():\n    try:\n        sys.setprofile(None)\n'
             '    except Exception:\n        pass\nthread = threading.Thread(target=worker)\n'
             'thread.start()\nthread.join()\nself.assertTrue(True)\n'),
        ]
        if hasattr(threading, 'setprofile_all_threads'):
            bodies.append('import threading\ntry:\n    threading.setprofile_all_threads(None)\n'
                          'except Exception:\n    pass\nself.assertTrue(True)\n')
        for body in bodies:
            with self.subTest(body=body):
                result, _ = self.run_case(body, 'def target(): return 2\n', target_name='target')
                self.assertEqual(result.returncode, 86, result.stderr)
                self.assertNotEqual(result.target_evidence['status'], 'passed')

    def test_background_assertion_failure_cannot_pass_generated_test(self):
        for joined in (True, False):
            with self.subTest(joined=joined):
                body = ('from sample import target\nimport threading\nimport time\n'
                        'def worker():\n    time.sleep(0.05)\n    self.assertEqual(target(), 3)\n'
                        f'thread = threading.Thread(target=worker, daemon={not joined})\nthread.start()\n')
                if joined:
                    body += 'thread.join()\n'
                result, _ = self.run_case(body, 'def target(): return 2\n', coverage=True, target_name='target')
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(result.events[-1]['status'], 'failed')
                self.assertEqual(result.target_evidence['status'], 'failed')
                self.assertTrue(result.target_evidence['observed'])
                self.assertFalse(result.coverage_evidence['available'])
                self.assertEqual(result.coverage_evidence['reason'], 'invalid-invocation-evidence')

    def test_invocation_observer_restores_the_existing_profile(self):
        sys.path.insert(0, str(TOOLS))
        try:
            from target_invocation import TargetInvocationTracker
            with tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / 'source.py'
                source.write_text('def target(): return 2\n', encoding='utf-8')
                tracker = TargetInvocationTracker(source, 'target', source, 'profile-restore')
                original = sys.getprofile()
                original_thread = threading.getprofile()
                calls = []
                thread_calls = []
                previous = lambda frame, _event, _arg: calls.append(frame.f_code.co_name)
                previous_thread = lambda frame, _event, _arg: thread_calls.append(frame.f_code.co_name)
                sys.setprofile(previous)
                threading.setprofile(previous_thread)
                try:
                    with tracker.observe():
                        self.assertIsNot(sys.getprofile(), previous)
                        self.assertIsNot(threading.getprofile(), previous_thread)

                        def worker():
                            return 2

                        thread = threading.Thread(target=worker)
                        thread.start()
                        thread.join()
                    self.assertIs(sys.getprofile(), previous)
                    self.assertIs(threading.getprofile(), previous_thread)
                    self.assertTrue(tracker.profile_intact)
                    self.assertTrue(calls)
                    self.assertIn('worker', thread_calls)
                    self.assertNotIn('worker', calls)
                finally:
                    sys.setprofile(original)
                    threading.setprofile(original_thread)
        finally:
            sys.path.pop(0)

    def test_invocation_observer_invalidates_replaced_thread_hook_and_restores_after_error(self):
        sys.path.insert(0, str(TOOLS))
        try:
            from target_invocation import TargetInvocationTracker
            with tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / 'source.py'
                source.write_text('def target(): return 2\n', encoding='utf-8')
                tracker = TargetInvocationTracker(source, 'target', source, 'profile-tamper')
                original, original_thread = sys.getprofile(), threading.getprofile()
                with self.assertRaisesRegex(ValueError, 'test observer cleanup'):
                    with tracker.observe():
                        threading.setprofile(None)
                        raise ValueError('test observer cleanup')
                self.assertFalse(tracker.profile_intact)
                self.assertIs(sys.getprofile(), original)
                self.assertIs(threading.getprofile(), original_thread)
        finally:
            sys.path.pop(0)

    def test_real_target_and_coverage_can_execute(self):
        result, files = self.run_case('from sample import add\nself.assertEqual(add(2, 3), 5)\n',
                                      'def add(a, b): return a + b\n', coverage=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('.coverage', files)
        self.assertEqual(result.events[-1]['status'], 'passed')

    def test_exception_traceback_is_a_test_failure_not_an_external_file_read(self):
        result, files = self.run_case('from sample import target\ntarget()\n',
                                      'def target(): raise ValueError("observed failure")\n')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('ValueError: observed failure', result.stderr)
        self.assertEqual(result.events[-1]['status'], 'failed')
        result, files = self.run_case('with self.assertRaises(ValueError):\n    pass\n')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.events[-1]['status'], 'failed')

    def test_indirect_database_connection_cannot_create_a_file_even_when_caught(self):
        target = "import sqlite3\ndef helper(): return sqlite3.connect('application.db')\ndef target():\n    try: helper()\n    except Exception: return None\n"
        result, files = self.run_case('from sample import target\nself.assertIsNone(target())\n', target)
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertIn('TEST_ISOLATION_BLOCKED', result.stderr)
        self.assertNotIn('application.db', files)
        self.assertIn('violations.jsonl', files)

    def test_dependency_mock_and_in_memory_sqlite_remain_usable(self):
        target = "import sqlite3\ndef target(): return sqlite3.connect('application.db').execute('select 2').fetchone()[0]\n"
        body = "from unittest.mock import patch\nfrom sample import target\nwith patch('sample.sqlite3.connect') as connect:\n    connect.return_value.execute.return_value.fetchone.return_value = (2,)\n    self.assertEqual(target(), 2)\nimport sqlite3\nwith sqlite3.connect(':memory:') as conn:\n    self.assertEqual(conn.execute('select 3').fetchone(), (3,))\n"
        result, files = self.run_case(body, target, coverage=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('application.db', files)

    def test_file_network_shell_and_sqlite_escape_attempts_are_sticky(self):
        operations = [
            "open('blocked.txt', 'w')", "open('sample.py')", "__import__('os').open('blocked.txt', 65)",
            "__import__('pathlib').Path('blocked').mkdir()", "__import__('os').system('echo blocked')",
            "__import__('socket').socket().connect(('127.0.0.1', 9))",
            "__import__('sqlite3').connect('file:shared?mode=memory&cache=shared', uri=True)",
            "__import__('sqlite3').connect(':memory:').execute(\"ATTACH 'blocked.db' AS other\")",
            "__import__('sqlite3').connect(':memory:').execute(\"VACUUM INTO 'blocked.db'\")",
        ]
        for operation in operations:
            with self.subTest(operation=operation):
                result, files = self.run_case(f'try:\n    {operation}\nexcept Exception:\n    pass\nself.assertTrue(True)\n')
                self.assertEqual(result.returncode, 86, result.stderr)
                self.assertNotIn('blocked.txt', files)
                self.assertNotIn('blocked.db', files)

    def test_async_unittest_and_mock_open_work(self):
        body = "from unittest.mock import patch, mock_open\nwith patch('builtins.open', mock_open(read_data='data')):\n    self.assertEqual(open('virtual').read(), 'data')\nimport asyncio\nself.assertEqual(asyncio.run(asyncio.sleep(0, result=2)), 2)\n"
        result, _ = self.run_case(body)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_sys_exit_cannot_hide_a_swallowed_isolation_failure(self):
        result, files = self.run_case("try:\n    open('blocked.txt', 'w')\nexcept Exception:\n    raise SystemExit(0)\n")
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertNotIn('blocked.txt', files)

    def test_guarded_mutation_does_not_score_external_operation_as_killed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            # Original skips the write. Negating its condition reaches a real
            # external operation: this must be an ERROR, not a killed mutant.
            (root / 'sample.py').write_text("def target(value):\n    if value:\n        open('application.txt', 'w')\n    return 2\n", encoding='utf-8')
            (root / 'generated.py').write_text('import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n    def test_case(self):\n        self.assertEqual(target(False), 2)\n', encoding='utf-8')
            result = subprocess.run([sys.executable, str(TOOLS / 'basic_mutation_runner.py'), str(root / 'sample.py'),
                                     str(root / 'generated.py'), '10', '3', 'target'], cwd=folder, capture_output=True,
                                    text=True, encoding='utf-8', timeout=25)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertTrue(report['baseline_passed'])
            self.assertGreater(report['errors'], 0)
            self.assertTrue(all(m['status'] == 'ERROR' for m in report['mutants'] if 'TEST_ISOLATION_BLOCKED' in m['output']))
            self.assertFalse((root / 'application.txt').exists())


if __name__ == '__main__':
    unittest.main()
