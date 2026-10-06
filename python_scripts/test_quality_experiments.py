"""Actual isolated state observation, baseline, and mutation regressions."""
import ast
import copy
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quality_experiment_runner import plan, run, novelty, merge_tests, digest, worker, fingerprint
from basic_mutation_runner import run_mutation_trials, find_target_scope, mutation_candidates
from external_mutation_runner import mutatest_candidates

SOURCE = '''class Inventory:
    def __init__(self):
        self.entries = {}

    def register(self, label, unit_cost, count=1):
        if unit_cost < 0:
            raise ValueError('negative cost')
        if count <= 0:
            raise ValueError('invalid count')
        if label in self.entries:
            self.entries[label]['count'] += count
        else:
            self.entries[label] = {'cost': unit_cost, 'count': count}

    def discard(self, label):
        if label in self.entries:
            del self.entries[label]
        else:
            raise KeyError('unknown entry: ' + label)
'''

TESTS = '''import unittest
from sample import Inventory
class Cases(unittest.TestCase):
    def setUp(self):
        self.subject = Inventory()
    def test_value(self):
        self.assertIsNone(self.subject.register('item', 2))
        self.assertIsNone(self.subject.register('item', 3))
    def test_invalid(self):
        with self.assertRaises(ValueError):
            self.subject.register('item', -1)
        with self.assertRaises(ValueError):
            self.subject.register('item', 2, -1)
    def test_missing(self):
        with self.assertRaises(KeyError):
            self.subject.discard('missing')
'''


class QualityExperimentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='quality-experiments-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'sample.py'
        self.source.write_bytes(SOURCE.encode('utf-8'))
        self.tests = self.root / 'test_candidate.py'
        self.tests.write_bytes(TESTS.encode('utf-8'))

    def payload(self, target='Inventory.register', kind='AugAssign', source=SOURCE, tests=TESTS):
        scope = find_target_scope(ast.parse(source), target)
        if kind == 'AugAssign':
            node = next(n for n in ast.walk(scope) if isinstance(n, ast.AugAssign))
            original, changed = 'AugAssign_Add', 'AugAssign_Sub'
        elif kind == 'Compare':
            node = next(n for n in ast.walk(scope) if isinstance(n, ast.Compare) and isinstance(n.ops[0], ast.LtE))
            original, changed = 'LtE', 'Lt'
        else:
            node = next(n for n in ast.walk(scope) if isinstance(n, ast.If))
            original, changed = 'If_Statement', 'If_True'
        return {'sourcePath': str(self.source), 'source': source, 'target': target, 'module': 'sample', 'testCode': tests,
                'focus': {'id': 'gap-1', 'kind': 'survivor', 'evidence': 'measured mutant', 'mutant': {
                    'id': 'm1', 'kind': kind, 'line': node.lineno, 'column': node.col_offset,
                    'position': 0, 'from': original, 'to': changed, 'status': 'SURVIVED'}}}

    def baseline(self, code):
        self.tests.write_bytes(code.encode('utf-8'))
        return subprocess.run([sys.executable, '-B', str(Path(__file__).parent / 'generated_test_runner.py'),
                               self.tests.stem], cwd=self.root, text=True, encoding='utf-8', capture_output=True,
                              env={**os.environ, 'PYTHONPATH': str(self.root), 'PYTHONIOENCODING': 'utf-8'}, timeout=12)

    def assert_mutation_improves(self, candidate_provider=None):
        initial = self.payload()
        state = run(initial)
        self.assertEqual(state['status'], 'observed', state)
        self.assertFalse(state['assertionOracle'])
        self.assertIn("'count': 2", state['testCode'])
        self.assertNotIn('setattr', state['testCode'])
        self.assertEqual(self.baseline(state['testCode']).returncode, 0)
        merged = merge_tests({'previous': TESTS, 'addition': state['testCode']})['code']
        boundary = run(self.payload(kind='Compare'))
        self.assertEqual(boundary['status'], 'observed', boundary)
        merged = merge_tests({'previous': merged, 'addition': boundary['testCode']})['code']
        self.assertEqual(self.baseline(merged).returncode, 0)
        self.tests.write_bytes(TESTS.encode('utf-8'))
        before = run_mutation_trials(self.source, self.tests, max_mutations=100,
            timeout_seconds=4, stage_timeout_seconds=40, target_function='register', target_class='Inventory',
            candidate_provider=candidate_provider, workers=2)
        self.tests.write_bytes(merged.encode('utf-8'))
        after = run_mutation_trials(self.source, self.tests, max_mutations=100,
            timeout_seconds=4, stage_timeout_seconds=40, target_function='register', target_class='Inventory',
            candidate_provider=candidate_provider, workers=2)
        self.assertEqual(before['status'], 'complete', before.get('diagnostic'))
        self.assertEqual(after['status'], 'complete', after.get('diagnostic'))
        self.assertEqual(before['candidateSetId'], after['candidateSetId'])
        self.assertGreater(after['counts']['killed'], before['counts']['killed'])
        before_survivors = {m['id'] for m in before['mutants'] if m['status'] == 'SURVIVED'}
        self.assertTrue(before_survivors)
        # The selected count/state gaps must close. unit_cost=0 is a different
        # measured gap and remains for a subsequent focused experiment.
        self.assertTrue(all(m['status'] == 'KILLED' for m in after['mutants']
                            if m['id'] in before_survivors and m['line'] != 6))
        self.assertEqual(after['counts']['timeout'] + after['counts']['error'], 0)

    def test_observed_state_and_zero_boundary_kill_real_builtin_survivors(self):
        self.assert_mutation_improves()

    def test_observed_state_and_zero_boundary_kill_real_mutatest_survivors(self):
        try:
            available = importlib.metadata.version('mutatest') == '3.1.0'
        except importlib.metadata.PackageNotFoundError:
            available = False
        if not available:
            self.skipTest('Optional verified Mutatest 3.1.0 is not installed')
        self.assert_mutation_improves(mutatest_candidates)

    def test_exception_arguments_distinguish_same_exception_type(self):
        result = run(self.payload('Inventory.discard', 'If'))
        self.assertEqual(result['status'], 'observed', result)
        self.assertIn('observed_exception.exception.args', result['testCode'])
        self.assertEqual(self.baseline(result['testCode']).returncode, 0)
        mutated = SOURCE.replace('if label in self.entries:\n            del', 'if True:\n            del')
        self.source.write_bytes(mutated.encode('utf-8'))
        self.assertNotEqual(self.baseline(result['testCode']).returncode, 0)

    def test_builtin_and_mutatest_positions_produce_same_experiment_without_provider_rules(self):
        external = self.payload()
        builtin = copy.deepcopy(external)
        builtin['focus']['mutant'].update(kind='augmented_assignment', **{'from': 'Add', 'to': 'Sub'})
        self.assertEqual(plan(external)['experiments'], plan(builtin)['experiments'])
        data = self.payload(kind='Compare')
        data['focus']['mutant']['column'] += 1
        self.assertEqual(plan(data)['status'], 'unsupported')

    def test_fingerprint_prevents_repeated_experiments_even_after_renaming_tests(self):
        data = self.payload()
        first = plan(data)
        data['triedFingerprints'] = [e['fingerprint'] for e in first['experiments']]
        data['focus']['id'] = 'new-wording-same-experiment'
        data['testCode'] = TESTS.replace('test_value', 'test_new_name')
        second = plan(data)
        self.assertFalse(set(data['triedFingerprints']) & {e['fingerprint'] for e in second['experiments']})
        data['triedFingerprints'].extend(e['fingerprint'] for e in second['experiments'])
        self.assertEqual(plan(data)['status'], 'duplicate')

    def test_renamed_or_copied_methods_are_not_quality_progress(self):
        changed = TESTS.replace('test_value', 'test_value_copy').replace('self.assertIsNone', 'self.assertIsNone')
        self.assertEqual(novelty({'previous': TESTS, 'candidate': changed})['novelMethods'], 0)
        self.assertEqual(novelty({'previous': TESTS, 'candidate': 'import math\n' + changed})['novelMethods'], 0)
        tree = ast.parse(TESTS)
        cls = tree.body[-1]
        duplicate = copy.deepcopy(next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'test_value'))
        duplicate.name = 'test_value_1'
        cls.body.append(duplicate)
        self.assertEqual(novelty({'previous': TESTS, 'candidate': ast.unparse(tree)})['novelMethods'], 0)
        self.assertGreater(novelty({'previous': TESTS, 'candidate': TESTS.replace("register('item', 2)", "register('item', 2, 0)")})['novelMethods'], 0)
        changed_fixture = TESTS.replace('self.subject = Inventory()', "self.subject = Inventory()\n        self.subject.entries = {'seed': {'cost': 2, 'count': 5}}")
        self.assertGreater(novelty({'previous': TESTS, 'candidate': changed_fixture})['novelMethods'], 0)

    def test_fixture_state_mock_async_property_and_unknown_constructor_are_not_guessed(self):
        candidates = [
            TESTS.replace('Inventory()', 'Inventory(make_config())'),
            TESTS.replace("self.assertIsNone(self.subject.register('item', 2))", "self.subject.entries = {'x': 1}\n        self.assertIsNone(self.subject.register('item', 2))").replace("self.subject.register('item', -1)", "unknown.register('item', -1)").replace("self.subject.register('item', 2, -1)", "unknown.register('item', 2, -1)"),
            TESTS.replace('self.subject = Inventory()', 'self.subject = Mock()'),
            'from unittest.mock import patch as replace_dependency\n' + TESTS.replace(
                'self.subject = Inventory()', "replace_dependency('sample.external').start()\n        self.subject = Inventory()"),
        ]
        for code in candidates:
            self.assertEqual(plan(self.payload(tests=code))['status'], 'unsupported')
        for source in [SOURCE.replace('def register', 'async def register'),
                       SOURCE.replace('    def register', '    @property\n    def register'),
                       SOURCE.replace('class Inventory:', 'class Inventory(Parent):'),
                       SOURCE.replace('    def __init__', '    __slots__ = ("entries",)\n    def __init__')]:
            self.assertEqual(plan(self.payload(source=source))['status'], 'unsupported')

    def test_async_novelty_includes_cases_and_fixture_context(self):
        code = '''import unittest
from sample import compute
class Cases(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.value = 1
    async def asyncTearDown(self):
        await compute(0)
    async def test_value(self):
        observed = await compute(self.value)
        self.assertEqual(observed, 2)
'''
        same = code.replace('test_value', 'test_renamed').replace('observed', 'result')
        self.assertEqual(novelty({'previous': code, 'candidate': same})['novelMethods'], 0)
        self.assertEqual(novelty({'previous': code, 'candidate': same})['candidateMethods'], 1)
        for changed in [code.replace('observed, 2', 'observed, 3'),
                        code.replace('self.value = 1', 'self.value = 2'),
                        code.replace('await compute(0)', 'await compute(1)')]:
            self.assertEqual(novelty({'previous': code, 'candidate': changed})['novelMethods'], 1)

    def test_application_exception_string_is_never_called_outside_guard(self):
        marker = self.root / 'exception_string_called'
        source = ("class Unexpected(Exception):\n    def __str__(self):\n        open(" + repr(str(marker))
                  + ", 'w').write('called')\n        return 'unsafe'\n\n" + SOURCE)
        source = source.replace('self.entries = {}', 'raise Unexpected()\n        self.entries = {}')
        self.source.write_bytes(source.encode('utf-8'))
        result = run(self.payload(source=source))
        self.assertEqual(result['status'], 'unavailable', result)
        self.assertNotIn('testCode', result)
        self.assertFalse(marker.exists())

    def test_module_fixture_and_indirect_helper_changes_are_novel(self):
        code = '''import unittest
from sample import Inventory
INITIAL_COUNT = 2
ACTIVE_COUNT: int = 1
def setUpModule():
    global ACTIVE_COUNT
    ACTIVE_COUNT = INITIAL_COUNT
def tearDownModule():
    pass
def input_count():
    return ACTIVE_COUNT
class Cases(unittest.TestCase):
    def test_value(self):
        subject = Inventory()
        self.assertIsNone(subject.register('item', 2, input_count()))
'''
        self.assertEqual(novelty({'previous': code, 'candidate': code.replace('test_value', 'test_renamed')})['novelMethods'], 0)
        for changed in [code.replace('INITIAL_COUNT = 2', 'INITIAL_COUNT = 3'),
                        code.replace('ACTIVE_COUNT: int = 1', 'ACTIVE_COUNT: int = 2'),
                        code.replace('ACTIVE_COUNT = INITIAL_COUNT', 'ACTIVE_COUNT = INITIAL_COUNT + 1'),
                        code.replace('return ACTIVE_COUNT', 'return ACTIVE_COUNT + 1'),
                        code.replace('    pass', '    Inventory()')]:
            self.assertEqual(novelty({'previous': code, 'candidate': changed})['novelMethods'], 1)

    def test_saved_import_fixtures_propagate_and_bind_observations(self):
        marker = self.root / 'import_directory'
        source = 'from pathlib import Path\nPath(' + repr(str(marker)) + ').mkdir()\n' + SOURCE
        self.source.write_bytes(source.encode('utf-8'))
        payload = self.payload(source=source)
        self.assertEqual(run(payload)['status'], 'unavailable')
        fixture = {'schemaVersion': 'import-fixtures-v1', 'id': 'a' * 64, 'root': str(self.root),
                   'rules': [{'file': 'sample.py', 'mkdir': True, 'sourceHash': digest(source)}]}
        encoded = json.dumps(fixture)
        with patch.dict(os.environ, {'LLM_UNIT_TEST_IMPORT_FIXTURES': encoded}):
            result = run(payload)
            self.assertEqual(result['status'], 'observed', result)
            self.assertEqual(self.baseline(result['testCode']).returncode, 0)
        for item in result['experiments']:
            self.assertEqual(item['evidence']['context']['importFixturePlanHash'], digest(encoded))
        self.assertFalse(marker.exists())
        self.assertEqual(self.source.read_bytes(), source.encode('utf-8'))

    def test_ambient_reads_and_external_writes_cannot_become_assertions(self):
        for statement in ["import time\n        time.time()", "open('should_not_exist', 'w')"]:
            source = SOURCE.replace('self.entries = {}', statement + '\n        self.entries = {}')
            self.source.write_bytes(source.encode('utf-8'))
            result = run(self.payload(source=source))
            self.assertEqual(result['status'], 'unavailable', result)
            self.assertNotIn('testCode', result)
            self.assertFalse((self.root / 'should_not_exist').exists())

    def test_source_hash_changed_and_snapshot_tampering_fail_closed(self):
        planned = plan(self.payload())['experiments'][0]
        self.source.write_bytes((SOURCE + '\n# changed').encode('utf-8'))
        self.assertEqual(worker({'sourcePath': str(self.source), 'experiment': planned})['status'], 'unavailable')
        self.source.write_bytes(SOURCE.encode('utf-8'))
        planned['calls'][0]['value']['items'][0]['value'] = {'type': 'unavailable', 'reason': 'unsupported-type'}
        planned['fingerprint'] = fingerprint(planned)
        self.assertEqual(worker({'sourcePath': str(self.source), 'experiment': planned})['status'], 'unavailable')

    def test_merge_preserves_model_tests_main_guard_and_rejects_binding_collision(self):
        addition = run(self.payload())['testCode']
        original = TESTS + "\nif __name__ == '__main__':\n    unittest.main()\n"
        merged = merge_tests({'previous': original, 'addition': addition})['code']
        self.assertEqual(self.baseline(merged).returncode, 0)
        self.assertLess(merged.index('class TestVerifiedState_'), merged.index("if __name__ == '__main__':"))
        twice = merge_tests({'previous': merged, 'addition': addition})['code']
        self.assertEqual(merged, twice)
        with self.assertRaisesRegex(ValueError, 'collision'):
            merge_tests({'previous': TESTS + '\nunittest = None\n', 'addition': addition})
        altered = merged.replace("'count': 2", "'count': 999")
        restored = merge_tests({'previous': altered, 'addition': addition, 'restore': True})['code']
        self.assertEqual(restored, merged)


if __name__ == '__main__':
    unittest.main()
