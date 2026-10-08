"""Virtual UNC resources: zero original filesystem/network calls at every phase."""
from contextlib import contextmanager, ExitStack
import builtins
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import isolated_resources


@contextmanager
def unc_zero_touch_sentinels():
    """Reusable replay helper: fail before a native API receives an original UNC.

    Install before importing the tool under test. Captured resource originals
    are protected too. No real server is contacted; attempts are safe labels.
    """
    attempts = []
    state = {'active': True}
    def remote(value):
        return isolated_resources.is_unc_or_device(value)
    def protect(function, label):
        def checked(*args, **kwargs):
            value = args[0] if args else kwargs.get('path', kwargs.get('file', kwargs.get('database')))
            if state['active'] and remote(value):
                attempts.append(label)
                raise AssertionError('Original UNC native operation reached sentinel')
            return function(*args, **kwargs)
        return checked
    def audit(event, args):
        if not state['active']:
            return
        if event in ('socket.connect', 'socket.getaddrinfo', 'socket.bind', 'socket.sendto') or (
                event in ('open', 'os.mkdir', 'os.listdir', 'os.scandir', 'sqlite3.connect')
                and args and remote(args[0])):
            attempts.append(event)
            raise AssertionError('Original UNC/network audit operation reached sentinel')
    sys.addaudithook(audit)
    with ExitStack() as stack:
        targets = [(os, ('stat', 'lstat', 'listdir', 'scandir', 'access', 'mkdir', 'open', 'remove', 'unlink', 'rmdir', 'readlink')),
            (os.path, ('realpath', 'exists', 'lexists', 'isfile', 'isdir', 'islink', 'isjunction', 'ismount', 'isdevdrive')),
            (builtins, ('open',)), (io, ('open',)), (sqlite3, ('connect',)), (sqlite3.dbapi2, ('connect',)),
            (isolated_resources, ('_ORIGINAL_OPEN', '_ORIGINAL_LSTAT', '_ORIGINAL_STAT', '_ORIGINAL_CONNECT'))]
        if os.name == 'nt':
            import nt
            import ntpath
            names = ('_getfinalpathname', '_getfullpathname', '_findfirstfile', '_getvolumepathname', '_nt_readlink',
                     '_path_exists', '_path_lexists', '_path_isfile', '_path_isdir', '_path_islink', '_path_isjunction',
                     '_path_isdevdrive', 'stat', 'lstat', 'listdir', 'scandir', 'access', 'readlink')
            targets += [(nt, names), (ntpath, names)]
        seen = set()
        for module, names in targets:
            for name in names:
                if (id(module), name) in seen or not hasattr(module, name):
                    continue
                seen.add((id(module), name))
                stack.enter_context(patch.object(module, name, protect(getattr(module, name), module.__name__ + '.' + name)))
        try:
            yield attempts
        finally:
            state['active'] = False


