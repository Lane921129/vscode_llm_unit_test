"""End-to-end import fixtures with unchanged originals and fail-closed execution."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sqlite3
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent


class ImportFixtureTests(unittest.TestCase):
    def test_schema_dependency_approval_expires_in_workers_and_mutation_copies(self):
        from import_fixtures import ImportFixtures, mutation_environment
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'app'
            trial = Path(directory) / 'trial'
            root.mkdir(); trial.mkdir()
            file, config = root / 'neutral.py', root / 'settings.py'
            file.write_text('def target(value): return value + 1\n', encoding='utf-8')
            config.write_text('DB = "neutral.sqlite"\n', encoding='utf-8')
            dependency = {'file': 'settings.py', 'sourceHash': hashlib.sha256(config.read_bytes()).hexdigest()}
            plan = self.plan(root, [{'file': 'neutral.py', 'sourceDependencies': [dependency], 'pythonSourceMode': True}])
            environment = {'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(plan)}
            with patch.dict(os.environ, environment), ImportFixtures():
                pass
            with patch.dict(os.environ, environment), patch('sys.frozen', True, create=True):
                with self.assertRaisesRegex(ValueError, 'non-frozen'):
                    ImportFixtures()
            copied, copied_config = trial / 'neutral.py', trial / 'settings.py'
            copied.write_bytes(file.read_bytes()); copied_config.write_bytes(config.read_bytes())
            bindings = [(file, copied, False), (config, copied_config, False)]
            rebound = mutation_environment(environment, trial, file, bindings)
            rebound_plan = json.loads(rebound['LLM_UNIT_TEST_IMPORT_FIXTURES'])
            self.assertEqual(rebound_plan['rules'][-1]['sourceDependencies'][0]['resolvedFile'], str(copied_config.resolve()))
            with patch.dict(os.environ, rebound), ImportFixtures():
                pass
            copied_config.write_text('DB = "changed.sqlite"\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'dependency changed during copy'):
                mutation_environment(environment, trial, file, bindings)
            with patch.dict(os.environ, rebound):
                with self.assertRaisesRegex(ValueError, 'dependency changed'):
                    ImportFixtures()
            config.write_text('DB = "new.sqlite"\n', encoding='utf-8')
            with patch.dict(os.environ, environment):
                with self.assertRaisesRegex(ValueError, 'dependency changed'):
                    ImportFixtures()

    def test_line_bound_entry_preserves_later_calls_and_rebases_through_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, dependency = base / 'app', base / 'external'
            root.mkdir(); dependency.mkdir()
            (dependency / 'neutral_runtime.py').write_text(
                'from pathlib import Path\ndef launch(mode):\n'
                '    if mode == "start": Path("no_directory").mkdir()\n'
                '    return 7\n', encoding='utf-8')
            file = root / 'neutral.py'
            source = ('import neutral_runtime\n\n\nneutral_runtime.launch("start")\n'
                      'state = neutral_runtime.launch("read")\nassert state == 7\n\n\n'
                      'def target(value):\n    return value + 1\n')
            file.write_text(source, encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'entryPoints': ['neutral_runtime.launch'],
                                    'entryPointLines': {'neutral_runtime.launch': [4]},
                                    'entryPointSourceHash': hashlib.sha256(file.read_bytes()).hexdigest()}])
            payload = {'file': str(file), 'module': 'neutral', 'sourceRoot': str(root),
                       'importPaths': [str(root), str(dependency)]}
            checked = self.run_tool('module_preflight.py', root, plan, payload=payload, extra_paths=[dependency])
            loaded = json.loads(checked.stdout)
            self.assertTrue(loaded['ok'], loaded)
            self.assertEqual(loaded['importFixtures']['operations'], [
                {'file': 'neutral.py', 'operation': 'neutral_runtime.launch', 'line': 4}])
            trace = self.run_tool('dynamic_tracer.py', root, plan, [file, 'target', '[[2]]'], extra_paths=[dependency])
            facts = json.loads(trace.stdout)
            self.assertTrue(any(item['result'] == '3' for item in facts['examples']), facts)
            test = root / 'test_neutral.py'
            test.write_text('import unittest\nfrom neutral import target\nclass Cases(unittest.TestCase):\n'
                            '    def test_value(self): self.assertEqual(target(2), 3)\n', encoding='utf-8')
            run = self.run_tool('generated_test_runner.py', root, plan, ['test_neutral', '--coverage-source', root], extra_paths=[dependency])
            self.assertEqual(run.returncode, 0, run.stderr)
            mutation = self.run_tool('basic_mutation_runner.py', root, plan, [file, test, '0', '10', 'target'], extra_paths=[dependency])
            self.assertEqual(mutation.returncode, 0, mutation.stderr)
            result = json.loads(mutation.stdout)
            self.assertTrue(result['baseline_passed'], result)
            self.assertTrue(result['scoreAvailable'], result)
            self.assertGreater(result['counts']['killed'], 0, result)
            self.assertEqual(result['counts']['error'], 0, result)
            self.assertEqual(file.read_text(encoding='utf-8'), source)
            self.assertFalse((root / 'no_directory').exists())

    def test_line_bound_entry_does_not_hide_a_later_blocked_call(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, dependency = base / 'app', base / 'external'
            root.mkdir(); dependency.mkdir()
            (dependency / 'neutral_runtime.py').write_text(
                'from pathlib import Path\ndef launch():\n    Path("no_directory").mkdir()\n', encoding='utf-8')
            file = root / 'neutral.py'
            file.write_text('import neutral_runtime\nneutral_runtime.launch()\nresult = neutral_runtime.launch()\n', encoding='utf-8')
            plan = self.plan(root, [{'file': 'neutral.py', 'entryPoints': ['neutral_runtime.launch'],
                                    'entryPointLines': {'neutral_runtime.launch': [2]}}])
            payload = {'file': str(file), 'module': 'neutral', 'sourceRoot': str(root),
                       'importPaths': [str(root), str(dependency)]}
            loaded = json.loads(self.run_tool('module_preflight.py', root, plan, payload=payload, extra_paths=[dependency]).stdout)
            self.assertFalse(loaded['ok'])
            self.assertNotIn('initialization_candidate', loaded['diagnostic'])
            self.assertEqual(loaded['importFixtures']['operations'][0]['line'], 2)

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

    def test_static_entry_approval_requires_a_plain_external_python_function(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root, dependency = base / 'app', base / 'external'
            root.mkdir(); dependency.mkdir()
            (root / 'application_callbacks.py').write_text(
                'def local(callback):\n    raise RuntimeError("application function must not run")\n'
                'class Handler:\n'
                '    def __call__(self, callback):\n        raise RuntimeError("application callable must not run")\n'
                '    def start(self, callback):\n        raise RuntimeError("application method must not run")\n', encoding='utf-8')
            file = root / 'neutral.py'
            source = ('import neutral_runtime\ndef callback():\n    return 3\n'
                      'neutral_runtime.launch(callback)\ndef target(): return 4\n')
            file.write_text(source, encoding='utf-8')
            static = json.loads(self.run_tool('plan_import_initialization.py', root,
                payload={'root': str(root), 'files': [str(file)]}).stdout)
            self.assertTrue(static['complete'], static)
            self.assertEqual(len(static['candidates']), 1, static)
            candidate = static['candidates'][0]
            self.assertEqual(candidate['operation'], 'neutral_runtime.launch')
            self.assertEqual(candidate['evidence'], 'static-direct-module-call')
            plan = self.plan(root, [{'file': candidate['file'], 'entryPoints': [candidate['operation']],
                                    'entryPointLines': {candidate['operation']: [candidate['line']]},
                                    'entryPointSourceHash': candidate['sourceHash']}])
            cases = {
                'local-callable': 'from application_callbacks import Handler\nlaunch = Handler()\n',
                'local-partial': 'from functools import partial\nfrom application_callbacks import local\nlaunch = partial(local)\n',
                'local-bound-method': 'from application_callbacks import Handler\nlaunch = Handler().start\n',
                'bound-builtin': 'launch = [].append\n',
                'builtin-function': 'launch = len\n',
                'external-callable': 'class Handler:\n    def __call__(self, callback): pass\nlaunch = Handler()\n',
                'local-function': 'from application_callbacks import local as launch\n',
                'external-function': 'def launch(callback):\n    raise RuntimeError("external startup must not run")\n',
            }
            for name, backend in cases.items():
                with self.subTest(name=name):
                    (dependency / 'neutral_runtime.py').write_text(backend, encoding='utf-8')
                    loaded = json.loads(self.run_tool('module_preflight.py', root, plan, extra_paths=[dependency],
                        payload={'file': str(file), 'module': 'neutral', 'sourceRoot': str(root),
                                 'importPaths': [str(root), str(dependency)]}).stdout)
                    self.assertEqual(loaded['ok'], name == 'external-function', loaded)
                    if name != 'external-function':
                        self.assertIn('Startup fixture', loaded['diagnostic']['message'])
                        self.assertEqual(loaded.get('importFixtures', {}).get('operations', []), [])
                    else:
                        self.assertEqual(loaded['importFixtures']['operations'], [
                            {'file': 'neutral.py', 'operation': 'neutral_runtime.launch', 'line': 4}])
                    self.assertEqual(file.read_text(encoding='utf-8'), source)

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


class ResourcePipelineTests(unittest.TestCase):
    """The same source-bound seed reaches import, observation and mutation trials."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='resource-pipeline-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root, self.lease = self.base / 'app', self.base / 'lease'
        self.root.mkdir(); self.lease.mkdir()
        (self.lease / '.llm-unit-test-resource-lease.json').write_text(json.dumps({
            'schemaVersion': 'isolated-resource-lease-v1', 'ownerPid': os.getpid()}), encoding='utf-8')
        self.file = self.root / 'sample.py'
        self.file.write_text('import sqlite3\nfrom pathlib import Path\n'
            'BASE = Path(__file__).parent\nLABEL = (BASE / "data" / "label.txt").read_text()\n'
            'def reset():\n'
            '    with sqlite3.connect(BASE / "data" / "items.db") as connection:\n'
            '        connection.execute("UPDATE items SET value = 10 WHERE id = 1")\n'
            'def increment(amount):\n'
            '    with sqlite3.connect(BASE / "data" / "items.db") as connection:\n'
            '        value = connection.execute("SELECT value FROM items WHERE id = 1").fetchone()[0]\n'
            '        connection.execute("UPDATE items SET value = ? WHERE id = 1", (value + amount,))\n'
            '        return value + amount + len(LABEL)\n', encoding='utf-8')
        source_hash = hashlib.sha256(self.file.read_bytes()).hexdigest()
        self.plan = {'schemaVersion': 'import-fixtures-v1', 'id': 'b' * 64, 'root': str(self.root), 'rules': [{
            'file': 'sample.py', 'sourceHash': source_hash, 'resourceSourceHash': source_hash, 'resources': [
                {'path': 'data', 'kind': 'directory'},
                {'path': 'data/label.txt', 'kind': 'text', 'text': 'abc'},
                {'path': 'data/items.db', 'kind': 'sqlite', 'tables': [{'name': 'items', 'columns': [
                    {'name': 'id', 'type': 'INTEGER', 'primaryKey': True}, {'name': 'value', 'type': 'INTEGER'}
                ], 'rows': [{'id': 1, 'value': 10}]}]}
            ]}]}
        self.tests = self.root / 'test_candidate.py'
        self.tests.write_text('import unittest\nfrom sample import increment, reset\n'
            'class Cases(unittest.TestCase):\n'
            '    def setUp(self): reset()\n'
            '    def test_first(self): self.assertEqual(increment(1), 14)\n'
            '    def test_second(self): self.assertEqual(increment(1), 14)\n', encoding='utf-8')

    def run_tool(self, tool, args=(), payload=None):
        result = subprocess.run([sys.executable, '-B', str(TOOLS / tool), *map(str, args)],
            input=json.dumps(payload) if payload is not None else None, cwd=self.root,
            env={**os.environ, 'PYTHONPATH': str(self.root), 'PYTHONIOENCODING': 'utf-8',
                 'PYTHONDONTWRITEBYTECODE': '1', 'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(self.plan),
                 'LLM_UNIT_TEST_RESOURCE_LEASE': str(self.lease)},
            text=True, encoding='utf-8', capture_output=True, timeout=60)
        self.assertFalse((self.root / 'data').exists(), 'application resources must not be created in the original project')
        return result

    def test_seed_is_fresh_for_preflight_trace_suite_and_both_mutation_engines(self):
        original = self.file.read_bytes()
        loaded = json.loads(self.run_tool('module_preflight.py', payload={
            'file': str(self.file), 'module': 'sample', 'sourceRoot': str(self.root),
            'importPaths': [str(self.root)]}).stdout)
        self.assertTrue(loaded['ok'], loaded)
        self.assertEqual(loaded['importFixtures']['resources']['planId'], self.plan['id'])
        traced = self.run_tool('dynamic_tracer.py', [self.file, 'increment', '[[1],[2]]'])
        self.assertEqual(traced.returncode, 0, traced.stderr)
        observed = json.loads(traced.stdout)
        self.assertEqual([item['result'] for item in observed['examples']], ['14', '15'], observed)
        for item in observed['examples']:
            self.assertEqual(item['importFixtures']['resources']['planId'], self.plan['id'])
        report = self.root / 'runner-result.json'
        baseline = self.run_tool('generated_test_runner.py', [self.tests.stem, '--result-json', report])
        self.assertEqual(baseline.returncode, 0, baseline.stderr)
        result = json.loads(report.read_text(encoding='utf-8'))
        self.assertEqual(result['testsRun'], 2)
        self.assertEqual(result['importFixtures']['resources']['scope'], 'fresh-process')
        for tool, prefix in [('basic_mutation_runner.py', []), ('external_mutation_runner.py', ['mutatest'])]:
            with self.subTest(engine=tool):
                mutated = self.run_tool(tool, [*prefix, self.file, self.tests, 3, 10, 'increment'])
                self.assertEqual(mutated.returncode, 0, mutated.stderr)
                result = json.loads(mutated.stdout)
                self.assertTrue(result['baseline_passed'], result)
                self.assertGreater(result['counts']['killed'], 0, result)
                self.assertEqual(result['counts']['error'], 0, result)
                self.assertEqual(result['baselineImportFixtures']['resources']['planId'], self.plan['id'])
                for mutant in result['mutants']:
                    if mutant['status'] in ('KILLED', 'SURVIVED'):
                        self.assertEqual(mutant['importFixtures']['id'], self.plan['id'])
        self.assertEqual(self.file.read_bytes(), original)

    def test_generated_test_direct_resource_access_stays_blocked(self):
        for operation in ['(Path(__file__).parent / "data" / "label.txt").read_text()',
                          'sqlite3.connect(Path(__file__).parent / "data" / "items.db")']:
            with self.subTest(operation=operation):
                self.tests.write_text('import unittest\nimport sqlite3\nfrom pathlib import Path\n'
                    'from sample import increment\nclass Cases(unittest.TestCase):\n'
                    '    def test_value(self):\n        ' + operation + '\n'
                    '        self.assertEqual(increment(1), 14)\n', encoding='utf-8')
                report = self.root / 'runner-result.json'
                ran = self.run_tool('generated_test_runner.py', [self.tests.stem, '--result-json', report])
                self.assertEqual(ran.returncode, 86, ran.stderr)
                self.assertEqual(json.loads(report.read_text())['status'], 'isolation-blocked')

    def test_invalid_seed_is_infrastructure_failure_never_a_killed_mutant(self):
        self.plan['rules'][0]['resources'][2]['tables'][0]['rows'].append({'id': 1, 'value': 99})
        self.plan['id'] = 'c' * 64
        mutated = self.run_tool('basic_mutation_runner.py', [self.file, self.tests, 3, 10, 'increment'])
        self.assertEqual(mutated.returncode, 0, mutated.stderr)
        result = json.loads(mutated.stdout)
        self.assertFalse(result['baseline_passed'], result)
        self.assertEqual(result['baselineStatus'], 'error', result)
        self.assertEqual(result['counts']['killed'], 0)
        self.assertFalse(result['scoreAvailable'])

    def test_mutation_trial_rejects_missing_or_different_resource_plan_evidence(self):
        sys.path.insert(0, str(TOOLS))
        try:
            from basic_mutation_runner import read_trial_result
        finally:
            sys.path.remove(str(TOOLS))
        report = self.root / 'runner-result.json'
        detail = {'schemaVersion': 'generated-test-result-v1', 'status': 'passed', 'testsRun': 1, 'testFailures': []}
        report.write_text(json.dumps(detail), encoding='utf-8')
        self.assertIsNone(read_trial_result(report, self.plan['id']))
        detail['importFixtures'] = {'id': 'c' * 64}
        report.write_text(json.dumps(detail), encoding='utf-8')
        self.assertIsNone(read_trial_result(report, self.plan['id']))
        detail['importFixtures']['id'] = self.plan['id']
        report.write_text(json.dumps(detail), encoding='utf-8')
        self.assertIsNotNone(read_trial_result(report, self.plan['id']))

    def test_package_mutation_never_copies_declared_production_resources_and_uses_seed(self):
        sys.path.insert(0, str(TOOLS))
        try:
            from basic_mutation_runner import run_mutation_trials
        finally:
            sys.path.remove(str(TOOLS))
        import builtins
        import shutil
        package = self.root / 'demo'
        package.mkdir()
        (package / '__init__.py').write_text('', encoding='utf-8')
        source = self.file.read_bytes()
        self.file.unlink()
        self.file = package / 'sample.py'
        self.file.write_bytes(source)
        self.tests.write_text(self.tests.read_text(encoding='utf-8').replace('from sample import', 'from demo.sample import'), encoding='utf-8')
        rule = self.plan['rules'][0]
        rule['file'] = 'demo/sample.py'
        for resource in rule['resources']:
            resource['path'] = 'demo/' + resource['path']
        rule['resources'] += [
            {'path': 'demo/direct.ini', 'kind': 'text', 'text': '[test]'},
            {'path': 'demo/direct.db', 'kind': 'sqlite', 'tables': []}]
        data = package / 'data'
        data.mkdir()
        (data / 'nested').mkdir()
        originals = {data / 'items.db': b'original database bytes must never be copied',
                     data / 'label.txt': b'production text must never be copied',
                     data / 'nested' / 'extra.txt': b'undeclared child of declared directory',
                     package / 'direct.ini': b'production configuration',
                     package / 'direct.db': b'production standalone database'}
        for file, content in originals.items():
            file.write_bytes(content)
        for database in (data / 'items.db', package / 'direct.db'):
            database.unlink()
            with sqlite3.connect(database) as connection:
                connection.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, value INTEGER)')
                connection.execute('INSERT INTO items VALUES (1, 999)')
            connection.close()
            originals[database] = database.read_bytes()
        original_open, original_copytree = builtins.open, shutil.copytree
        blocked_paths = {os.path.normcase(os.path.abspath(file)) for file in originals}
        copied_trials = []

        def no_production_reads(file, *args, **kwargs):
            if isinstance(file, (str, bytes, os.PathLike)):
                self.assertNotIn(os.path.normcase(os.path.abspath(file)), blocked_paths,
                                 'package copy must not read a declared production resource')
            return original_open(file, *args, **kwargs)

        def checked_copytree(source_root, destination, *args, **kwargs):
            result = original_copytree(source_root, destination, *args, **kwargs)
            destination = Path(destination)
            self.assertFalse((destination / 'data').exists())
            self.assertFalse((destination / 'direct.ini').exists())
            self.assertFalse((destination / 'direct.db').exists())
            self.assertTrue((destination / 'sample.py').is_file())
            copied_trials.append(destination.name)
            return result

        with patch.dict(os.environ, {'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(self.plan),
                'LLM_UNIT_TEST_RESOURCE_LEASE': str(self.lease), 'PYTHONIOENCODING': 'utf-8'}), \
                patch('builtins.open', side_effect=no_production_reads), \
                patch('basic_mutation_runner.shutil.copytree', side_effect=checked_copytree):
            result = run_mutation_trials(self.file, self.tests, max_mutations=3, timeout_seconds=10,
                                         target_function='increment', workers=1)
        self.assertTrue(result['baseline_passed'], result)
        self.assertGreater(result['counts']['killed'], 0, result)
        self.assertEqual(result['counts']['error'], 0, result)
        self.assertGreaterEqual(len(copied_trials), 2, 'both baseline and mutant packages were inspected')
        self.assertEqual(self.file.read_bytes(), source)
        for file, content in originals.items():
            self.assertEqual(file.read_bytes(), content)

    def test_package_resource_ignore_does_not_resolve_declared_links_or_change_legacy_copy(self):
        sys.path.insert(0, str(TOOLS))
        try:
            from basic_mutation_runner import package_copy_ignore
        finally:
            sys.path.remove(str(TOOLS))
        directory = str(self.root)
        resource = os.path.normcase(os.path.abspath(self.root / 'data'))
        original_realpath = os.path.realpath

        def guarded_realpath(file, *args, **kwargs):
            lexical = os.path.normcase(os.path.abspath(file))
            self.assertNotEqual(lexical, resource, 'declared paths are omitted before following symlinks')
            return resource if lexical == os.path.normcase(os.path.abspath(self.root / 'data_alias')) else original_realpath(file, *args, **kwargs)

        with patch.dict(os.environ, {'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(self.plan)}):
            ignore, _ = package_copy_ignore()
            with patch('basic_mutation_runner.os.path.realpath', side_effect=guarded_realpath):
                self.assertEqual(ignore(directory, ['data', 'data_alias', 'sample.py', '__pycache__']),
                                 {'data', 'data_alias', '__pycache__'})
        with patch.dict(os.environ, {'LLM_UNIT_TEST_IMPORT_FIXTURES': ''}):
            ignore, _ = package_copy_ignore()
            self.assertEqual(ignore(directory, ['data', 'sample.py', '__pycache__', 'cached.pyc']),
                             {'__pycache__', 'cached.pyc'})

    def test_package_copy_rejects_resource_symlinks_and_junctions_before_resolving_or_copying(self):
        sys.path.insert(0, str(TOOLS))
        try:
            from basic_mutation_runner import package_copy_ignore
        finally:
            sys.path.remove(str(TOOLS))
        original_lstat = os.lstat
        resource = os.path.normcase(os.path.abspath(self.root / 'data'))
        for mode, attributes in [(stat.S_IFLNK, 0), (stat.S_IFDIR, 1024)]:
            with self.subTest(link='symlink' if mode == stat.S_IFLNK else 'junction'):
                def lstat_metadata(file, *args, **kwargs):
                    if os.path.normcase(os.path.abspath(file)) == resource:
                        return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
                    return original_lstat(file, *args, **kwargs)
                with patch.dict(os.environ, {'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(self.plan)}), \
                        patch('basic_mutation_runner.os.lstat', side_effect=lstat_metadata), \
                        patch('basic_mutation_runner.os.path.realpath', side_effect=AssertionError('must not follow resource link')), \
                        patch('basic_mutation_runner.shutil.copytree', side_effect=AssertionError('must not copy invalid plan')):
                    with self.assertRaisesRegex(ValueError, 'symlink or junction'):
                        package_copy_ignore()

    def test_quality_experiments_bind_the_full_seed_and_reject_replay_after_seed_change(self):
        source = self.file.read_text(encoding='utf-8') + (
            '\nclass Counter:\n    def __init__(self):\n'
            '        with sqlite3.connect(BASE / "data" / "items.db") as connection:\n'
            '            self.value = connection.execute("SELECT value FROM items WHERE id = 1").fetchone()[0]\n'
            '    def add(self, amount):\n        self.value += amount\n        return self.value\n')
        self.file.write_bytes(source.encode('utf-8'))
        source_hash = hashlib.sha256(self.file.read_bytes()).hexdigest()
        self.plan['rules'][0].update(sourceHash=source_hash, resourceSourceHash=source_hash)
        tests = ('import unittest\nfrom sample import Counter\nclass Cases(unittest.TestCase):\n'
                 '    def test_add(self):\n        subject = Counter()\n        self.assertEqual(subject.add(1), 11)\n')
        payload = {'sourcePath': str(self.file), 'source': source, 'target': 'Counter.add', 'module': 'sample', 'testCode': tests,
            'focus': {'id': 'resource-gap', 'kind': 'survivor', 'evidence': 'measured mutant', 'mutant': {
                'id': 'm1', 'kind': 'AugAssign', 'line': source.splitlines().index('        self.value += amount') + 1,
                'column': 8, 'position': 0, 'from': 'AugAssign_Add', 'to': 'AugAssign_Sub', 'status': 'SURVIVED'}}}
        planned = json.loads(self.run_tool('quality_experiment_runner.py', ['--plan'], payload).stdout)
        self.assertEqual(planned['status'], 'planned', planned)
        first = json.loads(self.run_tool('quality_experiment_runner.py', ['--run'], payload).stdout)
        self.assertEqual(first['status'], 'observed', first)
        self.plan['rules'][0]['resources'][2]['tables'][0]['rows'][0]['value'] = 20
        self.plan['id'] = 'd' * 64
        replay = json.loads(self.run_tool('quality_experiment_runner.py', ['--worker'], {
            'sourcePath': str(self.file), 'experiment': planned['experiments'][0]}).stdout)
        self.assertEqual(replay['status'], 'unavailable', replay)
        second = json.loads(self.run_tool('quality_experiment_runner.py', ['--run'], payload).stdout)
        self.assertEqual(second['status'], 'observed', second)
        self.assertNotEqual(first['context']['importFixturePlanHash'], second['context']['importFixturePlanHash'])
        self.assertNotEqual(first['experiments'][0]['fingerprint'], second['experiments'][0]['fingerprint'])
        self.assertNotEqual(first['experiments'][0]['evidence']['initialState'], second['experiments'][0]['evidence']['initialState'])
        self.assertEqual(self.file.read_text(encoding='utf-8'), source)


if __name__ == '__main__':
    unittest.main()
