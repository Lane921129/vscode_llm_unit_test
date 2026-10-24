import ast
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parameter_fixture_experiments import plan, run, worker, seed_inputs, check_replay
from quality_experiment_runner import digest, canonical

SOURCE = '''def select_label(context, event):
    label = None
    try:
        if hasattr(event, 'data') and event.data:
            label = event.data
    except Exception:
        pass
    try:
        if hasattr(event, 'key') and event.key:
            selected = context.lookup(event.key)
            if selected and hasattr(selected, 'data'):
                label = selected.data
    except Exception:
        pass
    return label
'''
TESTS = '''import unittest
import types
from sample import select_label
class ModelTests(unittest.TestCase):
    def test_seed(self):
        context = types.SimpleNamespace()
        context.lookup = lambda key: types.SimpleNamespace(data='selected')
        event = types.SimpleNamespace(data='event', key='key')
        result = select_label(context, event)
        self.assertEqual(result, 'selected')
'''


class ParameterFixtureExperimentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='parameter-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'sample.py'
        self.source.write_bytes(SOURCE.encode())

    def payload(self, tests=TESTS, source=SOURCE, line=6):
        return {'sourcePath': str(self.source), 'source': source, 'sourceHash': digest(source),
                'target': 'select_label', 'module': 'sample', 'testCode': tests,
                'focus': {'id': 'gap:' + str(line), 'kind': 'coverage', 'evidence': 'line:' + str(line), 'line': line}}

    def replay(self, addition, operation='raise', baseline=TESTS):
        payload = self.payload(tests=baseline)
        evidence = next(item for item in plan(payload)['experiments'] if item['variation']['operation'] == operation)
        return check_replay({'source': SOURCE, 'code': baseline + addition, 'baseline': baseline,
                             'module': 'sample', 'evidence': evidence})

    def test_replay_rejects_none_and_dict_instead_of_an_attribute_getter_fault(self):
        for event in ('types.SimpleNamespace(data=None, key="key")', '{"data": None, "key": "key"}',
                      'types.SimpleNamespace(key="key")'):
            addition = '\n    def test_new(self):\n        context = types.SimpleNamespace(lookup=lambda key: types.SimpleNamespace(data="selected"))\n'
            addition += '        event = ' + event + '\n        self.assertEqual(select_label(context, event), "selected")\n'
            result = self.replay(addition)
            self.assertEqual(result['status'], 'contradicted', result)
            self.assertEqual(result['reasonCode'], 'fixture-replay-input-mismatch')

    def test_replay_matches_explicit_false_recipe_but_never_borrows_the_seed_call(self):
        addition = '\n    def test_new(self):\n        context = types.SimpleNamespace(lookup=lambda key: types.SimpleNamespace(data="selected"))\n'
        addition += '        event = types.SimpleNamespace(data=None, key="key")\n        self.assertEqual(select_label(context, event), "selected")\n'
        self.assertEqual(self.replay(addition, 'false')['status'], 'matched')
        self.assertEqual(self.replay('', 'false')['status'], 'unknown')
        self.assertEqual(self.replay(addition, 'remove')['status'], 'contradicted')
        self.assertEqual(self.replay(addition.replace('data=None, ', ''), 'false')['status'], 'contradicted')

    def test_replay_keeps_local_getter_fixture_unknown_without_running_candidate_code(self):
        addition = '\n    def test_new(self):\n        class Event:\n            @property\n            def data(self):\n                raise Exception()\n'
        addition += '        context = types.SimpleNamespace(lookup=lambda key: types.SimpleNamespace(data="selected"))\n'
        addition += '        self.assertEqual(select_label(context, Event()), "selected")\n'
        self.assertEqual(self.replay(addition)['status'], 'unknown')
        marker = self.root / 'must-not-execute.txt'
        malicious = '\n    def test_new(self):\n        open(' + repr(str(marker)) + ', "w").write("bad")\n'
        malicious += '        self.assertEqual(select_label(None, None), None)\n'
        self.assertEqual(self.replay(malicious)['status'], 'unknown')
        self.assertFalse(marker.exists())

    def test_replay_does_not_decode_rebound_aliases_or_unrelated_class_side_effects(self):
        addition = '\n    def test_new(self):\n        types = None\n        self.assertEqual(select_label(None, None), None)\n'
        self.assertEqual(self.replay(addition)['status'], 'unknown')
        addition = '\nclass Setup:\n    types.SimpleNamespace = None\n'
        addition += '\nclass NewTests(unittest.TestCase):\n    def test_new(self):\n        self.assertEqual(select_label(None, None), None)\n'
        self.assertEqual(self.replay(addition)['status'], 'unknown')

    def test_replay_refuses_identity_drift_before_decoding_any_fixture(self):
        payload = self.payload()
        evidence = plan(payload)['experiments'][0]
        with self.assertRaises(ValueError):
            check_replay({'source': SOURCE + '\n# changed', 'code': TESTS, 'baseline': TESTS,
                          'module': 'sample', 'evidence': evidence})

    def test_plans_only_explicit_fixture_inputs_and_replays_observations(self):
        payload = self.payload()
        planned = plan(payload)
        self.assertEqual(planned['status'], 'planned', planned)
        self.assertEqual(planned['experiments'][0]['variation']['operation'], 'raise')
        self.assertFalse(planned['assertionOracle'])
        original = self.source.read_bytes()
        observed = run(payload)
        self.assertEqual(observed['status'], 'observed', observed)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertNotIn('testCode', observed)
        for item in observed['experiments']:
            self.assertEqual(item['status'], 'observed', item)
            evidence = item['evidence']
            self.assertEqual(evidence['sourceHash'], digest(SOURCE))
            self.assertEqual(evidence['seedHash'], digest(TESTS))
            self.assertEqual(evidence['isolation'], 'fresh-process-per-case')
            self.assertEqual(item['evidenceHash'], digest(canonical(evidence)))
            self.assertEqual(evidence['outcome']['result']['value'], {'type': 'str', 'value': 'selected'})

    def test_return_object_attributes_and_false_paths_are_source_bound(self):
        data = plan(self.payload(line=12))
        self.assertEqual(data['status'], 'planned', data)
        paths = [item['variation']['path'] for item in data['experiments']]
        # Reordering source reads cannot make a fake attribute eligible.
        self.assertTrue(all(path[0] in ('key', 'lookup') for path in paths))
        self.assertNotIn(['invented'], paths)
        self.assertEqual(plan(self.payload(line=999))['status'], 'unsupported')

    def test_candidate_code_and_unknown_factories_are_never_executed(self):
        marker = self.root / 'candidate-executed'
        bad = [TESTS.replace('context = types.SimpleNamespace()', f"open({str(marker)!r}, 'w').write('bad')\n        context = types.SimpleNamespace()"),
               TESTS.replace("lambda key: types.SimpleNamespace(data='selected')", 'lambda key: types.SimpleNamespace(data=key)'),
               TESTS.replace('context = types.SimpleNamespace()', 'context = make_application_context()'),
               TESTS.replace('context = types.SimpleNamespace()', 'types = other\n        context = types.SimpleNamespace()')]
        for code in bad:
            self.assertEqual(plan(self.payload(tests=code))['status'], 'unsupported', code)
        self.assertFalse(marker.exists())

    def test_shared_fixture_identity_and_captured_objects_are_not_copied(self):
        shared = TESTS.replace('select_label(context, event)', 'select_label(event, event)')
        captured = TESTS.replace("context.lookup = lambda key: types.SimpleNamespace(data='selected')",
                                "selected = types.SimpleNamespace(data='selected')\n        context.lookup = lambda key: selected")
        self.assertFalse(seed_inputs(shared, 'sample', 'select_label'))
        self.assertFalse(seed_inputs(captured, 'sample', 'select_label'))

    def test_fingerprint_survives_renaming_and_worker_rechecks_the_current_plan(self):
        data = self.payload()
        first = plan(data)
        renamed = plan({**data, 'testCode': TESTS.replace('test_seed', 'test_renamed')})
        self.assertEqual([x['fingerprint'] for x in first['experiments']], [x['fingerprint'] for x in renamed['experiments']])
        data['triedFingerprints'] = [first['experiments'][0]['fingerprint']]
        second = plan(data)
        self.assertEqual(second['status'], 'planned', second)
        self.assertNotIn(first['experiments'][0]['fingerprint'], [x['fingerprint'] for x in second['experiments']])
        result = run(data)
        self.assertEqual(result['status'], 'observed', result)

    def test_identity_factory_preserves_the_actual_argument_instead_of_guessing_a_return(self):
        code = TESTS.replace("lambda key: types.SimpleNamespace(data='selected')", 'lambda key: key')
        result = run(self.payload(tests=code))
        self.assertEqual(result['status'], 'observed', result)
        faults = [item['evidence'] for item in result['experiments'] if item['status'] == 'observed'
                  and item['evidence']['variation']['operation'] == 'raise']
        self.assertEqual(len(faults), 1)
        self.assertEqual(faults[0]['outcome']['result']['value'], {'type': 'none'})
        self.assertEqual(faults[0]['execution'], {'targetEntered': True, 'profileIntact': True})

    def test_argument_binding_errors_are_not_target_observations(self):
        source = SOURCE.replace('def select_label(context, event):', 'def select_label(context, event, required):')
        self.source.write_bytes(source.encode())
        result = run(self.payload(source=source))
        self.assertEqual(result['status'], 'unavailable', result)
        self.assertTrue(all(item['reason'] == 'fixture-target-not-entered' for item in result['experiments']))

    def test_tampered_recipe_context_seed_and_source_are_not_adopted(self):
        data = self.payload()
        experiment = plan(data)['experiments'][0]
        for mutate in [lambda x: x['context'].update(module='other'),
                       lambda x: x.update(seedHash='a' * 64),
                       lambda x: x['inputs']['args'][1]['attributes'].update(other={'kind': 'literal', 'value': {}})]:
            changed = copy.deepcopy(experiment)
            mutate(changed)
            self.assertEqual(worker({**data, 'experiment': changed})['status'], 'unavailable')
        self.source.write_bytes((SOURCE + '\n# changed\n').encode())
        self.assertEqual(worker({**data, 'experiment': experiment})['status'], 'unavailable')

    def test_external_effects_and_ambient_reads_cannot_become_observations(self):
        marker = self.root / 'application-executed'
        for addition in [f"    open({str(marker)!r}, 'w').write('bad')\n", '    import time\n    time.time()\n',
                         f"    try:\n        open({str(marker)!r}, 'w').write('bad')\n    except Exception:\n        pass\n"]:
            source = SOURCE.replace('    label = None\n', addition + '    label = None\n')
            self.source.write_bytes(source.encode())
            # Focus the target's data-read handler, not the deliberately injected
            # I/O suppression handler which contains no supported fixture read.
            line = [n.lineno for n in ast.walk(ast.parse(source)) if isinstance(n, ast.ExceptHandler)][-2]
            result = run(self.payload(source=source, line=line))
            self.assertEqual(result['status'], 'unavailable', result)
        self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
