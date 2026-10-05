"""Baseline-only regressions: no mutant trials or external model calls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from basic_mutation_runner import run_mutation_trials


def no_candidates(*args):
    return {'engine': 'builtin', 'operatorSetVersion': 'builtin-ast-v2', 'candidates': []}


class MutationBaselineRepairTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='baseline-repair-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'sample.py'
        self.tests = self.root / 'test_sample.py'
        self.source.write_text('def target(x): return x + 1\n', encoding='utf-8')

    def measure(self, body):
        self.tests.write_text('import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n' + body,
                              encoding='utf-8')
        return run_mutation_trials(self.source, self.tests, target_function='target', timeout_seconds=5,
                                   stage_timeout_seconds=10, candidate_provider=no_candidates)

    def test_fixture_and_test_body_have_distinct_baseline_status(self):
        cases = [
            ('failed', '    def test_value(self): self.assertEqual(target(1), 99)\n'),
            ('error', '    def setUp(self): raise ValueError("fixture")\n    def test_value(self): self.assertEqual(target(1), 2)\n'),
            ('error', '    def tearDown(self): raise ValueError("fixture")\n    def test_value(self): self.assertEqual(target(1), 2)\n'),
            ('error', '    def setUp(self): self.addCleanup(self.broken)\n    def broken(self): raise ValueError("cleanup")\n    def test_value(self): self.assertEqual(target(1), 2)\n'),
        ]
        for expected, body in cases:
            with self.subTest(expected=expected, body=body):
                result = self.measure(body)
                self.assertEqual(result['baselineStatus'], expected)
                self.assertFalse(result['baseline_passed'])
                self.assertFalse(result['scoreAvailable'])
                self.assertEqual(result['counts']['killed'], 0)

    def test_invalid_missing_and_inconsistent_runner_results_are_errors(self):
        results = [None, 'broken-json', {'schemaVersion': 'unittest-result-v1', 'status': 'passed',
                                       'testsRun': 1, 'testFailures': []}]
        for value in results:
            with self.subTest(value=value):
                def fake_run(args, **kwargs):
                    result_file = Path(args[args.index('--result-json') + 1])
                    if value is not None:
                        result_file.write_text(value if isinstance(value, str) else json.dumps(value), encoding='utf-8')
                    return subprocess.CompletedProcess(args, 2, '', 'runner failed')
                with patch('basic_mutation_runner.subprocess.run', side_effect=fake_run):
                    result = self.measure('    def test_value(self): self.assertEqual(target(1), 2)\n')
                self.assertEqual(result['baselineStatus'], 'error')
                self.assertFalse(result['scoreAvailable'])

    def test_timeout_stays_timeout(self):
        with patch('basic_mutation_runner.subprocess.run', side_effect=subprocess.TimeoutExpired('runner', 5)):
            result = self.measure('    def test_value(self): self.assertEqual(target(1), 2)\n')
        self.assertEqual(result['baselineStatus'], 'timeout')
        self.assertEqual(result['counts']['killed'], 0)

    def test_deep_package_inherits_project_import_roots_but_executes_isolated_source(self):
        package = self.root / 'pkg' / 'sub'
        package.mkdir(parents=True)
        (package.parent / '__init__.py').write_text('', encoding='utf-8')
        (package / '__init__.py').write_text('', encoding='utf-8')
        (self.root / 'shared.py').write_text('VALUE=9\n', encoding='utf-8')
        target = package / 'target.py'
        target.write_text('from shared import VALUE\ndef target(x): return x + VALUE\n', encoding='utf-8')
        self.tests.write_text('import unittest\nfrom pkg.sub import target\n'
                             'class Cases(unittest.TestCase):\n'
                             '    def test_value(self):\n'
                             '        self.assertEqual(target.target(1), 10)\n'
                             '        self.assertIn("llm_unit_mutation_", target.__file__)\n', encoding='utf-8')
        with patch.dict(os.environ, {'PYTHONPATH': str(self.root)}):
            result = run_mutation_trials(target, self.tests, target_function='target', timeout_seconds=5,
                                         stage_timeout_seconds=10, candidate_provider=no_candidates)
        self.assertTrue(result['baseline_passed'], result.get('baseline_output'))
        self.assertEqual(result['counts']['executed'], 0)


if __name__ == '__main__':
    unittest.main()
