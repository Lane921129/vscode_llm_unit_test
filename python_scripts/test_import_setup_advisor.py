"""Neutral source fixtures for observed, source-bound initialization advice."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parent
VENDOR = 'from pathlib import Path\ndef launch(*args, **kwargs):\n    Path("must_not_exist").mkdir()\n'


class ImportSetupAdvisorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root, self.external = self.base / 'app', self.base / 'external'
        self.root.mkdir(); self.external.mkdir()
        self.file = self.root / 'sample.py'
        (self.external / 'neutral_driver.py').write_text(VENDOR, encoding='utf-8')

    def check(self, source, plan=None, **payload_fields):
        self.file.write_text(source, encoding='utf-8')
        env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1'}
        env.pop('LLM_UNIT_TEST_IMPORT_FIXTURES', None)
        if plan:
            env['LLM_UNIT_TEST_IMPORT_FIXTURES'] = json.dumps(plan)
        payload = {'file': str(self.file), 'module': 'sample', 'sourceRoot': str(self.root),
                   'importPaths': [str(self.root), str(self.external)], **payload_fields}
        result = subprocess.run([sys.executable, '-B', str(TOOLS / 'module_preflight.py')],
                                cwd=self.root, env=env, input=json.dumps(payload), text=True,
                                encoding='utf-8', capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'must_not_exist').exists())
        return json.loads(result.stdout)

    def candidate(self, result):
        return result.get('diagnostic', {}).get('initialization_candidate')

    def test_module_and_function_aliases_produce_source_bound_proposals_and_recheck(self):
        for setup, call in [('import neutral_driver as driver', 'driver.launch()'),
                            ('from neutral_driver import launch as start', 'start()')]:
            with self.subTest(call=call):
                source = setup + '\ndef target(): return 4\n' + call + '\n'
                result = self.check(source)
                self.assertFalse(result['ok'])
                candidate = self.candidate(result)
                self.assertIsNotNone(candidate, result)
                self.assertEqual(candidate['kind'], 'entry-point')
                self.assertEqual(candidate['operation'], 'neutral_driver.launch')
                self.assertEqual(candidate['file'], 'sample.py')
                self.assertEqual(candidate['line'], 3)
                self.assertEqual(candidate['sourceHash'], hashlib.sha256(self.file.read_bytes()).hexdigest())
                plan = {'schemaVersion': 'import-fixtures-v1', 'id': 'a' * 64, 'root': str(self.root),
                        'rules': [{'file': candidate['file'], 'sourceHash': candidate['sourceHash'],
                                   'entryPoints': [candidate['operation']],
                                   'entryPointLines': {candidate['operation']: [candidate['line']]},
                                   'entryPointSourceHash': candidate['sourceHash']}]}
                loaded = self.check(source, plan)
                self.assertTrue(loaded['ok'], loaded)
                self.assertEqual(loaded['importFixtures']['operations'][0]['operation'], 'neutral_driver.launch')
                self.assertEqual(self.file.read_text(encoding='utf-8'), source)

    def test_path_mkdir_is_verified_but_direct_os_mkdir_is_not_misidentified(self):
        source = 'from pathlib import Path\nPath("must_not_exist").mkdir()\ndef target(): return 4\n'
        result = self.check(source)
        self.assertEqual(self.candidate(result)['kind'], 'mkdir', result)
        self.assertNotIn('resourcePath', self.candidate(result), 'pre-created directories would violate exist_ok=False')
        allowed = self.check(source.replace('.mkdir()', '.mkdir(exist_ok=True)'))
        self.assertEqual(self.candidate(allowed)['resourcePath'], 'must_not_exist')
        result = self.check('import os\nos.mkdir("must_not_exist")\ndef target(): return 4\n')
        self.assertFalse(result['ok'])
        self.assertIsNone(self.candidate(result))

    def test_observed_sibling_directory_has_explicit_project_parent_scope(self):
        source = ('from pathlib import Path\nBASE_DIR = Path(__file__).resolve().parent\n'
                  'DATA_DIR = BASE_DIR.parent / "VMS_Data"\n'
                  'DATA_DIR.mkdir(parents=True, exist_ok=True)\ndef target(): return 4\n')
        result = self.check(source)
        self.assertFalse(result['ok'], result)
        candidate = self.candidate(result)
        self.assertEqual(candidate['resourcePath'], 'VMS_Data', result)
        self.assertEqual(candidate['resourceScope'], 'project-parent', result)
        self.assertFalse((self.base / 'VMS_Data').exists())
        self.assertEqual(self.file.read_text(encoding='utf-8'), source)

    def test_ancestor_escape_and_non_idempotent_mkdir_do_not_propose_sibling_mounts(self):
        for expression, option in [('Path(__file__).parent', 'exist_ok=True'),
                ('Path(__file__).parent.parent', 'exist_ok=True'),
                ('Path(__file__).parent.parent.parent / "too_far"', 'exist_ok=True'),
                ('Path("../VMS_Data")', 'exist_ok=True'),
                ('Path(__file__).parent.parent / "VMS_Data"', ''),
                ('Path(__file__).parent.parent / "bad.py"', 'exist_ok=True')]:
            with self.subTest(expression=expression, option=option):
                result = self.check('from pathlib import Path\n(' + expression + ').mkdir(' + option + ')\n')
                self.assertFalse(result['ok'], result)
                self.assertNotIn('resourcePath', self.candidate(result) or {}, result)

    def test_function_local_imports_and_bindings_do_not_hide_module_entry(self):
        for body in ['def target():\n    import math\n    driver = math\n    return driver.pi\n',
                     'async def target():\n    import math\n    return math.pi\n',
                     'target = lambda: (driver := None)\n']:
            with self.subTest(body=body):
                result = self.check('import neutral_driver as driver\n' + body + 'driver.launch()\n')
                self.assertIsNotNone(self.candidate(result), result)
                self.assertEqual(self.candidate(result)['operation'], 'neutral_driver.launch')
        # Defaults execute at definition time, unlike the deferred function body.
        (self.external / 'other_driver.py').write_text(VENDOR, encoding='utf-8')
        source = ('import neutral_driver as driver\nimport other_driver\n'
                  'def target(value=(driver := other_driver)): return value\ndriver.launch()\n')
        self.assertIsNone(self.candidate(self.check(source)))

    def test_repeated_multiline_calls_are_proposed_one_position_at_a_time(self):
        for setup, call in [('import neutral_driver as driver', 'driver.launch'),
                            ('from neutral_driver import launch as start', 'start')]:
            with self.subTest(call=call):
                source = setup + '\ndef target(): return 4\n' + call + '(\n    1,\n)\n' + call + '()\n'
                first = self.candidate(self.check(source))
                self.assertEqual(first['line'], 3)
                rule = {'file': first['file'], 'sourceHash': first['sourceHash'],
                        'entryPoints': [first['operation']], 'entryPointLines': {first['operation']: [3]},
                        'entryPointSourceHash': first['sourceHash']}
                plan = {'schemaVersion': 'import-fixtures-v1', 'id': 'a' * 64, 'root': str(self.root), 'rules': [rule]}
                result = self.check(source, plan)
                second = self.candidate(result)
                self.assertIsNotNone(second, result)
                self.assertEqual(second['line'], 6)
                rule['entryPointLines'][first['operation']].append(6)
                result = self.check(source, plan)
                self.assertTrue(result['ok'], result)
                self.assertEqual([event['line'] for event in result['importFixtures']['operations']], [3, 6])

    def test_second_mkdir_remains_advisable_with_existing_fixture_wrapper(self):
        (self.root / 'config.py').write_text('from pathlib import Path\nPath("must_not_exist").mkdir()\n', encoding='utf-8')
        source = 'import config\nfrom pathlib import Path\nPath("must_not_exist").mkdir()\ndef target(): return 4\n'
        plan = {'schemaVersion': 'import-fixtures-v1', 'id': 'a' * 64, 'root': str(self.root),
                'rules': [{'file': 'config.py', 'sourceHash': hashlib.sha256((self.root / 'config.py').read_bytes()).hexdigest(), 'mkdir': True}]}
        result = self.check(source, plan)
        self.assertEqual(self.candidate(result)['file'], 'sample.py', result)
        self.assertEqual(self.candidate(result)['kind'], 'mkdir')

    def test_assigned_return_local_helper_and_ambiguous_same_line_calls_have_no_proposal(self):
        for body in ['value = driver.launch()', 'def helper():\n    driver.launch()\nhelper()',
                     'driver.launch(); driver.launch()']:
            with self.subTest(body=body):
                result = self.check('import neutral_driver as driver\n' + body + '\ndef target(): return 4\n')
                self.assertFalse(result['ok'])
                self.assertIsNone(self.candidate(result), result)

    def test_missing_api_missing_dependency_and_arbitrary_exception_do_not_produce_advice(self):
        for source in ['import neutral_driver\nneutral_driver.absent()', 'import no_such_advisor_fixture_dependency',
                       'raise RuntimeError("not a policy violation")']:
            with self.subTest(source=source):
                result = self.check(source + '\ndef target(): return 4\n')
                self.assertFalse(result['ok'])
                self.assertIsNone(self.candidate(result), result)

    def test_application_callback_and_local_dependency_are_not_hidden(self):
        (self.external / 'neutral_driver.py').write_text('def launch(callback):\n    callback()\n', encoding='utf-8')
        source = 'import neutral_driver as driver\nfrom pathlib import Path\ndef callback():\n    Path("must_not_exist").mkdir()\ndriver.launch(callback)\ndef target(): return 4\n'
        result = self.check(source)
        self.assertIsNone(self.candidate(result), result)
        (self.root / 'local_driver.py').write_text(VENDOR, encoding='utf-8')
        result = self.check('import local_driver\nlocal_driver.launch()\ndef target(): return 4\n')
        self.assertIsNone(self.candidate(result), result)

    def test_rebound_alias_class_and_dynamic_getattr_are_not_candidates(self):
        (self.external / 'other_driver.py').write_text(VENDOR, encoding='utf-8')
        source = 'import neutral_driver as driver\nimport other_driver\ndriver = other_driver\ndriver.launch()\ndef target(): return 4\n'
        self.assertIsNone(self.candidate(self.check(source)))
        (self.external / 'neutral_driver.py').write_text('from pathlib import Path\nclass launch:\n    def __init__(self):\n        Path("must_not_exist").mkdir()\n', encoding='utf-8')
        self.assertIsNone(self.candidate(self.check('import neutral_driver\nneutral_driver.launch()\ndef target(): return 4\n')))
        (self.external / 'neutral_driver.py').write_text(VENDOR + '\ndef __getattr__(name):\n    return launch\n', encoding='utf-8')
        self.assertIsNone(self.candidate(self.check('import neutral_driver\nneutral_driver.dynamic()\ndef target(): return 4\n')))


if __name__ == '__main__':
    unittest.main()
