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

    def test_manifest_has_three_fixtures_for_each_tier(self):
        self.assertEqual(self.manifest['schema_version'], 1)
        self.assertEqual(len(self.manifest['fixtures']), 12)
        for tier in range(1, 5):
            fixtures = [fixture for fixture in self.manifest['fixtures'] if fixture['tier'] == tier]
            self.assertEqual(len(fixtures), 3)

    def test_every_fixture_has_ast_context_and_acceptance_criteria(self):
        for fixture in self.manifest['fixtures']:
            with self.subTest(fixture=fixture['id']):
                source = FIXTURE_ROOT / fixture['source']
                self.assertTrue(source.is_file())
                data = self.extract(fixture)
                self.assertNotIn('error', data)
                self.assertEqual(data['method_kind'], fixture['expected']['method_kind'])
                self.assertEqual(data['is_async'], fixture['expected']['is_async'])
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


if __name__ == '__main__':
    unittest.main()
