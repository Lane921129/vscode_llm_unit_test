"""Real children exercise the same resource policy used by every execution phase."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from types import SimpleNamespace
import stat

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))


class IsolatedResourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'project'
        self.root.mkdir()
        self.output = self.base / 'output'
        self.output.mkdir()
        self.lease = self.base / 'lease'
        self.lease.mkdir()
        (self.lease / '.llm-unit-test-resource-lease.json').write_text(json.dumps({
            'schemaVersion': 'isolated-resource-lease-v1', 'ownerPid': os.getpid()}))

    def plan(self, source, resources, *, filename='app.py', extra=None):
        file = self.root / filename
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(source, encoding='utf-8')
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        rule = {'file': filename, 'sourceHash': digest, 'resourceSourceHash': digest, 'resources': resources, **(extra or {})}
        self.resources = resources
        self.file = file
        self.source = source
        return {'schemaVersion': 'import-fixtures-v1', 'id': 'a' * 64, 'root': str(self.root), 'rules': [rule]}

    def run_tool(self, tool, plan, args=(), payload=None, timeout=40):
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(TOOLS), str(self.root)]),
               'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1',
               'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(plan), 'LLM_UNIT_TEST_RESOURCE_LEASE': str(self.lease)}
        return subprocess.run([sys.executable, '-B', str(TOOLS / tool), *map(str, args)],
            input=json.dumps(payload) if payload is not None else None, cwd=self.output, env=env,
            capture_output=True, text=True, encoding='utf-8', timeout=timeout)

    def preflight(self, plan):
        run = self.run_tool('module_preflight.py', plan, payload={'file': str(self.file),
            'module': self.file.stem, 'sourceRoot': str(self.root), 'importPaths': [str(self.file.parent), str(self.root)]})
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def script(self, plan, script):
        file = self.base / 'check.py'
        file.write_text(script, encoding='utf-8')
        return self.run_tool(str(file), plan)

    def test_source_relative_directory_text_and_sqlite_real_io_preserve_originals(self):
        original = self.root / 'data'
        original.mkdir()
        (original / 'settings.ini').write_text('real-private-value')
        (original / 'app.db').write_bytes(b'NOT A DATABASE; never copy it')
        source = '''from pathlib import Path
import sqlite3
DATA = Path(__file__).parent / 'data'
DATA.mkdir(parents=True, exist_ok=True)
assert DATA.exists() and DATA.is_dir()
assert (DATA / 'settings.ini').is_file()
assert (DATA / 'settings.ini').read_text() == 'test-value'
(DATA / 'result.txt').write_text('isolated')
with (DATA / 'result.txt').open() as stream: assert stream.read() == 'isolated'
with sqlite3.connect(DATA / 'app.db') as connection:
    assert connection.execute('SELECT value FROM sample').fetchone() == ('seed',)
def target(): return (DATA / 'result.txt').read_text()
'''
        plan = self.plan(source, [{'path': 'data', 'kind': 'directory'},
            {'path': 'data/settings.ini', 'kind': 'text', 'text': 'test-value'},
            {'path': 'data/app.db', 'kind': 'sqlite', 'tables': [{'name': 'sample',
                'columns': [{'name': 'value', 'type': 'TEXT'}], 'rows': [{'value': 'seed'}]}]}])
        value = self.preflight(plan)
        self.assertTrue(value['ok'], value)
        self.assertEqual(value['importFixtures']['resources']['resourceCount'], 3)
        self.assertGreater(value['importFixtures']['resources']['operations']['sqlite3.connect'], 0)
        self.assertEqual(self.file.read_text(), source)
        self.assertEqual((original / 'settings.ini').read_text(), 'real-private-value')
        self.assertEqual((original / 'app.db').read_bytes(), b'NOT A DATABASE; never copy it')
        self.assertFalse((original / 'result.txt').exists())
        self.assertEqual(list(self.lease.iterdir()), [self.lease / '.llm-unit-test-resource-lease.json'])

    def test_project_parent_resource_has_separate_namespace_and_preserves_both_originals(self):
        for directory in (self.root / 'VMS_Data', self.base / 'VMS_Data'):
            directory.mkdir()
            (directory / 'settings.txt').write_text('ORIGINAL:' + directory.parent.name)
        originals = {file: file.read_bytes() for directory in (self.root / 'VMS_Data', self.base / 'VMS_Data')
                     for file in directory.iterdir()}
        source = ('from pathlib import Path\nBASE_DIR=Path(__file__).resolve().parent\n'
            'DATA_DIR=BASE_DIR.parent/"VMS_Data"\nDATA_DIR.mkdir(parents=True, exist_ok=True)\n'
            'assert (DATA_DIR/"settings.txt").read_text() == "external-seed"\n'
            'assert (BASE_DIR/"VMS_Data"/"settings.txt").read_text() == "internal-seed"\n'
            '(DATA_DIR/"created.txt").write_text("outside-project-but-owned")\n'
            '(BASE_DIR/"VMS_Data"/"created.txt").write_text("inside-project-but-owned")\n'
            'def target(): return (DATA_DIR/"created.txt").read_text()\n')
        plan = self.plan(source, [{'path': 'VMS_Data', 'kind': 'directory'},
            {'path': 'VMS_Data/settings.txt', 'kind': 'text', 'text': 'internal-seed'},
            {'path': 'VMS_Data', 'scope': 'project-parent', 'kind': 'directory'},
            {'path': 'VMS_Data/settings.txt', 'scope': 'project-parent', 'kind': 'text', 'text': 'external-seed'}])
        strict = {**plan, 'rules': []}
        self.assertFalse(self.preflight(strict)['ok'])
        value = self.preflight(plan)
        self.assertTrue(value['ok'], value)
        self.assertEqual(value['importFixtures']['resources']['resourceCount'], 4)
        self.assertEqual(self.file.read_text(), source)
        for file, content in originals.items():
            self.assertEqual(file.read_bytes(), content)
            self.assertFalse(file.with_name('created.txt').exists())

    @unittest.skipUnless(os.path.normcase('A') == 'a', 'resource paths are case-sensitive on this platform')
    def test_windows_case_aliases_share_one_seed_but_different_seed_stays_rejected(self):
        from isolated_resources import IsolatedResources, logical_resource_path
        for scope in (None, 'project-parent'):
            with self.subTest(scope=scope):
                specs = [{'path': 'Shared_Data', 'kind': 'directory'},
                         {'path': 'Shared_Data/Label.txt', 'kind': 'text', 'text': 'SeedValue'}]
                if scope:
                    specs = [{**spec, 'scope': scope} for spec in specs]
                plan = self.plan('def target(): return 1\n', specs)
                helper = self.root / 'helper.py'
                helper.write_text('def helper(): return 2\n')
                helper_hash = hashlib.sha256(helper.read_bytes()).hexdigest()
                plan['rules'].append({'file': 'helper.py', 'sourceHash': helper_hash,
                    'resourceSourceHash': helper_hash,
                    'resources': [{**spec, 'path': spec['path'].lower()} for spec in specs]})
                with patch.dict(os.environ, {'LLM_UNIT_TEST_RESOURCE_LEASE': str(self.lease)}):
                    resources = IsolatedResources(plan)
                    try:
                        self.assertEqual(resources.evidence()['resourceCount'], 2)
                        first = resources._physical(logical_resource_path(self.root, specs[1]))
                        second = resources._physical(logical_resource_path(self.root, plan['rules'][1]['resources'][1]))
                        self.assertEqual(first, second)
                        self.assertEqual(Path(first).read_text(), 'SeedValue')
                        conflicting = json.loads(json.dumps(plan))
                        conflicting['rules'][1]['resources'][1]['text'] = 'seedvalue'
                        with self.assertRaisesRegex(ValueError, 'Conflicting isolated resource'):
                            IsolatedResources(conflicting)
                    finally:
                        resources.cleanup()

    def test_project_parent_scope_rejects_root_descendants_ancestors_and_other_scopes(self):
        from isolated_resources import logical_resource_path, validate_resources
        for spec in [{'path': self.root.name, 'kind': 'directory', 'scope': 'project-parent'},
                     {'path': self.root.name + '/data', 'kind': 'directory', 'scope': 'project-parent'},
                     {'path': '.', 'kind': 'directory', 'scope': 'project-parent'},
                     {'path': '../external', 'kind': 'directory', 'scope': 'project-parent'},
                     {'path': str(self.base / 'VMS_Data'), 'kind': 'directory', 'scope': 'project-parent'},
                     {'path': 'VMS_Data', 'kind': 'directory', 'scope': 'arbitrary-host'},
                     {'path': 'VMS_Data', 'kind': 'directory', 'scope': None},
                     {'path': 'run.py', 'kind': 'text', 'text': 'pass', 'scope': 'project-parent'}]:
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                validate_resources({'resources': [spec], 'sourceHash': 'a' * 64, 'resourceSourceHash': 'a' * 64})
                logical_resource_path(self.root, spec)

    def test_project_parent_scope_rejects_symlinks_and_junctions_before_reading_content(self):
        from isolated_resources import absolute, logical_resource_path
        original_lstat = os.lstat
        resource = absolute(self.base / 'VMS_Data')
        for mode, attributes in [(stat.S_IFLNK, 0), (stat.S_IFDIR, 1024)]:
            def fake_lstat(path, *args, **kwargs):
                if absolute(path) == resource:
                    return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
                return original_lstat(path, *args, **kwargs)
            with self.subTest(attributes=attributes), patch('isolated_resources._ORIGINAL_LSTAT', side_effect=fake_lstat):
                with self.assertRaisesRegex(ValueError, 'symlink or junction'):
                    logical_resource_path(self.root, {'path': 'VMS_Data', 'scope': 'project-parent', 'kind': 'directory'})

    def test_project_parent_seed_replays_through_trace_runner_and_both_mutation_engines(self):
        data = self.base / 'VMS_Data'
        data.mkdir()
        originals = {data / 'items.db': b'original database must not be opened', data / 'label.txt': b'original secret label'}
        for file, content in originals.items():
            file.write_bytes(content)
        source = ('from pathlib import Path\nimport sqlite3\n'
            'BASE_DIR=Path(__file__).resolve().parent\nDATA_DIR=BASE_DIR.parent/"VMS_Data"\n'
            'DATA_DIR.mkdir(parents=True, exist_ok=True)\n'
            'LABEL=(DATA_DIR/"label.txt").read_text()\n'
            'def target(amount):\n    with sqlite3.connect(DATA_DIR/"items.db") as connection:\n'
            '        value=connection.execute("SELECT value FROM items WHERE id=1").fetchone()[0]\n'
            '        connection.execute("UPDATE items SET value=? WHERE id=1", (value+amount,))\n'
            '        return value+amount+len(LABEL)\n')
        plan = self.plan(source, [{'path': 'VMS_Data', 'scope': 'project-parent', 'kind': 'directory'},
            {'path': 'VMS_Data/label.txt', 'scope': 'project-parent', 'kind': 'text', 'text': 'abc'},
            {'path': 'VMS_Data/items.db', 'scope': 'project-parent', 'kind': 'sqlite', 'tables': [{'name': 'items',
                'columns': [{'name': 'id', 'type': 'INTEGER', 'primaryKey': True}, {'name': 'value', 'type': 'INTEGER'}],
                'rows': [{'id': 1, 'value': 10}]}]}])
        loaded = self.preflight(plan)
        self.assertTrue(loaded['ok'], loaded)
        traced = self.run_tool('dynamic_tracer.py', plan, [self.file, 'target', '[[1],[2]]'])
        self.assertEqual(traced.returncode, 0, traced.stderr)
        observed = json.loads(traced.stdout)
        self.assertEqual([item['result'] for item in observed['examples']], ['14', '15'], observed)
        test = self.output / 'test_parent.py'
        test.write_text('import unittest\nfrom app import target\nclass Cases(unittest.TestCase):\n'
                        '    def test_value(self): self.assertEqual(target(1), 14)\n')
        suite = self.run_tool('generated_test_runner.py', plan, [test.stem])
        self.assertEqual(suite.returncode, 0, suite.stderr)
        for tool, prefix in [('basic_mutation_runner.py', []), ('external_mutation_runner.py', ['mutatest'])]:
            with self.subTest(engine=tool):
                if prefix:
                    from external_mutation_runner import probe_engine
                    if not probe_engine('mutatest')['supported']:
                        self.skipTest('verified mutatest 3.1.0 AST API is not installed')
                mutated = self.run_tool(tool, plan, [*prefix, self.file, test, 3, 10, 'target'])
                self.assertEqual(mutated.returncode, 0, mutated.stderr)
                value = json.loads(mutated.stdout)
                self.assertTrue(value['baseline_passed'], value)
                self.assertGreater(value['counts']['killed'], 0, value)
                self.assertEqual(value['counts']['error'], 0, value)
                self.assertEqual(value['engine'], 'mutatest' if prefix else 'builtin')
                self.assertEqual(value['baselineImportFixtures']['resources']['planId'], plan['id'])
        for file, content in originals.items():
            self.assertEqual(file.read_bytes(), content)
        self.assertEqual(self.file.read_text(), source)

    def test_project_parent_copy_filter_omits_sibling_data_before_open_or_resolve(self):
        from basic_mutation_runner import package_copy_ignore
        from isolated_resources import absolute
        plan = self.plan('def target(): return 1\n', [{'path': 'VMS_Data', 'scope': 'project-parent', 'kind': 'directory'}])
        resource = absolute(self.base / 'VMS_Data')
        original_realpath = os.path.realpath
        def guarded_realpath(path, *args, **kwargs):
            self.assertNotEqual(absolute(path), resource, 'never resolve or read an excluded resource')
            return resource if absolute(path) == absolute(self.base / 'data_alias') else original_realpath(path, *args, **kwargs)
        with patch.dict(os.environ, {'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(plan)}):
            ignore, declared = package_copy_ignore()
            self.assertTrue(declared(self.base / 'VMS_Data' / 'private.db'))
            self.assertFalse(declared(self.root / 'VMS_Data' / 'private.db'))
            with patch('basic_mutation_runner.os.path.realpath', side_effect=guarded_realpath):
                self.assertEqual(ignore(str(self.base), ['VMS_Data', 'data_alias', self.root.name]), {'VMS_Data', 'data_alias'})

    def test_package_mutation_omits_parent_scope_data_when_copy_root_is_project_ancestor(self):
        import builtins
        import shutil
        from basic_mutation_runner import run_mutation_trials
        container = self.base / 'container'
        container.mkdir()
        self.root = container / 'project'
        self.root.mkdir()
        for package in (container, self.root):
            (package / '__init__.py').write_text('')
        data = container / 'VMS_Data'
        data.mkdir()
        original = data / 'label.txt'
        original.write_text('ORIGINAL-CONTENT-MUST-NOT-BE-COPIED')
        plan = self.plan('from pathlib import Path\nDATA=Path(__file__).resolve().parent.parent/"VMS_Data"\n'
            'DATA.mkdir(exist_ok=True)\nLABEL=(DATA/"label.txt").read_text()\n'
            'def target(value): return value+len(LABEL)\n',
            [{'path': 'VMS_Data', 'scope': 'project-parent', 'kind': 'directory'},
             {'path': 'VMS_Data/label.txt', 'scope': 'project-parent', 'kind': 'text', 'text': 'abc'}])
        test = self.output / 'test_package.py'
        test.write_text('import unittest\nfrom container.project.app import target\n'
                       'class Cases(unittest.TestCase):\n    def test_value(self): self.assertEqual(target(4), 7)\n')
        original_open, original_copytree = builtins.open, shutil.copytree
        copied = []
        def guarded_open(file, *args, **kwargs):
            if isinstance(file, (str, bytes, os.PathLike)):
                self.assertNotEqual(os.path.normcase(os.path.abspath(file)), os.path.normcase(str(original)))
            return original_open(file, *args, **kwargs)
        def checked_copytree(source, destination, *args, **kwargs):
            result = original_copytree(source, destination, *args, **kwargs)
            if Path(source) == container:
                self.assertFalse((Path(destination) / 'VMS_Data').exists())
                self.assertTrue((Path(destination) / 'project' / 'app.py').is_file())
                copied.append(str(destination))
            return result
        with patch.dict(os.environ, {'LLM_UNIT_TEST_IMPORT_FIXTURES': json.dumps(plan),
                'LLM_UNIT_TEST_RESOURCE_LEASE': str(self.lease), 'PYTHONIOENCODING': 'utf-8'}), \
                patch('builtins.open', side_effect=guarded_open), \
                patch('basic_mutation_runner.shutil.copytree', side_effect=checked_copytree):
            value = run_mutation_trials(self.file, test, max_mutations=3, timeout_seconds=10,
                                        target_function='target', workers=1)
        self.assertTrue(value['baseline_passed'], value)
        self.assertGreater(value['counts']['killed'], 0, value)
        self.assertEqual(value['counts']['error'], 0, value)
        self.assertGreaterEqual(len(copied), 2)
        self.assertEqual(original.read_text(), 'ORIGINAL-CONTENT-MUST-NOT-BE-COPIED')
        self.assertEqual(self.file.read_text(), self.source)

    def test_relative_paths_bind_to_project_not_output_and_existing_mkdir_mock_cannot_swallow(self):
        plan = self.plan('from pathlib import Path\nPath("data").mkdir(exist_ok=True)\n'
            'Path("data/value.txt").write_text("fresh")\nassert Path("data/value.txt").read_text() == "fresh"\n'
            'def target(): return 1\n', [{'path': 'data', 'kind': 'directory'}], extra={'mkdir': True})
        value = self.preflight(plan)
        self.assertTrue(value['ok'], value)
        self.assertFalse((self.output / 'data').exists())
        self.assertFalse((self.root / 'data').exists())
        self.assertFalse(any(item['operation'] == 'pathlib.Path.mkdir' for item in value['importFixtures']['operations']))

    def test_worker_reuses_resources_across_import_and_execution_guards(self):
        plan = self.plan('from pathlib import Path\nimport sqlite3\nDATA = Path(__file__).parent / "data"\n'
            'DATA.mkdir(exist_ok=True)\nDB = DATA / "app.db"\n'
            'with sqlite3.connect(DB) as connection:\n    connection.execute("CREATE TABLE values_table(value INTEGER)")\n'
            'def target(value):\n    with sqlite3.connect(DB) as connection:\n'
            '        connection.execute("INSERT INTO values_table VALUES (?)", (value,))\n'
            '        return connection.execute("SELECT COUNT(*) FROM values_table").fetchone()[0]\n',
            [{'path': 'data', 'kind': 'directory'}])
        result = self.script(plan, 'from runtime_policy import guarded_runtime\n'
            'with guarded_runtime(): import app\nwith guarded_runtime(): assert app.target(2) == 1\n'
            'with guarded_runtime(): assert app.target(3) == 2\nprint("OK")\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('OK', result.stdout)
        self.assertFalse((self.root / 'data').exists())

    def test_parallel_children_never_share_database_state(self):
        plan = self.plan('import sqlite3\ndef target():\n    with sqlite3.connect("app.db") as connection:\n'
            '        connection.execute("INSERT INTO values_table VALUES (1)")\n'
            '        return connection.execute("SELECT COUNT(*) FROM values_table").fetchone()[0]\n',
            [{'path': 'app.db', 'kind': 'sqlite', 'tables': [{'name': 'values_table',
                'columns': [{'name': 'value', 'type': 'INTEGER'}]}]}])
        file = self.base / 'parallel.py'
        file.write_text('from runtime_policy import guarded_runtime\n'
            'with guarded_runtime():\n    import app\n    assert app.target() == 1\nprint("OK")\n')
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.run_tool(str(file), plan), range(2)))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('OK', result.stdout)
        self.assertEqual(list(self.lease.iterdir()), [self.lease / '.llm-unit-test-resource-lease.json'])

    def test_declared_text_wins_over_legacy_config_mock(self):
        plan = self.plan('from pathlib import Path\nfrom configparser import ConfigParser\n'
            'file=Path(__file__).with_name("config.ini")\nconfig=ConfigParser()\n'
            'assert file.exists()\nconfig.read(file)\nassert config.get("test", "value") == "resource"\n',
            [{'path': 'config.ini', 'kind': 'text', 'text': '[test]\nvalue=resource\n'}],
            extra={'configFiles': {'config.ini': '[test]\nvalue=old-mock\n'}})
        value = self.preflight(plan)
        self.assertTrue(value['ok'], value)
        self.assertFalse(any('config' in item['operation'] for item in value['importFixtures']['operations']))

    def test_unknown_schema_is_never_invented_or_copied_from_real_database(self):
        import sqlite3
        connection = sqlite3.connect(self.root / 'app.db')
        connection.execute('CREATE TABLE actual(value TEXT)')
        connection.execute('INSERT INTO actual VALUES ("private-source-row")')
        connection.commit(); connection.close()
        original = (self.root / 'app.db').read_bytes()
        plan = self.plan('import sqlite3\nwith sqlite3.connect("app.db") as connection:\n'
            '    connection.execute("SELECT value FROM actual")\n', [{'path': 'app.db', 'kind': 'sqlite'}])
        value = self.preflight(plan)
        self.assertFalse(value['ok'], value)
        self.assertIn('resource-schema-required', value['reason'])
        self.assertEqual((self.root / 'app.db').read_bytes(), original)
        self.assertNotIn('private-source-row', json.dumps(value))

    def test_trace_cases_get_fresh_databases_and_preserve_import_initialization(self):
        plan = self.plan('from pathlib import Path\nimport sqlite3\nDB = Path(__file__).parent / "app.db"\n'
            'with sqlite3.connect(DB) as connection: connection.execute("CREATE TABLE values_table(value INTEGER)")\n'
            'def target(value):\n    with sqlite3.connect(DB) as connection:\n'
            '        connection.execute("INSERT INTO values_table VALUES (?)", (value,))\n'
            '        return connection.execute("SELECT COUNT(*) FROM values_table").fetchone()[0]\n',
            [{'path': 'app.db', 'kind': 'sqlite'}])
        result = self.run_tool('dynamic_tracer.py', plan, [self.file, 'target', '[[2],[3]]'])
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual([item['result'] for item in value['examples']], ['1', '1'], value)
        self.assertFalse((self.root / 'app.db').exists())

    def test_mutation_rebases_package_resources_and_uses_real_runner(self):
        package = self.root / 'sample'
        package.mkdir()
        (package / '__init__.py').write_text('')
        plan = self.plan('from pathlib import Path\nimport sqlite3\nDATA=Path(__file__).parent/"data"\n'
            'DATA.mkdir(exist_ok=True)\nDB=DATA/"app.db"\n'
            'with sqlite3.connect(DB) as connection: connection.execute("CREATE TABLE values_table(value INTEGER)")\n'
            'def target(value):\n    with sqlite3.connect(DB) as connection:\n'
            '        connection.execute("INSERT INTO values_table VALUES (?)", (value,))\n'
            '        return connection.execute("SELECT COUNT(*) FROM values_table").fetchone()[0] + value\n',
            [{'path': 'sample/data', 'kind': 'directory'}], filename='sample/app.py')
        test = self.output / 'test_app.py'
        test.write_text('import unittest\nfrom sample.app import target\nclass Cases(unittest.TestCase):\n'
            '    def test_value(self): self.assertEqual(target(4), 5)\n')
        result = self.run_tool('basic_mutation_runner.py', plan, [self.file, test, '2', '15', 'target'])
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertTrue(value['baseline_passed'], value)
        self.assertTrue(value['scoreAvailable'], value)
        self.assertGreater(value['counts']['killed'], 0, value)
        self.assertEqual(value['counts']['error'], 0, value)
        self.assertEqual(self.file.read_text(), self.source)
        self.assertFalse((package / 'data').exists())

    def test_unconfigured_reads_and_writes_remain_blocked(self):
        for expression in ('Path("other.txt").write_text("bad")', 'Path("other.txt").read_text()',
                           'Path("other").mkdir()', 'sqlite3.connect("other.db")',
                           'Path("data/../../escape.txt").write_text("bad")'):
            with self.subTest(expression=expression):
                plan = self.plan('from pathlib import Path\nimport sqlite3\n' + expression + '\n',
                    [{'path': 'data', 'kind': 'directory'}])
                result = self.preflight(plan)
                self.assertFalse(result['ok'], result)
                self.assertEqual(result['stage'], 'module-import', result)
                self.assertFalse((self.output / 'other.txt').exists())
                self.assertFalse((self.base / 'escape.txt').exists())

    def test_dynamic_mount_paths_reject_devices_streams_and_executable_files(self):
        for filename in ('CON', 'NUL.txt', 'COM1', 'value.txt:stream', 'value.py', 'bad.', 'bad '):
            with self.subTest(filename=filename):
                plan = self.plan('from pathlib import Path\nPath(' + repr('data/' + filename)
                    + ').write_text("blocked")\n', [{'path': 'data', 'kind': 'directory'}])
                value = self.preflight(plan)
                self.assertFalse(value['ok'], value)
                self.assertIn('unsupported filename', value['reason'])

    def test_sqlite_uri_attach_vacuum_extension_and_directory_escape_remain_blocked(self):
        operations = ['sqlite3.connect("file:app.db?cache=shared", uri=True)',
            'connection.execute("ATTACH DATABASE \'outside.db\' AS outside")',
            'connection.execute("VACUUM INTO \'outside.db\'")',
            'connection.enable_load_extension(True)',
            'connection.set_authorizer(lambda *args: sqlite3.SQLITE_OK)',
            'connection.execute("PRAGMA temp_store_directory=\'/tmp\'")']
        for operation in operations:
            with self.subTest(operation=operation):
                plan = self.plan('import sqlite3\nconnection = sqlite3.connect("app.db")\n'
                    'try:\n    ' + operation + '\nexcept Exception: pass\ndef target(): return 1\n',
                    [{'path': 'app.db', 'kind': 'sqlite'}])
                result = self.preflight(plan)
                self.assertFalse(result['ok'], result)
                self.assertFalse((self.output / 'outside.db').exists())

    def test_direct_generated_test_io_is_blocked_but_target_io_is_allowed(self):
        plan = self.plan('from pathlib import Path\ndef target(): return Path("config.ini").read_text()\n',
            [{'path': 'config.ini', 'kind': 'text', 'text': 'controlled'}])
        test = self.root / 'generated.py'
        test.write_text('from pathlib import Path\ndef read_direct(): return Path("config.ini").read_text()\n')
        result = self.script(plan, 'from isolated_resources import set_generated_test_file\n'
            'from runtime_policy import guarded_runtime, RuntimePolicyError\n'
            f'set_generated_test_file({str(test)!r})\n'
            'with guarded_runtime():\n    import app, generated\n    assert app.target() == "controlled"\n'
            'try:\n    with guarded_runtime(): generated.read_direct()\n'
            'except RuntimePolicyError: print("BLOCKED")\nelse: raise AssertionError("direct I/O allowed")\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('BLOCKED', result.stdout)

    def test_missing_file_database_schema_is_blocked_even_when_swallowed(self):
        for owner in ('connection', 'connection.cursor()', 'connection.execute("SELECT 1")'):
            for operation in ('execute("SELECT value FROM missing")',
                              'execute("SELECT missing FROM known")',
                              'executemany("INSERT INTO missing VALUES (?)", [(1,)])',
                              'executescript("SELECT value FROM missing;")'):
                with self.subTest(owner=owner, operation=operation):
                    plan = self.plan('import sqlite3\nconnection=sqlite3.connect("app.db")\n'
                        'connection.execute("CREATE TABLE known(value INTEGER)")\n'
                        'try:\n    ' + owner + '.' + operation + '\nexcept Exception: pass\n',
                        [{'path': 'app.db', 'kind': 'sqlite'}])
                    value = self.preflight(plan)
                    self.assertFalse(value['ok'], value)
                    self.assertIn('resource-schema-required', value['reason'])

    def test_missing_schema_cannot_become_a_trace_exception_oracle(self):
        plan = self.plan('import sqlite3\ndef target():\n    with sqlite3.connect("app.db") as connection:\n'
            '        return connection.execute("SELECT value FROM missing").fetchone()\n',
            [{'path': 'app.db', 'kind': 'sqlite'}])
        result = self.run_tool('dynamic_tracer.py', plan, [self.file, 'target', '[[]]'])
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['examples'], [], value)
        self.assertEqual(value['errors'], [], value)
        self.assertEqual(value['cases'][0]['status'], 'blocked', value)
        self.assertIn('resource-schema-required', json.dumps(value))

    def test_memory_sqlite_missing_schema_is_not_reclassified(self):
        plan = self.plan('import sqlite3\ndef target():\n    with sqlite3.connect(":memory:") as connection:\n'
            '        try: connection.execute("SELECT value FROM missing")\n'
            '        except sqlite3.OperationalError: return "expected"\n',
            [{'path': 'app.db', 'kind': 'sqlite'}])
        result = self.script(plan, 'from runtime_policy import guarded_runtime\n'
            'with guarded_runtime():\n    import app\n    assert app.target() == "expected"\n')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_generated_test_cannot_use_connection_or_cursor_returned_by_target(self):
        plan = self.plan('import sqlite3\ndef target():\n    connection=sqlite3.connect("app.db")\n'
            '    return connection, connection.execute("SELECT 7")\n', [{'path': 'app.db', 'kind': 'sqlite'}])
        test = self.root / 'generated.py'
        for operation in ('connection.execute("SELECT 1")', 'cursor.execute("SELECT 1")',
                          'cursor.fetchone()', 'next(cursor)', 'connection.commit()'):
            with self.subTest(operation=operation):
                test.write_text('from app import target\ndef test_direct():\n'
                    '    connection, cursor = target()\n    ' + operation + '\n')
                result = self.script(plan, 'from isolated_resources import set_generated_test_file\n'
                    'from runtime_policy import guarded_runtime, RuntimePolicyError\n'
                    f'set_generated_test_file({str(test)!r})\n'
                    'try:\n    with guarded_runtime():\n        import generated\n        generated.test_direct()\n'
                    'except RuntimePolicyError: print("BLOCKED")\nelse: raise AssertionError("direct SQL I/O allowed")\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('BLOCKED', result.stdout)

    def test_conflicting_specs_expired_hash_and_missing_lease_fail_closed(self):
        plan = self.plan('def target(): return 1\n', [{'path': 'data', 'kind': 'directory'}])
        plan['rules'][0]['resourceSourceHash'] = '0' * 64
        self.assertFalse(self.preflight(plan)['ok'])
        plan['rules'][0]['resourceSourceHash'] = plan['rules'][0]['sourceHash']
        plan['rules'][0]['resources'].append({'path': 'data', 'kind': 'text', 'text': 'bad'})
        self.assertFalse(self.preflight(plan)['ok'])
        plan['rules'][0]['resources'].pop()
        (self.lease / '.llm-unit-test-resource-lease.json').unlink()
        self.assertFalse(self.preflight(plan)['ok'])

    def test_invalid_schemas_and_executable_resource_paths_are_rejected(self):
        from isolated_resources import validate_resources
        invalid = [
            {'path': '../outside', 'kind': 'directory'}, {'path': 'data/run.py', 'kind': 'text', 'text': 'pass'},
            {'path': 'data', 'kind': 'directory', 'text': 'unexpected'},
            {'path': 'app.db', 'kind': 'sqlite', 'tables': [{'name': 'bad;drop', 'columns': []}]},
            {'path': 'app.db', 'kind': 'sqlite', 'tables': [{'name': 't', 'columns': [{'name': 'id', 'type': 'TEXT'}],
                'rows': [{'other': 'unknown'}]}]},
            {'path': 'app.db', 'kind': 'sqlite', 'tables': [{'name': 't', 'columns': [{'name': 'id', 'type': 'TEXT'}],
                'rows': [{'id': float('nan')}]}]},
        ]
        for spec in invalid:
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                validate_resources({'resources': [spec], 'resourceSourceHash': 'a' * 64, 'sourceHash': 'a' * 64})

    def test_resource_mount_cannot_include_source_or_create_executable(self):
        for spec, source in [({'path': 'code', 'kind': 'directory'}, 'def target(): return 1\n'),
                             ({'path': 'data', 'kind': 'directory'}, 'from pathlib import Path\nPath("data/x.py").write_text("pass")\n')]:
            plan = self.plan(source, [spec], filename='code/app.py')
            result = self.preflight(plan)
            self.assertFalse(result['ok'], result)


if __name__ == '__main__':
    unittest.main()