@unittest.skipUnless(os.name == 'nt', 'virtual UNC resources require Windows')
class UncVirtualResourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'project'
        self.root.mkdir()
        self.source = self.root / 'app.py'
        self.output = self.base / 'output'
        self.output.mkdir()
        self.lease = self.base / 'lease'
        self.lease.mkdir()
        (self.lease / '.llm-unit-test-resource-lease.json').write_text(json.dumps({
            'schemaVersion': 'isolated-resource-lease-v1', 'ownerPid': os.getpid()}), encoding='utf-8')
        self.site = self.base / 'sentinels'
        self.site.mkdir()
        # Every child, including baseline/mutants, installs the same sentinels
        # before tool imports. Swallowed sentinel errors fail at process exit.
        (self.site / 'sitecustomize.py').write_text(
            'import atexit, os, sys\nfrom test_unc_virtual_resources import unc_zero_touch_sentinels\n'
            '_sentinel_context=unc_zero_touch_sentinels()\n_attempts=_sentinel_context.__enter__()\n'
            'def _verify():\n    if _attempts:\n        sys.stderr.write("UNC_SENTINEL_VIOLATION\\n")\n'
            '        sys.stderr.flush()\n        os._exit(92)\natexit.register(_verify)\n', encoding='utf-8')
        self.unc = '//fixture-host.invalid/unit-share'

    def spec(self, suffix='', kind='directory', **options):
        return {'scope': 'unc-virtual', 'path': self.unc + suffix, 'kind': kind, **options}

    def plan(self, source, specs=None):
        self.source_text = source
        self.source.write_text(source, encoding='utf-8')
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        return {'schemaVersion': 'import-fixtures-v1', 'id': 'c' * 64, 'root': str(self.root), 'rules': [{
            'file': 'app.py', 'sourceHash': digest, 'resourceSourceHash': digest, 'resources': specs or [self.spec()]}]}

    def environment(self, plan):
        result = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(self.site), str(TOOLS), str(self.root), str(self.output)]),
            'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1', 'LLM_UNIT_TEST_RESOURCE_LEASE': str(self.lease)}
        result.pop('LLM_UNIT_TEST_IMPORT_FIXTURES', None)
        if plan is not None:
            result['LLM_UNIT_TEST_IMPORT_FIXTURES'] = json.dumps(plan)
        return result

    def tool(self, name, plan, args=(), payload=None, expected_exit=0):
        completed = subprocess.run([sys.executable, '-B', str(TOOLS / name), *map(str, args)],
            env=self.environment(plan), cwd=self.output, input=json.dumps(payload) if payload is not None else None,
            capture_output=True, text=True, encoding='utf-8', timeout=70)
        self.assertNotIn('UNC_SENTINEL_VIOLATION', completed.stderr)
        self.assertEqual(completed.returncode, expected_exit, completed.stderr)
        return json.loads(completed.stdout) if completed.stdout.strip() else None

    def preflight(self, plan):
        return self.tool('module_preflight.py', plan, payload={'file': str(self.source), 'module': 'app',
            'sourceRoot': str(self.root), 'importPaths': [str(self.root)]})

    def assert_preserved(self):
        self.assertEqual(self.source.read_text(encoding='utf-8'), self.source_text)
        self.assertEqual([p.name for p in self.lease.iterdir()], ['.llm-unit-test-resource-lease.json'])

    def test_observed_share_root_proposal_then_approved_import_uses_no_original_unc(self):
        source = 'from pathlib import Path\nDATA=Path(' + repr(self.unc) + ')\nDATA.mkdir(exist_ok=True)\ndef target(): return True\n'
        plan = self.plan(source)
        before = self.preflight(None)
        self.assertFalse(before['ok'], before)
        candidate = before['diagnostic']['initialization_candidate']
        self.assertEqual(candidate['resourceScope'], 'unc-virtual')
        self.assertEqual(candidate['resourcePath'], self.unc)
        after = self.preflight(plan)
        self.assertTrue(after['ok'], after)
        self.assertEqual(after['importFixtures']['resources']['resourceCount'], 1)
        self.assert_preserved()

    def test_shared_root_contains_nested_seed_without_metadata_and_rejects_extended_source_overlap(self):
        specs = [self.spec(), self.spec('/nested'), self.spec('/nested/value.txt', 'text', text='seed')]
        plan = self.plan('def target(): return 1\n', specs)
        with unc_zero_touch_sentinels() as attempts, patch.dict(os.environ, self.environment(plan)):
            resources = isolated_resources.IsolatedResources(plan)
            try:
                root = Path(resources._physical(isolated_resources.absolute(self.unc)))
                self.assertEqual(root.parent.name, 'unc-virtual')
                self.assertEqual(root.name, hashlib.sha256(('unc-virtual:' + self.unc).encode()).hexdigest())
                child = Path(resources._physical(isolated_resources.absolute(self.unc + '/nested/value.txt')))
                self.assertEqual(child, root / 'nested' / 'value.txt')
                self.assertEqual(child.read_text(), 'seed')
                for selected in (self.unc, self.unc + '/source', self.unc + '/source/child'):
                    with self.assertRaises(ValueError):
                        isolated_resources.logical_resource_path('//?/UNC/fixture-host.invalid/unit-share/source',
                            {'scope': 'unc-virtual', 'kind': 'directory', 'path': selected})
            finally:
                resources.cleanup()
            self.assertEqual(attempts, [])
        self.assert_preserved()

    def test_unapproved_metadata_and_known_native_aliases_stop_before_platform_calls(self):
        expressions = ['data.exists()', 'data.stat()', 'data.lstat()', 'data.resolve()', 'data.resolve(strict=True)',
            'list(data.iterdir())', 'os.stat(data)', 'os.lstat(data)', 'os.listdir(data)', 'list(os.scandir(data))',
            'os.access(data, os.R_OK)', 'os.path.realpath(data)', 'os.path.exists(data)', 'os.path.isdir(data)',
            'os.path.isfile(data)', 'os.path.islink(data)', 'nt.stat(data)', 'nt.access(data, os.R_OK)',
            'nt._getfinalpathname(str(data))', 'ntpath._getfinalpathname(str(data))',
            'nt._path_exists(str(data))']
        for expression in expressions:
            with self.subTest(expression=expression):
                self.plan('from pathlib import Path\nimport os, nt, ntpath\ndata=Path(' + repr(self.unc) + ')\n'
                          + expression + '\ndef target(): return 1\n')
                blocked = self.preflight(None)
                self.assertFalse(blocked['ok'], blocked)
                self.assertIn('blocked', blocked['reason'].lower())
                self.assert_preserved()

    def test_pure_unc_absolute_normalization_reaches_mkdir_proposal_without_native_access(self):
        source = 'from pathlib import Path\nDATA=Path(' + repr(self.unc) + ').absolute()\nDATA.mkdir(exist_ok=True)\n'
        plan = self.plan(source)
        before = self.preflight(None)
        self.assertFalse(before['ok'], before)
        self.assertEqual(before['diagnostic']['blocked_operation'], 'os.mkdir')
        self.assertEqual(before['diagnostic']['initialization_candidate']['resourcePath'], self.unc)
        self.assertTrue(self.preflight(plan)['ok'])
        self.assert_preserved()

    def test_lexical_absolute_keeps_unc_share_anchor_when_parent_is_requested(self):
        import ntpath
        expected = ntpath.normpath(self.unc + '/value')
        source = ('from pathlib import Path\nimport nt, ntpath\n'
            'raw=' + repr(self.unc + '/../value') + '\n'
            'assert ntpath.abspath(raw)==' + repr(expected) + '\n'
            'assert nt._getfullpathname(raw)==' + repr(expected) + '\n'
            'DATA=Path(' + repr(self.unc) + ').absolute()\nDATA.mkdir(exist_ok=True)\n')
        plan = self.plan(source)
        with unc_zero_touch_sentinels() as attempts:
            self.assertEqual(isolated_resources.absolute(self.unc + '/../value'), expected)
            self.assertEqual(attempts, [])
        before = self.preflight(None)
        self.assertFalse(before['ok'], before)
        self.assertEqual(before['diagnostic']['blocked_operation'], 'os.mkdir')
        self.assertEqual(before['diagnostic']['initialization_candidate']['resourcePath'], self.unc)
        self.assertTrue(self.preflight(plan)['ok'])
        self.assert_preserved()

    def database_plan(self):
        source = ('from pathlib import Path\nimport os, nt, sqlite3\nDATA=Path(' + repr(self.unc) + ')\n'
            'DATA.mkdir(exist_ok=True)\nassert DATA.resolve(strict=True)==DATA\n'
            'assert (DATA/"missing.txt").resolve()==DATA/"missing.txt"\n'
            'assert os.path.isdir(DATA) and os.access(DATA, os.R_OK) and nt.access(DATA, os.R_OK)\n'
            'LABEL=(DATA/"label.txt").read_text()\n'
            'def verify_metadata():\n'
            '    assert all(str(path).startswith(str(DATA)) for path in DATA.iterdir())\n'
            '    for scan in (os.scandir, nt.scandir):\n'
            '        with scan(DATA) as entries:\n'
            '            for entry in entries:\n'
            '                assert str(entry.path).startswith(str(DATA))\n'
            '                assert entry.is_file() and entry.stat().st_size >= 0\n'
            'verify_metadata()\n'
            'def target(amount):\n'
            '    with sqlite3.connect(DATA/"items.db") as connection:\n'
            '        value=connection.execute("SELECT value FROM items WHERE id=1").fetchone()[0]\n'
            '        connection.execute("UPDATE items SET value=? WHERE id=1", (value+amount,))\n'
            '        return value+amount+len(LABEL)\n')
        return self.plan(source, [self.spec(), self.spec('/label.txt', 'text', text='abc'),
            self.spec('/items.db', 'sqlite', tables=[{'name': 'items', 'columns': [
                {'name': 'id', 'type': 'INTEGER', 'primaryKey': True}, {'name': 'value', 'type': 'INTEGER'}],
                'rows': [{'id': 1, 'value': 10}]}])])

    def test_real_unc_fixture_metadata_trace_runner_builtin_and_mutatest_are_local_and_fresh(self):
        plan = self.database_plan()
        loaded = self.preflight(plan)
        self.assertTrue(loaded['ok'], loaded)
        observed = self.tool('dynamic_tracer.py', plan, [self.source, 'target', '[[1],[2]]'])
        self.assertEqual([case['result'] for case in observed['examples']], ['14', '15'], observed)
        (self.root / '__init__.py').write_text('', encoding='utf-8')
        tests = self.output / 'test_target.py'
        tests.write_text('import unittest\nfrom project.app import target\nclass Cases(unittest.TestCase):\n'
                         '    def test_value(self): self.assertEqual(target(1), 14)\n', encoding='utf-8')
        # The ordinary runner uses the package parent too; mutation copies then
        # prove that canonical package imports execute only the mutated file.
        environment = self.environment(plan)
        environment['PYTHONPATH'] += os.pathsep + str(self.base)
        result_file = self.output / 'result.json'
        completed = subprocess.run([sys.executable, '-B', str(TOOLS / 'generated_test_runner.py'),
            tests.stem, '--result-json', str(result_file)], env=environment, cwd=self.output,
            capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn('UNC_SENTINEL_VIOLATION', completed.stderr)
        self.assertEqual(json.loads(result_file.read_text())['status'], 'passed')
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
        self.assert_preserved()

    def test_missing_strict_paths_report_logical_names_and_no_physical_paths(self):
        source = ('from pathlib import Path\nDATA=Path(' + repr(self.unc) + ')\n'
            'def target():\n'
            '    for action in ((DATA/"missing.txt").read_text, (DATA/"missing.txt").stat, '
            'lambda: (DATA/"missing.txt").resolve(strict=True)):\n'
            '        try: action()\n'
            '        except FileNotFoundError as error:\n'
            '            assert str(error.filename).startswith(str(DATA)), str(error.filename)\n'
            '        else: raise AssertionError("missing controlled file was accepted")\n'
            '    return True\n')
        plan = self.plan(source)
        observed = self.tool('dynamic_tracer.py', plan, [self.source, 'target', '[[]]'])
        self.assertEqual(observed['examples'][0]['result'], 'True', observed)
        self.assert_preserved()

    def test_generated_test_cannot_iterate_a_scandir_returned_by_the_target(self):
        plan = self.plan('from pathlib import Path\nimport os\nDATA=Path(' + repr(self.unc) + ')\n'
                         'def target(): return os.scandir(DATA)\n', [self.spec(), self.spec('/label.txt', 'text', text='seed')])
        tests = self.output / 'test_direct.py'
        tests.write_text('import unittest\nfrom app import target\nclass Cases(unittest.TestCase):\n'
            '    def test_direct(self):\n        with target() as entries:\n            next(entries)\n', encoding='utf-8')
        result_file = self.output / 'result.json'
        self.tool('generated_test_runner.py', plan, [tests.stem, '--result-json', result_file], expected_exit=86)
        self.assertEqual(json.loads(result_file.read_text())['status'], 'isolation-blocked')
        self.assert_preserved()

    def test_undeclared_share_parent_traversal_device_and_invalid_schema_remain_blocked(self):
        for receiver in (self.unc, self.unc + '/data/../elsewhere', '//fixture-host.invalid/other-share',
                         '//?/UNC/fixture-host.invalid/unit-share/data'):
            with self.subTest(receiver=receiver):
                plan = self.plan('from pathlib import Path\nPath(' + repr(receiver) + ').stat()\ndef target(): return 1\n',
                                 [self.spec('/data')])
                self.assertFalse(self.preflight(plan)['ok'])
                self.assert_preserved()
        plan = self.database_plan()
        plan['rules'][0]['resources'][-1]['tables'] = []
        observed = self.tool('dynamic_tracer.py', plan, [self.source, 'target', '[[1]]'])
        self.assertIn('resource-schema-required', json.dumps(observed))
        self.assertFalse(any(case.get('call_assertable') for case in observed.get('examples', [])))
        self.assert_preserved()

    def test_virtual_unc_parser_rejects_devices_and_keeps_other_scopes_strict(self):
        from isolated_resources import unc_resource_identity, logical_resource_path
        self.assertEqual(unc_resource_identity('//FIXTURE-HOST.INVALID/UNIT-SHARE/'), self.unc)
        self.assertEqual(unc_resource_identity('\\\\fixture-host.invalid\\unit-share'), self.unc)
        for value in ('//server', '//server/', '//server/share//', '//server/share/data/', '//server/IPC$',
                      '//server/share/../data', '//server/share/./data', '//server/share/data:ads',
                      '//?/C:/data', '//./pipe/name', '//server/share/NUL', '//server/share/run.py', '//server/share/bad\x00'):
            with self.subTest(value=value), unc_zero_touch_sentinels() as attempts:
                with self.assertRaises(ValueError):
                    unc_resource_identity(value)
                self.assertEqual(attempts, [])
        with unc_zero_touch_sentinels() as attempts:
            with self.assertRaises(ValueError):
                logical_resource_path(self.root, {'scope': 'external-exact', 'path': self.unc, 'kind': 'directory'})
            self.assertTrue(isolated_resources._has_link(self.unc))
            self.assertEqual(attempts, [])

    def test_package_copy_never_resolves_or_follows_a_local_link_toward_unc(self):
        from basic_mutation_runner import package_copy_ignore
        from types import SimpleNamespace
        plan = self.plan('def target(): return 1\n')
        alias = self.root / 'remote_alias'
        native_lstat = os.lstat
        for mode, flags in ((stat.S_IFLNK, 0), (stat.S_IFDIR, 1024)):
            def metadata(path):
                if isolated_resources.absolute(path) == isolated_resources.absolute(alias):
                    return SimpleNamespace(st_mode=mode, st_file_attributes=flags)
                return native_lstat(path)
            with self.subTest(mode=mode), patch.dict(os.environ, self.environment(plan)), unc_zero_touch_sentinels() as attempts:
                ignore, _ = package_copy_ignore()
                with patch('basic_mutation_runner.os.lstat', side_effect=metadata), \
                        patch('basic_mutation_runner.os.path.realpath', side_effect=AssertionError('link target must not be resolved')):
                    self.assertEqual(ignore(str(self.root), ['remote_alias']), {'remote_alias'})
                self.assertEqual(attempts, [])
        self.assert_preserved()


if __name__ == '__main__':
    unittest.main()
