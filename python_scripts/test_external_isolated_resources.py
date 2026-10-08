"""Explicit external logical paths map only to fresh owned test resources."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from isolated_resources import IsolatedResources, absolute, external_resource_identity, logical_resource_path, validate_resources
from basic_mutation_runner import prepare_trial_directory, trial_environment


class ExternalIsolatedResourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'workspace' / 'project'
        self.root.mkdir(parents=True)
        for package in (self.root, self.root.parent):
            (package / '__init__.py').write_text('', encoding='utf-8')
        self.external = self.base / 'external'
        self.external.mkdir()
        self.output = self.base / 'output'
        self.output.mkdir()
        self.source = self.root / 'app.py'
        self.lease = self.base / 'lease'
        self.lease.mkdir()
        (self.lease / '.llm-unit-test-resource-lease.json').write_text(json.dumps({
            'schemaVersion': 'isolated-resource-lease-v1', 'ownerPid': os.getpid()}), encoding='utf-8')
        self.originals = {self.external / 'label.txt': b'ORIGINAL-MUST-NOT-BE-READ',
                          self.external / 'items.db': b'ORIGINAL-NOT-A-SQLITE-FILE'}
        for file, contents in self.originals.items():
            file.write_bytes(contents)

    def spec(self, path, kind='directory', **options):
        return {'path': external_resource_identity(path), 'scope': 'external-exact', 'kind': kind, **options}

    def plan(self, source, resources):
        self.source_text = source
        self.source.write_text(source, encoding='utf-8')
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        return {'schemaVersion': 'import-fixtures-v1', 'id': 'e' * 64, 'root': str(self.root), 'rules': [{
            'file': 'app.py', 'sourceHash': digest, 'resourceSourceHash': digest, 'resources': resources}]}

    def environment(self, plan):
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(TOOLS), str(self.base), str(self.root), str(self.output)]),
               'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1',
               'LLM_UNIT_TEST_RESOURCE_LEASE': str(self.lease)}
        if plan is None:
            env.pop('LLM_UNIT_TEST_IMPORT_FIXTURES', None)
        else:
            env['LLM_UNIT_TEST_IMPORT_FIXTURES'] = json.dumps(plan)
        return env

    def tool(self, name, plan, args=(), payload=None):
        result = subprocess.run([sys.executable, '-B', str(TOOLS / name), *map(str, args)],
            env=self.environment(plan), cwd=self.output, input=json.dumps(payload) if payload is not None else None,
            capture_output=True, text=True, encoding='utf-8', timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def preflight(self, plan):
        return self.tool('module_preflight.py', plan, payload={'file': str(self.source), 'module': 'app',
            'sourceRoot': str(self.root), 'importPaths': [str(self.root)]})

    def assert_originals_preserved(self):
        for file, content in self.originals.items():
            self.assertEqual(file.read_bytes(), content)
        self.assertEqual(sorted(item.name for item in self.external.iterdir()), ['items.db', 'label.txt'])
        self.assertEqual(self.source.read_text(encoding='utf-8'), self.source_text)
        self.assertEqual(sorted(item.name for item in self.lease.iterdir()), ['.llm-unit-test-resource-lease.json'])

    def database_plan(self):
        source = ('from pathlib import Path\nimport sqlite3\nDATA=Path(' + repr(self.spec(self.external)['path']) + ')\n'
            'DATA.mkdir(parents=True, exist_ok=True)\nLABEL=(DATA/"label.txt").read_text()\n'
            'def target(amount):\n'
            '    with sqlite3.connect(DATA/"items.db") as connection:\n'
            '        value=connection.execute("SELECT value FROM items WHERE id=1").fetchone()[0]\n'
            '        connection.execute("UPDATE items SET value=? WHERE id=1", (value+amount,))\n'
            '        (DATA/"created.txt").write_text("temporary")\n'
            '        return value+amount+len(LABEL)\n')
        return self.plan(source, [self.spec(self.external), self.spec(self.external / 'label.txt', 'text', text='abc'),
            self.spec(self.external / 'items.db', 'sqlite', tables=[{'name': 'items', 'columns': [
                {'name': 'id', 'type': 'INTEGER', 'primaryKey': True}, {'name': 'value', 'type': 'INTEGER'}],
                'rows': [{'id': 1, 'value': 10}]}])])

    def test_actual_external_receiver_proposes_exact_mapping_and_real_io_never_opens_originals(self):
        plan = self.database_plan()
        blocked = self.preflight(None)
        self.assertFalse(blocked['ok'])
        candidate = blocked['diagnostic'].get('initialization_candidate')
        self.assertIsNotNone(candidate, blocked)
        self.assertEqual(candidate['resourceScope'], 'external-exact')
        self.assertEqual(candidate['resourcePath'], self.spec(self.external)['path'])
        probe = self.output / 'guard_original.py'
        probe.write_text('import json, os, sys\nfrom module_preflight import preflight\n'
            f'protected={absolute(self.external)!r}\n'
            'def no_original_content(event, args):\n'
            '    if event in ("open", "sqlite3.connect") and args and isinstance(args[0], (str, bytes, os.PathLike)):\n'
            '        value=os.path.normcase(os.path.abspath(os.fsdecode(args[0])))\n'
            '        try: inside=os.path.commonpath((value, protected))==protected\n'
            '        except ValueError: inside=False\n'
            '        if inside: raise AssertionError("original external content was accessed")\n'
            'sys.addaudithook(no_original_content)\n'
            'print(json.dumps(preflight(json.loads(sys.stdin.read()))))\n', encoding='utf-8')
        loaded = self.tool(str(probe), plan, payload={'file': str(self.source), 'module': 'app',
            'sourceRoot': str(self.root), 'importPaths': [str(self.root)]})
        self.assertTrue(loaded['ok'], loaded)
        self.assertEqual(loaded['importFixtures']['resources']['resourceCount'], 3)
        self.assert_originals_preserved()

    def test_external_seed_is_fresh_for_trace_runner_builtin_and_real_mutatest(self):
        plan = self.database_plan()
        observed = self.tool('dynamic_tracer.py', plan, [self.source, 'target', '[[1],[2]]'])
        self.assertEqual([case['result'] for case in observed['examples']], ['14', '15'])
        tests = self.output / 'test_app.py'
        tests.write_text('import unittest\nfrom workspace.project.app import target\nclass Cases(unittest.TestCase):\n'
                         '    def test_value(self): self.assertEqual(target(1), 14)\n', encoding='utf-8')
        result_file = self.output / 'result.json'
        self.tool('generated_test_runner.py', plan, [tests.stem, '--result-json', result_file])
        self.assertEqual(json.loads(result_file.read_text(encoding='utf-8'))['status'], 'passed')
        for tool, prefix in [('basic_mutation_runner.py', []), ('external_mutation_runner.py', ['mutatest'])]:
            with self.subTest(engine=tool):
                if prefix:
                    from external_mutation_runner import probe_engine
                    if not probe_engine('mutatest')['supported']:
                        self.skipTest('verified mutatest 3.1.0 AST API is not installed')
                report = self.tool(tool, plan, [*prefix, self.source, tests, 2, 10, 'target'])
                self.assertTrue(report['baseline_passed'], report)
                self.assertTrue(report['scoreAvailable'], report)
                self.assertGreater(report['counts']['killed'], 0)
                self.assertEqual(report['counts']['error'], 0)
                self.assertEqual(report['engine'], 'mutatest' if prefix else 'builtin')
                self.assertEqual(report['baselineImportFixtures']['id'], plan['id'])
        self.assert_originals_preserved()

    def test_nested_seeds_share_minimal_declared_root_and_distinct_roots_do_not_collide(self):
        another = self.base / 'elsewhere' / 'external'
        specs = [self.spec(self.external), self.spec(self.external / 'nested'),
                 self.spec(self.external / 'nested' / 'value.txt', 'text', text='first'),
                 self.spec(another), self.spec(another / 'value.txt', 'text', text='second'),
                 self.spec(self.base / 'standalone.txt', 'text', text='alone')]
        plan = self.plan('def target(): return 1\n', specs)
        with patch.dict(os.environ, self.environment(plan)):
            resources = IsolatedResources(plan)
            try:
                first = Path(resources._physical(absolute(self.external)))
                expected_hash = hashlib.sha256(self.spec(self.external)['path'].encode('utf-8')).hexdigest()
                self.assertEqual(first.name, expected_hash)
                self.assertEqual(first.parent.name, 'external')
                self.assertEqual(Path(resources._physical(absolute(self.external / 'nested' / 'value.txt'))),
                                 first / 'nested' / 'value.txt')
                self.assertEqual((first / 'nested' / 'value.txt').read_text(), 'first')
                second = Path(resources._physical(absolute(another)))
                self.assertNotEqual(first, second)
                self.assertEqual((second / 'value.txt').read_text(), 'second')
                self.assertEqual(Path(resources._physical(absolute(self.base / 'standalone.txt'))).read_text(), 'alone')
                with self.assertRaises(ValueError):
                    resources._physical(absolute(self.base / 'undeclared.txt'))
            finally:
                resources.cleanup()
        self.assertFalse(another.exists())
        self.assertFalse((self.base / 'standalone.txt').exists())
        self.assert_originals_preserved()

    def test_external_mutation_mount_stays_exact_without_any_source_relative_alias(self):
        plan = self.database_plan()
        tests = self.output / 'test_app.py'
        tests.write_text('import unittest\nfrom workspace.project.app import target\nclass Cases(unittest.TestCase):\n'
                         '    def test_value(self): self.assertEqual(target(1), 14)\n', encoding='utf-8')
        trial = self.base / 'trial'
        with patch.dict(os.environ, self.environment(plan)):
            copy = prepare_trial_directory(self.source, tests, trial, self.source_text)
            environment = trial_environment(trial, self.source, copy)
            rebased = json.loads(environment['LLM_UNIT_TEST_IMPORT_FIXTURES'])
            resources = IsolatedResources(rebased)
            try:
                self.assertEqual({alias for alias, _, _ in resources.mounts},
                                 {absolute(spec['path']) for spec in plan['rules'][0]['resources']})
            finally:
                resources.cleanup()
            canonical = trial / 'workspace' / 'project' / 'app.py'
            self.assertFalse((trial / 'app.py').exists())
            canonical.write_text(self.source_text.replace('return value+amount+len(LABEL)', 'return 0'), encoding='utf-8')
            environment = trial_environment(trial, self.source, copy)
        failed = subprocess.run([sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'), copy.stem],
            env=environment, cwd=trial, capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertEqual(failed.returncode, 1, failed.stderr)
        self.assertIn('0 != 14', failed.stderr)
        self.assert_originals_preserved()

    @unittest.skipUnless(os.name == 'nt', 'native Windows drive semantics')
    def test_real_cross_drive_resource_uses_only_owned_seed_and_preserves_original_sentinel(self):
        if self.root.drive.lower() == TOOLS.drive.lower():
            self.skipTest('a writable repository on a second drive is required')
        with tempfile.TemporaryDirectory(prefix='external-resource-fixture-', dir=TOOLS.parent) as directory:
            external = Path(directory)
            sentinel = external / 'label.txt'
            sentinel.write_text('ORIGINAL-SECOND-DRIVE', encoding='utf-8')
            source = ('from pathlib import Path\nDATA=Path(' + repr(self.spec(external)['path']) + ')\n'
                'DATA.mkdir(exist_ok=True)\nLABEL=(DATA/"label.txt").read_text()\n'
                '(DATA/"created.txt").write_text("temporary")\ndef target(): return LABEL\n')
            plan = self.plan(source, [self.spec(external), self.spec(sentinel, 'text', text='controlled')])
            self.assertTrue(self.preflight(plan)['ok'])
            tests = self.output / 'test_cross_drive.py'
            tests.write_text('import unittest\nfrom app import target\nclass Cases(unittest.TestCase):\n'
                '    def test_value(self): self.assertEqual(target(), "controlled")\n', encoding='utf-8')
            self.tool('generated_test_runner.py', plan, [tests.stem])
            self.assertEqual(sentinel.read_text(encoding='utf-8'), 'ORIGINAL-SECOND-DRIVE')
            self.assertEqual([file.name for file in external.iterdir()], ['label.txt'])
        self.assert_originals_preserved()

    def test_generated_direct_external_io_and_unknown_schema_cannot_pass(self):
        plan = self.database_plan()
        tests = self.output / 'test_direct.py'
        tests.write_text('import unittest\nfrom pathlib import Path\nfrom app import target\n'
            'class Cases(unittest.TestCase):\n    def test_direct(self):\n'
            '        Path(' + repr(self.spec(self.external / 'label.txt')['path']) + ').read_text()\n', encoding='utf-8')
        result_file = self.output / 'direct_result.json'
        completed = subprocess.run([sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'),
            tests.stem, '--result-json', str(result_file)], env=self.environment(plan), cwd=self.output,
            capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(json.loads(result_file.read_text())['status'], 'isolation-blocked')
        for spec in plan['rules'][0]['resources']:
            if spec['kind'] == 'sqlite':
                spec['tables'] = []
        observed = self.tool('dynamic_tracer.py', plan, [self.source, 'target', '[[1]]'])
        self.assertIn('resource-schema-required', json.dumps(observed))
        self.assertFalse(any(case.get('call_assertable') for case in observed.get('examples', [])))
        self.assert_originals_preserved()

    @unittest.skipUnless(os.name == 'nt', 'native Windows path identity')
    def test_external_case_alias_shares_one_seed_but_different_seed_is_rejected(self):
        specs = [self.spec(self.external), self.spec(self.external / 'value.txt', 'text', text='SeedValue')]
        plan = self.plan('def target(): return 1\n', specs)
        helper = self.root / 'helper.py'
        helper.write_text('VALUE = 1\n', encoding='utf-8')
        digest = hashlib.sha256(helper.read_bytes()).hexdigest()
        plan['rules'].append({'file': 'helper.py', 'sourceHash': digest, 'resourceSourceHash': digest,
            'resources': [{**spec, 'path': spec['path'].upper()} for spec in specs]})
        with patch.dict(os.environ, self.environment(plan)):
            resources = IsolatedResources(plan)
            try:
                self.assertEqual(resources.evidence()['resourceCount'], 2)
                file = resources._physical(absolute(self.external / 'value.txt'))
                self.assertEqual(Path(file).read_text(), 'SeedValue')
            finally:
                resources.cleanup()
            plan['rules'][1]['resources'][1]['text'] = 'seedvalue'
            with self.assertRaisesRegex(ValueError, 'Conflicting isolated resource'):
                IsolatedResources(plan)
        self.assert_originals_preserved()

    def test_external_declaration_rejects_unsafe_paths_and_source_scope_overlap(self):
        prefix = self.spec(self.external)['path']
        values = ['', '/', 'C:/', 'C:relative', '//server/share/data', '\\\\server\\share\\data',
            '//?/C:/data', prefix + '/../escape', prefix + '/./value', prefix + '//value', prefix + '/',
            prefix + '/CON', prefix + '/value:stream', prefix + '/bad.', prefix + '/bad ',
            prefix + '/run.py', prefix + '/run.exe', prefix + '/bad\x00', 'x' * 241,
            external_resource_identity(self.root), external_resource_identity(self.root / 'data'),
            external_resource_identity(self.root.parent / 'sibling'), external_resource_identity(self.root.parent)]
        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    logical_resource_path(self.root, {'path': value, 'scope': 'external-exact', 'kind': 'directory'})
        plan = self.plan('def target(): return 1\n', [self.spec(self.external)])
        with patch.dict(os.environ, self.environment(plan)):
            for attributes in ({'st_mode': stat.S_IFLNK, 'st_file_attributes': 0},
                               {'st_mode': stat.S_IFDIR, 'st_file_attributes': 1024}):
                from types import SimpleNamespace
                from isolated_resources import _ORIGINAL_LSTAT
                def linked(path):
                    return SimpleNamespace(**attributes) if absolute(path) == absolute(self.external) else _ORIGINAL_LSTAT(path)
                with patch('isolated_resources._ORIGINAL_LSTAT', side_effect=linked):
                    with self.assertRaisesRegex(ValueError, 'symlink or junction'):
                        IsolatedResources(plan)
        self.assert_originals_preserved()

    def test_link_checks_stop_before_touching_link_or_missing_prefix_descendants(self):
        from types import SimpleNamespace
        from isolated_resources import _has_link, inside
        link = absolute(self.base / 'linked')
        child = Path(link) / 'nested' / 'new-data'
        for mode, attributes in [(stat.S_IFLNK, 0), (stat.S_IFDIR, 1024), (None, None)]:
            with self.subTest(mode=mode, attributes=attributes):
                visited = []
                def metadata(path):
                    value = absolute(path)
                    visited.append(value)
                    self.assertFalse(value != link and inside(value, link),
                                     'a parent link or missing prefix must stop all descendant metadata')
                    if value == link:
                        if mode is None:
                            raise FileNotFoundError(path)
                        return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
                    return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0)
                with patch('isolated_resources._ORIGINAL_LSTAT', side_effect=metadata):
                    self.assertEqual(_has_link(child), mode is not None)
                self.assertEqual(visited[-1], link)
                self.assertEqual(visited[0], absolute(Path(link).anchor))

    def test_link_helper_rejects_unc_and_device_before_any_metadata(self):
        from isolated_resources import _has_link
        paths = ['//test-server.invalid/test-share/data', '//?/C:/unapproved', '//./unapproved']
        if os.name == 'nt':
            paths += ['\\\\test-server.invalid\\test-share\\data', '\\??\\C:\\unapproved']
        with patch('isolated_resources._ORIGINAL_LSTAT', side_effect=AssertionError('metadata must not be called')):
            for value in paths:
                with self.subTest(value=value):
                    self.assertTrue(_has_link(value))

    def test_changed_derived_external_path_blocks_mutation_instead_of_guessing_alias(self):
        source = ('from pathlib import Path\nDATA=Path(__file__).resolve().parent.parent.parent/"external"\n'
                  'DATA.mkdir(exist_ok=True)\nLABEL=(DATA/"label.txt").read_text()\n'
                  'def target(value): return value + len(LABEL)\n')
        plan = self.plan(source, [self.spec(self.external), self.spec(self.external / 'label.txt', 'text', text='abc')])
        self.assertTrue(self.preflight(plan)['ok'])
        tests = self.output / 'test_app.py'
        tests.write_text('import unittest\nfrom app import target\nclass Cases(unittest.TestCase):\n'
                        '    def test_value(self): self.assertEqual(target(1), 4)\n', encoding='utf-8')
        report = self.tool('basic_mutation_runner.py', plan, [self.source, tests, 1, 10, 'target'])
        self.assertFalse(report['baseline_passed'])
        self.assertEqual(report['baselineStatus'], 'error')
        self.assertFalse(report['scoreAvailable'])
        self.assertEqual(report['counts']['killed'], 0)
        self.assert_originals_preserved()


if __name__ == '__main__':
    unittest.main()
