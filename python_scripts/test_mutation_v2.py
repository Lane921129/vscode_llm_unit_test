import ast
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import basic_mutation_runner as runner
from mutation_operators_v2 import iter_mutations


class MutationV2Tests(unittest.TestCase):
    def variants(self, expression):
        tree = ast.parse('def target(x, y):\n    return ' + expression + '\n')
        return [(record, ast.unparse(variant)) for record, variant in iter_mutations(tree, tree.body[0])]

    def test_numeric_boundaries_arithmetic_comparison_and_unary(self):
        variants = self.variants('x / 100')
        self.assertEqual({r['to'] for r, _ in variants if r['kind'] == 'numeric_constant'}, {'0', '1', '99', '101', '-100'})
        self.assertEqual({r['to'] for r, _ in variants if r['kind'] == 'binary'}, {'Add', 'Sub', 'Mult', 'FloorDiv', 'Mod', 'Pow'})
        self.assertEqual({r['to'] for r, _ in self.variants('x < y') if r['kind'] == 'compare'}, {'Eq', 'NotEq', 'LtE', 'Gt', 'GtE'})
        self.assertTrue(any('return x' in source for r, source in self.variants('not x') if r['kind'] == 'unary'))
        self.assertTrue(any('return -x' in source for r, source in self.variants('+x') if r['kind'] == 'unary'))

    def test_strings_containers_and_index_boundaries_are_single_site(self):
        self.assertEqual({r['to'] for r, _ in self.variants("'值'") if r['kind'] == 'string_constant'}, {"''", "'值__mutated__'"})
        containers = [source for r, source in self.variants('[x, y]') if r['kind'] == 'container']
        self.assertTrue(any('return []' in source for source in containers))
        self.assertTrue(any('return [y]' in source for source in containers))
        self.assertTrue(any('return [x]' in source for source in containers))
        boundaries = [source for r, source in self.variants('x[y]') if r['kind'] == 'index_boundary']
        self.assertTrue(any('x[y + 1]' in source for source in boundaries))
        self.assertTrue(any('x[y - 1]' in source for source in boundaries))
        for _, source in self.variants('x[y:100]'):
            compile(source, '<variant>', 'exec')

    def test_function_body_scope_and_v1_reconstruction_are_preserved(self):
        tree = ast.parse('def target(x=100):\n    def nested(): return 200\n    return x + 1\n'
                         'def other(): return 300\n')
        variants = list(iter_mutations(tree, tree.body[0]))
        self.assertTrue(all(record['line'] == 3 for record, _ in variants))
        self.assertFalse(any(record['from'] in ('100', '200', '300') for record, _ in variants))
        old = runner.mutation_candidates(tree, tree.body[0])
        self.assertEqual(len(old), 3)
        self.assertIn('return x - 1', ast.unparse(runner.apply_mutation(tree, 1, 'target')))
        self.assertTrue(any(record['to'] == '0' for record, _ in self.variants('2j')
                            if record['kind'] == 'numeric_constant'))
        if hasattr(ast, 'MatchSingleton'):
            match_tree = ast.parse('def target(x):\n    match x:\n        case None: return True\n    return False\n')
            matches = [(record, variant) for record, variant in iter_mutations(match_tree, match_tree.body[0])
                       if record['kind'] == 'match_literal']
            self.assertEqual(len(matches), 1)
            self.assertIn('case True:', ast.unparse(matches[0][1]))
            compile(matches[0][1], '<variant>', 'exec')
        documented = ast.parse('"""module docs"""\ndef target(x):\n    """target docs"""\n    return "value"\n')
        for scope in (documented, documented.body[1]):
            strings = [record for record, _ in iter_mutations(documented, scope) if record['kind'] == 'string_constant']
            self.assertEqual(len(strings), 2)
            self.assertTrue(all(record['from'] == "'value'" for record in strings))

    def measure(self, root, **kwargs):
        source, tests = root / 'sample.py', root / 'test_sample.py'
        source.write_text('def target(x):\n    return x + 1\n', encoding='utf-8')
        tests.write_text('import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
                         '    def test_value(self):\n        self.assertEqual(target(3), 4)\n', encoding='utf-8')
        return runner.run_mutation_trials(source, tests, max_mutations=0, target_function='target', **kwargs)

    def test_real_parallel_trials_identify_killing_tests_and_keep_deterministic_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            first = self.measure(Path(directory), workers=2)
            second = self.measure(Path(directory), workers=1)
        self.assertEqual(first['operatorSetVersion'], 'builtin-ast-v2')
        self.assertEqual(first['executionBackend'], 'isolated-unittest-v1')
        self.assertEqual(first['status'], 'complete')
        self.assertGreater(first['counts']['available'], 3)
        self.assertEqual(first['candidateIds'], second['candidateIds'])
        self.assertEqual(first['counts'], second['counts'])
        for mutant in first['mutants']:
            self.assertGreaterEqual(mutant['elapsedMs'], 0)
            if mutant['status'] == 'KILLED':
                self.assertEqual(mutant['killedBy'], ['test_sample.Cases.test_value'])
                self.assertEqual(mutant['testFailures'][0]['phase'], 'test')

    def test_bounded_parallelism_uses_distinct_directories(self):
        active = peak = 0
        lock = threading.Lock()
        directories = []
        def fake_run(args, **kwargs):
            nonlocal active, peak
            is_mutant = kwargs['cwd'].name.startswith('mutant_')
            if is_mutant:
                with lock:
                    active += 1
                    peak = max(peak, active)
                    directories.append(str(kwargs['cwd']))
                time.sleep(.03)
            Path(args[args.index('--result-json') + 1]).write_text(json.dumps({
                'schemaVersion': 'generated-test-result-v1', 'testsRun': 1, 'status': 'passed', 'testFailures': []}), encoding='utf-8')
            if is_mutant:
                with lock:
                    active -= 1
            self.assertNotIn('start_new_session', kwargs)
            self.assertNotIn('creationflags', kwargs)
            return subprocess.CompletedProcess(args, 0, '', '')
        with tempfile.TemporaryDirectory() as directory, patch.object(runner.subprocess, 'run', side_effect=fake_run):
            result = self.measure(Path(directory), workers=2)
        self.assertEqual(peak, 2)
        self.assertEqual(len(directories), len(set(directories)))
        self.assertEqual(result['counts']['executed'], result['counts']['available'])

    def test_missing_structured_report_and_fixture_error_cannot_kill(self):
        def fake_run(args, **kwargs):
            baseline = kwargs['cwd'].name == 'baseline'
            if baseline:
                Path(args[-1]).write_text(json.dumps({'schemaVersion': 'generated-test-result-v1', 'testsRun': 1,
                                                    'status': 'passed', 'testFailures': []}), encoding='utf-8')
            return subprocess.CompletedProcess(args, 0 if baseline else 1, '', 'FAIL: guessed.name')
        with tempfile.TemporaryDirectory() as directory, patch.object(runner.subprocess, 'run', side_effect=fake_run):
            result = self.measure(Path(directory), workers=1, operator_version='builtin-ast-v1')
        self.assertEqual(result['counts']['killed'], 0)
        self.assertEqual(result['counts']['error'], 3)
        self.assertTrue(all('killedBy' not in m for m in result['mutants']))

    def test_real_setup_failures_are_errors_without_killing_test_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, tests = root / 'sample.py', root / 'test_sample.py'
            source.write_text('def target(x):\n    return x + 1\n', encoding='utf-8')
            tests.write_text('import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
                             '    def setUp(self): self.assertEqual(target(3), 4)\n'
                             '    def test_value(self): self.assertTrue(True)\n', encoding='utf-8')
            result = runner.run_mutation_trials(source, tests, max_mutations=0, target_function='target',
                                               operator_version='builtin-ast-v1', workers=2)
        self.assertTrue(result['baseline_passed'])
        self.assertEqual(result['counts']['killed'], 0)
        self.assertEqual(result['counts']['error'], 3)
        self.assertFalse(result['scoreAvailable'])
        self.assertTrue(all('killedBy' not in m for m in result['mutants']))

    def test_optional_external_metadata_cannot_claim_unexecuted_kills(self):
        def provider(tree, scope, source_hash, scope_name, scope_version):
            variant = ast.unparse(runner.apply_mutation(tree, 0, 'target'))
            return {'engine': 'mutatest', 'engineVersion': '3.1.0', 'operatorSetVersion': 'test-provider-v1',
                    'excluded': {'noop': 2, 'duplicate': 3, 'invalid': 4},
                    'candidates': [({'id': 'a' * 64, 'kind': 'return', 'line': 2, 'column': 4, 'position': 0,
                                     'from': 'return', 'to': 'None', 'killedBy': ['invented.test'], 'elapsedMs': 999}, variant)]}
        with tempfile.TemporaryDirectory() as directory:
            result = self.measure(Path(directory), candidate_provider=provider)
        self.assertEqual(result['excluded'], {'noop': 2, 'duplicate': 3, 'invalid': 4})
        self.assertEqual(result['engine'], 'mutatest')
        self.assertEqual(result['engineVersion'], '3.1.0')
        self.assertEqual(result['mutants'][0]['killedBy'], ['test_sample.Cases.test_value'])

    def test_external_provider_failure_preserves_only_safe_reason_code(self):
        class Unavailable(Exception):
            reason_code = 'unsupported-version'
        def provider(*args):
            raise Unavailable('private arbitrary response')
        with tempfile.TemporaryDirectory() as directory:
            result = self.measure(Path(directory), candidate_provider=provider)
        self.assertEqual(result['status'], 'failed')
        self.assertIsNone(result['counts']['available'])
        self.assertEqual(result['diagnosticCode'], 'unsupported-version')
        self.assertNotIn('private', json.dumps(result))

    def test_deadline_keeps_unstarted_candidates_and_timeout_out_of_killed(self):
        def fake_run(args, **kwargs):
            if kwargs['cwd'].name == 'baseline':
                Path(args[-1]).write_text(json.dumps({'schemaVersion': 'generated-test-result-v1', 'testsRun': 1,
                                                    'status': 'passed', 'testFailures': []}), encoding='utf-8')
                return subprocess.CompletedProcess(args, 0, '', '')
            time.sleep(kwargs['timeout'] + .01)
            raise subprocess.TimeoutExpired(args, kwargs['timeout'])
        with tempfile.TemporaryDirectory() as directory, patch.object(runner.subprocess, 'run', side_effect=fake_run):
            result = self.measure(Path(directory), workers=2, stage_timeout_seconds=.2)
        self.assertEqual(result['counts']['killed'], 0)
        self.assertLessEqual(result['counts']['executed'], 2)
        self.assertGreater(result['counts']['notRun'], 0)
        self.assertFalse(result['scoreAvailable'])
        self.assertTrue(all('killedBy' not in m for m in result['mutants']))

    def test_invalid_workers_and_versions_are_rejected(self):
        for workers in (0, 5, True, 1.5):
            with self.assertRaises(ValueError):
                runner.run_mutation_trials('missing', 'missing', workers=workers)
        with self.assertRaises(ValueError):
            runner.run_mutation_trials('missing', 'missing', operator_version='unknown')


