"""End-to-end import fixtures with unchanged originals and fail-closed execution."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parent


class ImportFixtureTests(unittest.TestCase):
    def plan(self, root, rules):
        return {'schemaVersion': 'import-fixtures-v1', 'id': 'a' * 64, 'root': str(root), 'rules': [
            {**rule, 'sourceHash': hashlib.sha256((root / rule['file']).read_bytes()).hexdigest()}
            for rule in rules]}

    def run_tool(self, tool, root, plan=None, args=(), payload=None, extra_paths=()):
        env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1',
               'PYTHONPATH': os.pathsep.join([str(root), *map(str, extra_paths)])}
        env.pop('LLM_UNIT_TEST_IMPORT_FIXTURES', None)
        if plan:
            env['LLM_UNIT_TEST_IMPORT_FIXTURES'] = json.dumps(plan)
        return subprocess.run([sys.executable, '-B', str(TOOLS / tool), *map(str, args)],
            input=json.dumps(payload) if payload is not None else None, cwd=root, env=env,
            text=True, encoding='utf-8', capture_output=True, timeout=40)

    def test_all_phases_keep_original_and_share_the_import_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'neutral.py'
            file.write_text('from pathlib import Path\nPath("must_not_exist").mkdir()\ndef target(x):\n    return x + 1\n', encoding='utf-8')
            original = file.read_bytes()
            payload = {'file': str(file), 'module': 'neutral', 'importPaths': [str(root)]}
            strict = json.loads(self.run_tool('module_preflight.py', root, payload=payload).stdout)
            self.assertFalse(strict['ok'])
            plan = self.plan(root, [{'file': 'neutral.py', 'mkdir': True}])
            checked = self.run_tool('module_preflight.py', root, plan, payload=payload)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            loaded = json.loads(checked.stdout)
            self.assertTrue(loaded['ok'], loaded)
            self.assertEqual(loaded['importFixtures']['id'], plan['id'])
            self.assertEqual(loaded['importFixtures']['operations'][0]['operation'], 'pathlib.Path.mkdir')
            trace = self.run_tool('dynamic_tracer.py', root, plan, [file, 'target', '[[2]]'])
            self.assertEqual(trace.returncode, 0, trace.stderr)
            facts = json.loads(trace.stdout)
            self.assertTrue(any(item['result'] == '3' for item in facts['examples']), facts)
            test = root / 'test_neutral.py'
            test.write_text('import unittest\nfrom neutral import target\nclass Cases(unittest.TestCase):\n'
                            '    def test_value(self): self.assertEqual(target(2), 3)\n', encoding='utf-8')
            run = self.run_tool('generated_test_runner.py', root, plan, ['test_neutral', '--coverage-source', root])
            self.assertEqual(run.returncode, 0, run.stderr)
            mutation = self.run_tool('basic_mutation_runner.py', root, plan, [file, test, '0', '10', 'target'])
            self.assertEqual(mutation.returncode, 0, mutation.stderr)
            result = json.loads(mutation.stdout)
            self.assertTrue(result['baseline_passed'], result)
            self.assertTrue(result['scoreAvailable'], result)
            self.assertEqual(result['importFixtureId'], plan['id'])
            self.assertEqual(result['counts']['error'], 0, result)
            self.assertEqual(file.read_bytes(), original)
            self.assertFalse((root / 'must_not_exist').exists())

    def test_package_mutants_rebase_import_fixtures_for_copied_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / 'sample_pkg'
            package.mkdir()
            (package / '__init__.py').write_text('', encoding='utf-8')
            (package / 'settings.py').write_text('from pathlib import Path\nPath("no_directory").mkdir()\nVALUE = 2\n', encoding='utf-8')
            file = package / 'service.py'
            file.write_text('from .settings import VALUE\ndef target(x): return x + VALUE\n', encoding='utf-8')
            test = root / 'test_package.py'
            test.write_text('import unittest\nfrom sample_pkg.service import target\nclass Cases(unittest.TestCase):\n'
                            '    def test_value(self): self.assertEqual(target(2), 4)\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'sample_pkg/settings.py', 'mkdir': True}])
            run = self.run_tool('basic_mutation_runner.py', root, plan, [file, test, '2', '10', 'target'])
            self.assertEqual(run.returncode, 0, run.stderr)
            value = json.loads(run.stdout)
            self.assertTrue(value['baseline_passed'], value)
            self.assertTrue(value['scoreAvailable'], value)
            self.assertEqual(value['counts']['error'], 0, value)
            self.assertFalse((root / 'no_directory').exists())

    def test_function_and_retained_alias_are_not_mocked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'neutral.py'
            file.write_text('from pathlib import Path\nsaved = Path.mkdir\nPath("import_only").mkdir()\n'
                            'def target():\n    saved(Path("forbidden"))\n    return 7\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'mkdir': True}])
            run = self.run_tool('dynamic_tracer.py', root, plan, [file, 'target', '[[]]'])
            result = json.loads(run.stdout)
            self.assertEqual(result['cases'][0]['status'], 'blocked', result)
            self.assertEqual(result['examples'], [])
            self.assertFalse((root / 'forbidden').exists())

    def test_config_fixture_overrides_only_the_declared_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'neutral.py'
            file.write_text('from pathlib import Path\nfrom configparser import ConfigParser\n'
                            'config = ConfigParser()\nfile = Path(__file__).with_name("example.ini")\n'
                            'if file.exists(): config.read(file)\n'
                            'def target(): return config.get("test", "value")\n', encoding='utf-8')
            (root / 'example.ini').write_text('[test]\nvalue=real-data-must-not-be-used\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'configFiles': {'example.ini': '[test]\nvalue=controlled\n'}}])
            result = json.loads(self.run_tool('dynamic_tracer.py', root, plan, [file, 'target', '[[]]']).stdout)
            self.assertEqual(result['examples'][0]['result'], "'controlled'", result)
            self.assertEqual((root / 'example.ini').read_text(), '[test]\nvalue=real-data-must-not-be-used\n')
            file.write_text(file.read_text() + '\nopen(file).read()\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'configFiles': {'example.ini': '[test]\nvalue=controlled\n'}}])
            result = json.loads(self.run_tool('module_preflight.py', root, plan,
                payload={'file': str(file), 'module': 'neutral', 'importPaths': [str(root)]}).stdout)
            self.assertFalse(result['ok'])

    def test_external_startup_entry_does_not_run_and_cannot_replace_target(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'app'
            dependency = base / 'external'
            root.mkdir(); dependency.mkdir()
            (dependency / 'neutral_ui.py').write_text('def start(*args):\n    raise RuntimeError("real startup")\n', encoding='utf-8')
            file = root / 'neutral.py'
            file.write_text('import neutral_ui\nneutral_ui.start()\ndef target(): return 4\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'entryPoints': ['neutral_ui.start']}])
            loaded = json.loads(self.run_tool('module_preflight.py', root, plan, extra_paths=[dependency],
                payload={'file': str(file), 'module': 'neutral', 'importPaths': [str(root), str(dependency)]}).stdout)
            self.assertTrue(loaded['ok'], loaded)
            (root / 'local_entry.py').write_text('def start(): return 5\n', encoding='utf-8')
            file.write_text('import local_entry\nlocal_entry.start()\ndef target(): return 4\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'entryPoints': ['local_entry.start']}])
            loaded = json.loads(self.run_tool('module_preflight.py', root, plan, extra_paths=[dependency],
                payload={'file': str(file), 'module': 'neutral', 'importPaths': [str(root), str(dependency)]}).stdout)
            self.assertFalse(loaded['ok'])

    def test_unused_entry_fixture_never_imports_an_unneeded_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'neutral.py'
            file.write_text('def target(): return 4\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'entryPoints': ['neutral_missing_ui.start']}])
            loaded = json.loads(self.run_tool('module_preflight.py', root, plan,
                payload={'file': str(file), 'module': 'neutral', 'importPaths': [str(root)]}).stdout)
            self.assertTrue(loaded['ok'], loaded)

    def test_changed_source_rejects_stale_fixture_and_restores_strict_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'neutral.py'
            file.write_text('from pathlib import Path\nPath("never_create").mkdir()\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'mkdir': True}])
            file.write_text(file.read_text() + '\nvalue = 1\n', encoding='utf-8')
            result = json.loads(self.run_tool('module_preflight.py', root, plan,
                payload={'file': str(file), 'module': 'neutral', 'importPaths': [str(root)]}).stdout)
            self.assertFalse(result['ok'])
            self.assertFalse((root / 'never_create').exists())

    def test_installed_metadata_read_is_allowed_but_arbitrary_read_is_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'neutral.py'
            file.write_text('from importlib.metadata import version\nvalue = version("coverage")\n', encoding='utf-8')
            payload = {'file': str(file), 'module': 'neutral', 'importPaths': [str(root)]}
            loaded = json.loads(self.run_tool('module_preflight.py', root, payload=payload).stdout)
            self.assertTrue(loaded['ok'], loaded)
            file.write_text('from importlib.metadata import PathDistribution\nfrom pathlib import Path\n'
                            'data = PathDistribution(Path(__file__).parent).read_text("private.txt")\n', encoding='utf-8')
            (root / 'private.txt').write_text('not allowed', encoding='utf-8')
            self.assertFalse(json.loads(self.run_tool('module_preflight.py', root, payload=payload).stdout)['ok'])


if __name__ == '__main__':
    unittest.main()
