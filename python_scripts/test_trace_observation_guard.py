import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).parent
sys.path.insert(0, str(SCRIPTS))
from trace_observation_guard import observe_ambient_reads


class ObservationGuardTests(unittest.TestCase):
    def trace(self, source, target='target', inputs=None, helpers=None):
        with tempfile.TemporaryDirectory(prefix='ambient-trace-') as directory:
            root = pathlib.Path(directory)
            file = root / 'neutral.py'
            file.write_text(source, encoding='utf-8')
            for name, content in (helpers or {}).items():
                (root / name).write_text(content, encoding='utf-8')
            run = subprocess.run([sys.executable, '-B', str(SCRIPTS / 'dynamic_tracer.py'),
                                  str(file), target, json.dumps(inputs if inputs is not None else [[]])],
                                 capture_output=True, text=True, timeout=15)
            self.assertEqual(run.returncode, 0, run.stderr)
            facts = json.loads(run.stdout)
            self.assertIsNone(facts['load_error'], facts.get('load_diagnostic'))
            return facts

    def assert_ambient(self, facts, operation):
        records = facts['examples'] + facts['errors']
        self.assertTrue(records)
        for record in records:
            self.assertFalse(record.get('call_assertable', True), record)
            self.assertEqual(record['oracle_reason'], 'uncontrolled-ambient-read')
            self.assertIn(operation, record['non_deterministic_operations'])

    def test_clock_values_remain_diagnostic_even_when_equal_at_coarse_precision(self):
        for expression, operation in [('datetime.now().strftime("%Y")', 'datetime.datetime.now'),
                                      ('datetime.utcnow().isoformat()', 'datetime.datetime.utcnow'),
                                      ('date.today().year', 'datetime.date.today')]:
            with self.subTest(expression=expression):
                self.assert_ambient(self.trace('from datetime import datetime, date\n'
                                               f'def target(): return {expression}\n'), operation)

    def test_bound_alias_and_local_helper_are_observed_by_callable_identity(self):
        self.assert_ambient(self.trace('from datetime import datetime as Clock\nread = Clock.now\n'
                                       'def helper(): return read().year\n'
                                       'def target(): return helper()\n'), 'datetime.datetime.now')
        self.assert_ambient(self.trace('from helper import read\ndef target(): return read()\n',
                                      helpers={'helper.py': 'from time import time_ns as read\n'}), 'time.time_ns')

    def test_import_time_clock_state_is_not_a_fixed_oracle(self):
        self.assert_ambient(self.trace('from helper import STAMP\ndef target(): return STAMP\n',
                                      helpers={'helper.py': 'from datetime import datetime\nSTAMP = datetime.now().year\n'}),
                            'datetime.datetime.now')

    def test_import_initializers_calling_library_entropy_are_diagnostic(self):
        for source, operation in [('import uuid\nVALUE = str(uuid.uuid4())\n', 'os.urandom'),
                                  ('import random\nVALUE = random.randint(0, 100)\n', 'random.getrandbits')]:
            self.assert_ambient(self.trace(source + 'def target(): return VALUE\n'), operation)

    def test_unused_library_import_initialization_is_not_target_entropy(self):
        facts = self.trace('import uuid\nimport random\ndef target(): return 3\n')
        self.assertTrue(facts['examples'][0].get('call_assertable', True))

    def test_time_dependent_exception_is_not_an_exception_fact(self):
        facts = self.trace('import time\ndef target():\n    if time.time() > 0: raise ValueError("observed")\n')
        self.assertTrue(facts['errors'])
        self.assert_ambient(facts, 'time.time')

    def test_constructor_and_property_clock_reads_are_not_fixed_oracles(self):
        facts = self.trace('from datetime import datetime\nclass Clock:\n'
                           '    def __init__(self): self.value = datetime.now().year\n'
                           '    @property\n    def year(self): return self.value\n', 'Clock.year')
        self.assert_ambient(facts, 'datetime.datetime.now')

    def test_async_and_generator_clock_reads_are_observed(self):
        for source in ['async def target(): return time.time_ns()',
                       'def target(): yield time.time_ns()',
                       'async def target(): yield time.time_ns()']:
            self.assert_ambient(self.trace('import time\n' + source + '\n'), 'time.time_ns')

    def test_pure_async_loop_plumbing_does_not_taint_observations(self):
        facts = self.trace('import asyncio\nasync def target():\n    await asyncio.sleep(0)\n    return 4\n')
        self.assertEqual(facts['examples'][0]['result'], '4')
        self.assertTrue(facts['examples'][0].get('call_assertable', True))

    def test_random_alias_entropy_and_uuid_are_diagnostic(self):
        for imports, expression, operation in [
            ('from random import random as read', 'read()', 'random.random'),
            ('import random', 'random.choice([1, 2])', 'random.getrandbits'),
            ('import secrets', 'secrets.token_hex(4)', 'os.urandom'),
            ('import uuid', 'str(uuid.uuid4())', 'os.urandom')]:
            self.assert_ambient(self.trace(f'{imports}\ndef target(): return {expression}\n'), operation)

    def test_private_explicitly_seeded_rng_is_controlled_but_shared_rng_is_not(self):
        facts = self.trace('import random\ndef target(): return random.Random(42).random()\n')
        self.assertTrue(facts['examples'][0].get('call_assertable', True))
        self.assert_ambient(self.trace('import random\nrng = random.Random(42)\n'
                                       'def target(): return rng.random()\n'), 'random.random')
        self.assert_ambient(self.trace('import random\ndef target():\n'
                                       '    rng = random.Random(42)\n    rng.seed()\n    return rng.random()\n'), 'random.random')

    def test_identically_named_user_methods_and_literal_datetime_are_not_clocks(self):
        facts = self.trace('from datetime import datetime\nclass Clock:\n'
                           '    @staticmethod\n    def now(): return 7\n'
                           'def target(): return [Clock.now(), datetime(2000, 1, 1).year]\n')
        self.assertTrue(facts['examples'][0].get('call_assertable', True))

    def test_explicit_clock_mock_is_controlled(self):
        facts = self.trace('from datetime import datetime\nfrom unittest.mock import patch\n'
                           'def target():\n    with patch("neutral.datetime") as clock:\n'
                           '        clock.now.return_value.year = 2001\n        return datetime.now().year\n')
        self.assertEqual(facts['examples'][0]['result'], '2001')
        self.assertTrue(facts['examples'][0].get('call_assertable', True))

    def test_unexecuted_clock_branch_does_not_taint_a_pure_path(self):
        facts = self.trace('import time\ndef target(value):\n    if value: return time.time_ns()\n    return 3\n', inputs=[[False]])
        pure = next(e for e in facts['examples'] if e['args'] == ['False'])
        self.assertTrue(pure.get('call_assertable', True))

    def test_module_attribute_clock_mock_does_not_change_guard_type_identity(self):
        facts = self.trace('import datetime\nfrom unittest.mock import patch\n'
                           'def target():\n    with patch("datetime.datetime") as clock:\n'
                           '        clock.now.return_value.year = 2001\n        return datetime.datetime.now().year\n')
        self.assertEqual(facts['examples'][0]['result'], '2001')
        self.assertTrue(facts['examples'][0].get('call_assertable', True))

    def test_worker_thread_clock_is_observed_and_hooks_are_restored(self):
        self.assert_ambient(self.trace('import time\nfrom concurrent.futures import ThreadPoolExecutor\n'
                                       'def read(): return time.time_ns()\ndef target():\n'
                                       '    with ThreadPoolExecutor(1) as pool: return pool.submit(read).result()\n'), 'time.time_ns')
        import threading
        old, old_thread = sys.getprofile(), threading.getprofile()
        with observe_ambient_reads(str(SCRIPTS)):
            self.assertIsNot(sys.getprofile(), old)
        self.assertIs(sys.getprofile(), old)
        self.assertIs(threading.getprofile(), old_thread)

    def test_import_diagnostic_keeps_application_origin_not_guard_frame(self):
        from dynamic_tracer import _blocked_trace_operation, import_diagnostic, TraceSafetyError
        try:
            exec(compile('blocked()', str(SCRIPTS / 'neutral_origin.py'), 'exec'),
                 {'blocked': _blocked_trace_operation('Path.mkdir')})
        except TraceSafetyError as error:
            diagnostic = import_diagnostic(error, str(SCRIPTS))
            self.assertEqual(diagnostic['blocked_operation'], 'Path.mkdir')
            self.assertEqual(diagnostic['origin'], {'file': 'neutral_origin.py', 'line': 1})
            with tempfile.TemporaryDirectory() as unrelated:
                self.assertNotIn('origin', import_diagnostic(error, unrelated))
        else:
            self.fail('The side-effect guard must remain active')
