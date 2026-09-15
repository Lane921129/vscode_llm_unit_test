import json
import pathlib
import subprocess
import sys
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).parent
FIXTURE_ROOT = SCRIPTS_DIR.parent / 'test' / 'fixtures' / 'python'
MANIFEST_PATH = FIXTURE_ROOT / 'manifest.json'


class FixtureCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))

    def extract(self, fixture):
        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / 'ast_extractor.py'),
                str(FIXTURE_ROOT / fixture['source']),
                fixture['target'],
            ],
            check=True,
            capture_output=True,
            encoding='utf-8',
        )
        return json.loads(completed.stdout)

    def find_callers(self, fixture):
        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / 'ast_caller_finder.py'),
                fixture['target'],
                str(FIXTURE_ROOT),
                str(FIXTURE_ROOT / fixture['source']),
            ],
            check=True,
            capture_output=True,
            encoding='utf-8',
        )
        return json.loads(completed.stdout)

    def trace(self, fixture, inputs=None):
        args = [
            sys.executable,
            str(SCRIPTS_DIR / 'dynamic_tracer.py'),
            str(FIXTURE_ROOT / fixture['source']),
            fixture['target'],
        ]
        if inputs:
            args.append(json.dumps(inputs))
        completed = subprocess.run(args, check=True, capture_output=True, encoding='utf-8')
        return json.loads(completed.stdout)

    def test_manifest_has_three_fixtures_for_each_tier(self):
        self.assertEqual(self.manifest['schema_version'], 2)
        self.assertGreaterEqual(len(self.manifest['fixtures']), 12)
        for tier in range(1, 5):
            fixtures = [fixture for fixture in self.manifest['fixtures'] if fixture['tier'] == tier]
            self.assertGreaterEqual(len(fixtures), 3)

    def test_every_fixture_has_ast_context_and_acceptance_criteria(self):
        for fixture in self.manifest['fixtures']:
            with self.subTest(fixture=fixture['id']):
                source = FIXTURE_ROOT / fixture['source']
                self.assertTrue(source.is_file())
                data = self.extract(fixture)
                self.assertNotIn('error', data)
                self.assertEqual(data['method_kind'], fixture['expected']['method_kind'])
                self.assertEqual(data['is_async'], fixture['expected']['is_async'])
                if data['method_kind'] == 'property':
                    self.assertIsNotNone(data['property_context'])
                inherited_required = fixture['expected'].get('inherited_constructor_required')
                if inherited_required is not None:
                    self.assertEqual(
                        data['class_context'].get('effective_init', {}).get('required_params'),
                        inherited_required
                    )
                truthiness_parameters = fixture['expected'].get('truthiness_parameters')
                if truthiness_parameters is not None:
                    observed_truthiness = list(dict.fromkeys(
                        fact.get('parameter') for fact in data.get('condition_facts', [])
                        if fact.get('kind') == 'truthiness'
                    ))
                    self.assertEqual(observed_truthiness, truthiness_parameters)
                self.assertGreater(fixture['acceptance']['min_line_coverage'], 0)
                self.assertGreater(fixture['acceptance']['min_mutation_score'], 0)
                self.assertTrue(fixture['acceptance']['forbidden'])

                expected_context = fixture.get('context', {})
                expected_calls = set(expected_context.get('calls', []))
                self.assertTrue(expected_calls.issubset(set(data['calls'])))
                for expected_import in expected_context.get('file_imports', []):
                    self.assertTrue(any(
                        item.get('module') == expected_import.get('module')
                        and item.get('bound_name') == expected_import.get('bound_name')
                        for item in data['file_imports']
                    ))

    def test_tier_one_fixtures_produce_safe_dynamic_trace_facts(self):
        tier_one = [fixture for fixture in self.manifest['fixtures'] if fixture['tier'] == 1]
        for fixture in tier_one:
            with self.subTest(fixture=fixture['id']):
                callers = self.find_callers(fixture)
                literal_inputs = [
                    {
                        'args': caller['trace_args'],
                        'kwargs': caller['trace_kwargs'] or {},
                        'constructor_args': caller['trace_constructor_args'],
                        'constructor_kwargs': caller['trace_constructor_kwargs'] or {},
                    }
                    for caller in callers
                    if isinstance(caller.get('trace_args'), list)
                ]
                trace = self.trace(fixture, literal_inputs or None)
                self.assertIsNone(trace['load_error'])
                self.assertTrue(trace['examples'] or trace['errors'])
                self.assertTrue(all(item.get('call_assertable', True) for item in trace['examples'] + trace['errors']))
                expected_inputs = fixture['expected'].get('trace_inputs', [])
                if expected_inputs:
                    observed_inputs = {tuple(item.get('args', [])) for item in trace['examples']}
                    for expected_input in expected_inputs:
                        self.assertIn((expected_input,), observed_inputs)

    def test_tier_two_cross_module_fixtures_preserve_verified_caller_inputs(self):
        tier_two = [fixture for fixture in self.manifest['fixtures'] if fixture['tier'] == 2]
        for fixture in tier_two:
            expected_caller_inputs = fixture['expected'].get('caller_inputs', [])
            if not expected_caller_inputs:
                continue
            with self.subTest(fixture=fixture['id']):
                callers = self.find_callers(fixture)
                observed_caller_inputs = {
                    tuple(caller.get('trace_args', []))
                    for caller in callers
                    if isinstance(caller.get('trace_args'), list)
                }
                for expected_input in expected_caller_inputs:
                    self.assertIn((expected_input,), observed_caller_inputs)

                literal_inputs = [
                    {
                        'args': caller['trace_args'],
                        'kwargs': caller['trace_kwargs'] or {},
                        'constructor_args': caller['trace_constructor_args'],
                        'constructor_kwargs': caller['trace_constructor_kwargs'] or {},
                    }
                    for caller in callers
                    if isinstance(caller.get('trace_args'), list)
                ]
                trace = self.trace(fixture, literal_inputs)
                self.assertIsNone(trace['load_error'])
                observed_trace_inputs = {tuple(item.get('args', [])) for item in trace['examples']}
                for expected_input in fixture['expected'].get('trace_inputs', []):
                    self.assertIn((expected_input,), observed_trace_inputs)


if __name__ == '__main__':
    unittest.main()