class StructuredTestResultsTests(unittest.TestCase):
    def invoke(self, source):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'test_sample.py').write_text(source, encoding='utf-8')
            result = subprocess.run([sys.executable, '-B', str(Path(runner.__file__).with_name('generated_test_runner.py')),
                                     'test_sample', '--result-json', str(root / 'result.json')], cwd=root,
                                    capture_output=True, text=True, encoding='utf-8', timeout=15,
                                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
            return result.returncode, json.loads((root / 'result.json').read_text(encoding='utf-8'))

    def test_failure_error_and_subtest_ids_do_not_include_exception_or_parameters(self):
        code, result = self.invoke('import unittest\nclass Cases(unittest.TestCase):\n'
                                   '    def test_failure(self): self.assertEqual(1, 2, "private message")\n'
                                   '    def test_error(self): raise ValueError("private exception")\n'
                                   '    def test_subtest(self):\n'
                                   '        with self.subTest(value="private parameter"): self.assertTrue(False)\n')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual({r['testId'] for r in result['testFailures']}, {
            'test_sample.Cases.test_failure', 'test_sample.Cases.test_error', 'test_sample.Cases.test_subtest'})
        self.assertNotIn('private', json.dumps(result))

    def test_loader_setup_cleanup_and_zero_tests_are_not_actual_test_failures(self):
        sources = [
            'raise ValueError("load failure")\n',
            'import unittest\nclass Cases(unittest.TestCase):\n    def setUp(self): raise ValueError()\n    def test_one(self): pass\n',
            'import unittest\nclass Cases(unittest.TestCase):\n    def tearDown(self): raise ValueError()\n    def test_one(self): pass\n',
            'import unittest\nclass Cases(unittest.TestCase):\n    def setUp(self):\n        with self.subTest(): self.assertTrue(False)\n    def test_one(self): pass\n',
            'import unittest\nclass Cases(unittest.IsolatedAsyncioTestCase):\n    async def asyncSetUp(self): raise ValueError()\n    async def test_one(self): pass\n',
            'import unittest\n',
        ]
        for source in sources:
            code, result = self.invoke(source)
            self.assertNotEqual(code, 0)
            self.assertEqual(result['status'], 'runner-error')

    def test_background_error_with_a_failed_test_is_not_a_kill(self):
        code, result = self.invoke('import unittest, threading\nclass Cases(unittest.TestCase):\n'
                                   '    def test_background(self):\n'
                                   '        def worker(): raise ValueError("background")\n'
                                   '        thread = threading.Thread(target=worker)\n'
                                   '        thread.start()\n        thread.join()\n'
                                   '        self.assertTrue(False)\n')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'runner-error')
        self.assertEqual(result['testFailures'], [])

    def test_isolation_violation_is_not_a_kill(self):
        code, result = self.invoke('import unittest\nclass Cases(unittest.TestCase):\n'
                                   '    def test_io(self): open("forbidden.txt", "w")\n')
        self.assertEqual(code, 86)
        self.assertEqual(result['status'], 'isolation-blocked')
        self.assertEqual(result['testFailures'], [])


if __name__ == '__main__':
    unittest.main()
