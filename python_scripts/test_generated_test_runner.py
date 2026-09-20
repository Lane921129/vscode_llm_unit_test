import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

TOOLS = Path(__file__).resolve().parent


class GeneratedRunnerTests(unittest.TestCase):
    def run_case(self, body, target='', coverage=False, setup=''):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'sample.py').write_text(target, encoding='utf-8')
            code = 'import unittest\n' + setup + '\nclass Cases(unittest.TestCase):\n    def test_case(self):\n' + textwrap.indent(body, '        ')
            (root / 'generated.py').write_text(code, encoding='utf-8')
            args = [sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'), 'generated', '-v',
                    '--violation-report', str(root / 'violations.jsonl')]
            if coverage:
                args += ['--coverage-source', folder]
            result = subprocess.run(args, cwd=folder, capture_output=True, text=True, encoding='utf-8',
                                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=20)
            result.events = [json.loads(line) for line in (root / 'violations.jsonl').read_text(encoding='utf-8').splitlines()]
            return result, [p.name for p in root.iterdir()]

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
