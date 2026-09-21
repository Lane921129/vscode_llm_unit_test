"""Neutral integration checks for the shared policy in all four execution phases."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

TOOLS = Path(__file__).resolve().parent


class RuntimePolicyIntegrationTests(unittest.TestCase):
    def invoke(self, tool, args=(), payload=None, cwd=None, timeout=25):
        result = subprocess.run([sys.executable, '-B', str(TOOLS / tool), *map(str, args)],
                                input=None if payload is None else json.dumps(payload),
                                capture_output=True, text=True, encoding='utf-8',
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, cwd=cwd, timeout=timeout)
        return result

    def test_import_and_trace_block_swallowed_real_reads_and_loopback(self):
        operations = [
            "open(__file__).read()",
            "__import__('pathlib').Path(__file__).read_text()",
            "__import__('linecache').getline(__file__, 1)",
            "__import__('socket').socket().connect(('127.0.0.1', 9))",
        ]
        with tempfile.TemporaryDirectory(prefix='shared-policy-') as directory:
            file = Path(directory) / 'neutral.py'
            for operation in operations:
                with self.subTest(operation=operation):
                    swallowed = f'try:\n    {operation}\nexcept Exception:\n    pass\n'
                    file.write_text(swallowed + 'def target(): return 7\n', encoding='utf-8')
                    run = self.invoke('module_preflight.py', payload={'file': str(file), 'module': 'neutral', 'importPaths': [directory]})
                    self.assertEqual(run.returncode, 0, run.stderr)
                    preflight = json.loads(run.stdout)
                    self.assertFalse(preflight['ok'])
                    self.assertEqual(preflight['diagnostic']['origin']['file'], 'neutral.py')
                    file.write_text('def target():\n' + textwrap.indent(swallowed + 'return 7\n', '    '), encoding='utf-8')
                    run = self.invoke('dynamic_tracer.py', [file, 'target', '[[]]'])
                    facts = json.loads(run.stdout)
                    self.assertEqual(facts['cases'][0]['status'], 'blocked', facts)
                    self.assertEqual(facts['examples'], [])
                    self.assertEqual(facts['errors'], [])

    def test_worker_thread_swallowing_a_read_cannot_create_an_oracle(self):
        source = ('import threading\n'
                  'def target():\n'
                  '    def child():\n'
                  '        try: open(__file__)\n'
                  '        except Exception: pass\n'
                  '    thread = threading.Thread(target=child)\n'
                  '    thread.start()\n'
                  '    thread.join()\n'
                  '    return 7\n')
        with tempfile.TemporaryDirectory(prefix='shared-policy-thread-') as directory:
            file = Path(directory) / 'neutral.py'
            file.write_text(source, encoding='utf-8')
            facts = json.loads(self.invoke('dynamic_tracer.py', [file, 'target', '[[]]']).stdout)
        self.assertEqual(facts['cases'][0]['status'], 'blocked')
        self.assertEqual(facts['examples'], [])

    def test_late_background_writes_stay_guarded_including_daemon_threads(self):
        with tempfile.TemporaryDirectory(prefix='shared-policy-late-thread-') as directory:
            root = Path(directory)
            marker = root / 'marker.txt'
            file = root / 'neutral.py'
            for daemon in (False, True):
                with self.subTest(daemon=daemon):
                    file.write_text('import threading, time\ndef target():\n'
                                    '    def child():\n'
                                    '        time.sleep(0.15)\n'
                                    f'        open({str(marker)!r}, "w").write("must not be written")\n'
                                    f'    threading.Thread(target=child, daemon={daemon!r}).start()\n'
                                    '    return 7\n', encoding='utf-8')
                    facts = json.loads(self.invoke('dynamic_tracer.py', [file, 'target', '[[]]']).stdout)
                    self.assertFalse(marker.exists())
                    self.assertEqual(facts['cases'][0]['status'], 'blocked')
                    self.assertEqual(facts['examples'], [])
                    self.assertEqual(facts['errors'], [])

    def test_raw_thread_start_and_saved_alias_are_blocked_before_spawn(self):
        with tempfile.TemporaryDirectory(prefix='shared-policy-raw-thread-') as directory:
            root = Path(directory)
            marker = root / 'marker.txt'
            file = root / 'neutral.py'
            starts = ('_thread.start_new_thread(child, ())', 'saved_start(child, ())')
            import _thread
            if hasattr(_thread, 'start_joinable_thread'):
                starts += ('_thread.start_joinable_thread(child)',)
            for expression in starts:
                with self.subTest(expression=expression):
                    file.write_text('import _thread, time\nfrom _thread import start_new_thread as saved_start\n'
                                    'def target():\n'
                                    '    def child():\n'
                                    '        time.sleep(0.04)\n'
                                    f'        open({str(marker)!r}, "w").write("blocked")\n'
                                    f'    try: {expression}\n'
                                    '    except Exception: pass\n'
                                    '    return 7\n', encoding='utf-8')
                    facts = json.loads(self.invoke('dynamic_tracer.py', [file, 'target', '[[]]']).stdout)
                    self.assertFalse(marker.exists())
                    self.assertEqual(facts['cases'][0]['status'], 'blocked')
                    self.assertIn('unmanaged low-level thread startup', facts['blocked_operations'][0])
                    self.assertEqual(facts['examples'], [])

    def test_background_exception_is_worker_error_and_late_stdout_stays_out_of_json(self):
        source = ('import threading, time\ndef target():\n'
                  '    def child():\n'
                  '        time.sleep(0.05)\n'
                  '        print("late output")\n'
                  '        raise AssertionError("background failure")\n'
                  '    threading.Thread(target=child, daemon=True).start()\n'
                  '    return 7\n')
        with tempfile.TemporaryDirectory(prefix='shared-policy-background-error-') as directory:
            file = Path(directory) / 'neutral.py'
            file.write_text(source, encoding='utf-8')
            facts = json.loads(self.invoke('dynamic_tracer.py', [file, 'target', '[[]]']).stdout)
        self.assertEqual(facts['cases'][0]['status'], 'worker_error')
        self.assertEqual(facts['cases'][0]['reason'], 'background-execution-failed')
        self.assertEqual(facts['examples'], [])
        self.assertEqual(facts['errors'], [])
        self.assertEqual(facts['blocked_operations'], [])

    def test_trace_cannot_disable_ambient_observer_and_swallow_violation(self):
        source = ('import sys\nimport time\n'
                  'def target():\n'
                  '    try: sys.setprofile(None)\n'
                  '    except Exception: pass\n'
                  '    return time.time()\n')
        with tempfile.TemporaryDirectory(prefix='shared-policy-observer-') as directory:
            file = Path(directory) / 'neutral.py'
            file.write_text(source, encoding='utf-8')
            facts = json.loads(self.invoke('dynamic_tracer.py', [file, 'target', '[[]]']).stdout)
        self.assertEqual(facts['cases'][0]['status'], 'blocked')
        self.assertEqual(facts['examples'], [])

    def test_formal_tests_and_mutants_do_not_count_swallowed_io_as_success(self):
        with tempfile.TemporaryDirectory(prefix='shared-policy-mutation-') as directory:
            root = Path(directory)
            source = root / 'neutral.py'
            source.write_text('def target(value):\n    if value:\n        try: open(__file__)\n'
                              '        except Exception: pass\n    return 7\n', encoding='utf-8')
            test = root / 'generated.py'
            test.write_text('import unittest\nfrom neutral import target\nclass Cases(unittest.TestCase):\n'
                            '    def test_target(self): self.assertEqual(target(True), 7)\n', encoding='utf-8')
            run = self.invoke('generated_test_runner.py', ['generated'], cwd=directory)
            self.assertEqual(run.returncode, 86, run.stderr)
            self.assertIn('TEST_ISOLATION_BLOCKED', run.stderr)
            test.write_text(test.read_text(encoding='utf-8').replace('target(True)', 'target(False)'), encoding='utf-8')
            run = self.invoke('basic_mutation_runner.py', [source, test, '8', '3', 'target'], cwd=directory)
            self.assertEqual(run.returncode, 0, run.stderr)
            report = json.loads(run.stdout)
            self.assertTrue(report['baseline_passed'])
            self.assertGreater(report['errors'], 0)
            blocked = [row for row in report['mutants'] if 'TEST_ISOLATION_BLOCKED' in row.get('output', '')]
            self.assertTrue(blocked)
            self.assertTrue(all(row['status'] == 'ERROR' for row in blocked))

    def test_imports_async_mock_io_and_independent_sqlite_stay_usable(self):
        source = ('import asyncio\nimport sqlite3\nfrom unittest.mock import patch, mock_open\n'
                  'async def target():\n'
                  '    await asyncio.sleep(0)\n'
                  '    with patch("builtins.open", mock_open(read_data="virtual")):\n'
                  '        text = open("unused").read()\n'
                  '    with sqlite3.connect(":memory:") as connection:\n'
                  '        value = connection.execute("select 7").fetchone()[0]\n'
                  '    return text, value\n')
        with tempfile.TemporaryDirectory(prefix='shared-policy-allowed-') as directory:
            file = Path(directory) / 'neutral.py'
            file.write_text(source, encoding='utf-8')
            preflight = json.loads(self.invoke('module_preflight.py', payload={
                'file': str(file), 'module': 'neutral', 'importPaths': [directory]}).stdout)
            self.assertTrue(preflight['ok'], preflight)
            facts = json.loads(self.invoke('dynamic_tracer.py', [file, 'target', '[[]]']).stdout)
            self.assertEqual(facts['examples'][0]['result'], "('virtual', 7)")
            self.assertTrue(facts['examples'][0].get('call_assertable', True))
            Path(directory, 'generated.py').write_text(
                'import unittest\nfrom neutral import target\nclass Cases(unittest.IsolatedAsyncioTestCase):\n'
                '    async def test_target(self): self.assertEqual(await target(), ("virtual", 7))\n', encoding='utf-8')
            result = self.invoke('generated_test_runner.py', ['generated'], cwd=directory)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
