import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import textwrap
from unittest.mock import patch
from validate_test_bindings import validate_bindings
import module_preflight

TOOLS = Path(__file__).resolve().parent


class PipelineReliabilityTests(unittest.TestCase):
    def test_child_mock_configuration_does_not_hide_later_parent_assertion(self):
        context = {'module': 'sample', 'target': 'target', 'source': 'def target():\n    return connect()\n',
                   'requireMockBehavior': True}
        def candidate(setup, assertion='dep.assert_called_once()'):
            return ('import unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
                    'class Cases(unittest.TestCase):\n    def test_value(self):\n'
                    '        with patch("sample.connect") as dep:\n'
                    + textwrap.indent(setup + '\ntarget()\n' + assertion, '            '))
        arrangement = 'dep.return_value.cursor().fetchone.return_value = ("controlled",)'
        self.assertTrue(validate_bindings(candidate(arrangement), context)['valid'])
        for setup, assertion in [
            (arrangement, 'dep.return_value.cursor.assert_called_once()'),
            ('child = dep.return_value.cursor\n' + arrangement, 'child.assert_called_once()'),
            ('alias = dep\n' + arrangement, 'alias.return_value.cursor.assert_called_once()'),
            ('dep().cursor.return_value = 1', 'dep.assert_called_once()'),
            ('dep.return_value = object()\n' + arrangement, 'dep.assert_called_once()'),
            ('dep.return_value.cursor.side_effect = object\n' + arrangement, 'dep.assert_called_once()'),
            ('dep.return_value.cursor(unknown()).fetchone.return_value = 1', 'dep.assert_called_once()'),
            ('dep.return_value.reset_mock().value = 1', 'dep.assert_called_once()'),
            ('dep.return_value.cursor().assert_called_once = lambda: None', 'dep.return_value.cursor.assert_called_once()'),
        ]:
            with self.subTest(setup=setup, assertion=assertion):
                self.assertFalse(validate_bindings(candidate(setup, assertion), context)['valid'])

    def test_selected_target_patches_are_rejected_even_with_ordinary_assertions(self):
        context = {'module': 'sample', 'target': 'normalize', 'className': 'Widget'}
        imports = 'from unittest.mock import patch as p\nfrom sample import Widget as W\nimport sample as m\n'
        for expression in ["p('sample.Widget.normalize')", "p('sample.Widget')",
                           "p.object(W, 'normalize')", "p.object(m.Widget, 'normalize')"]:
            candidate = imports + f'with {expression}:\n    assert W.normalize(2) == 2\n'
            self.assertFalse(validate_bindings(candidate, context)['valid'], expression)
        for expression in ["p('sample.read')", "p.object(W, 'read')", "p('other.Widget.normalize')"]:
            self.assertTrue(validate_bindings(imports + expression, context)['valid'], expression)
        module_context = {'module': 'sample', 'target': 'normalize'}
        self.assertFalse(validate_bindings(imports + "p.object(m, 'normalize')", module_context)['valid'])
        self.assertTrue(validate_bindings(imports + "p.object(m, 'read')", module_context)['valid'])

    def test_unittest_required_inputs_are_structure_failures_without_breaking_mock_injection(self):
        prefix = 'from unittest import TestCase as Case\nfrom unittest.mock import patch\nclass Tests(Case):\n'
        for signature in ['self, value', 'self, /, value', 'self, *, value']:
            code = prefix + f'    def test_case({signature}):\n        self.assertTrue(True)\n'
            result = validate_bindings(code, {'module': 'sample', 'target': 'target'})
            self.assertFalse(result['valid'], signature)
            self.assertIn('extra arguments', result['reason'])
        for signature in ['self', 'self, value=2', 'self, *, value=2', 'self, *args']:
            self.assertTrue(validate_bindings(prefix + f'    def test_case({signature}):\n        pass\n', {})['valid'])
        injected = prefix + "    @patch('sample.read')\n    def test_case(self, dependency):\n        pass\n"
        self.assertTrue(validate_bindings(injected, {'module': 'sample', 'target': 'target'})['valid'])

    def test_binding_source_context_uses_stdin_without_windows_command_line_limit(self):
        code = ('import unittest\nfrom unittest.mock import MagicMock\nfrom sample import target\n'
                'class Cases(unittest.TestCase):\n    def test_mock(self):\n'
                '        dependency = MagicMock()\n        target(dependency)\n        dependency.assert_not_called()\n')
        context = {'module': 'sample', 'target': 'target', 'requireMockBehavior': True,
                   'source': 'def target(dependency):\n    return None\n' + '# context\n' * 6000}
        result = self.invoke('validate_test_bindings.py', args=['--payload'], payload={'code': code, 'context': context})
        self.assertTrue(result['valid'])

    def test_mock_call_assertions_require_target_linkage_and_standard_mock_provenance(self):
        context = {'module': 'sample', 'target': 'target', 'dependencies': {}, 'requireMockBehavior': True,
                   'source': 'def target(value=None):\n    return connect(value)\n'}
        def code(body, decorator=''):
            return ('import unittest\nfrom unittest.mock import patch, MagicMock\nfrom sample import target\n'
                    'class Cases(unittest.TestCase):\n' + (f'    {decorator}\n' if decorator else '') +
                    '    def test_behavior(self' + (', dependency' if decorator else '') + '):\n' +
                    textwrap.indent(textwrap.dedent(body), '        '))
        valid = [
            code('with patch("sample.connect") as dependency:\n    target(3)\n    dependency.assert_called_once_with(3)'),
            code('target(3)\ndependency.assert_called_once_with(3)', '@patch("sample.connect")'),
            code('dependency = MagicMock()\ntarget(dependency)\ndependency.assert_not_called()'),
            code('with patch("sample.connect") as dependency:\n    dependency.return_value = MagicMock()\n    target()\n    dependency.return_value.execute.assert_not_called()'),
        ]
        for candidate in valid:
            self.assertTrue(validate_bindings(candidate, context)['valid'], candidate)
        invalid = [
            code('dependency = MagicMock()\ntarget()\ndependency.assert_not_called()'),
            code('dependency = object()\ntarget(dependency)\ndependency.assert_not_called()'),
            code('with patch("sample.unused") as dependency:\n    target()\n    dependency.assert_not_called()'),
            code('with patch("sample.target") as dependency:\n    target()\n    dependency.assert_not_called()'),
            code('with patch("sample.connect") as dependency:\n    dependency(3)\n    target(3)\n    dependency.assert_called_with(3)'),
            code('with patch("sample.connect") as dependency:\n    target()\n    dependency.assert_called_once = lambda: None\n    dependency.assert_called_once()'),
            code('with patch("sample.connect") as dependency:\n    target()\n    dependency = object()\n    dependency.assert_called_once()'),
            code('if False:\n    with patch("sample.connect") as dependency:\n        target()\n        dependency.assert_called_once()'),
            code('target()\ntext = "dependency.assert_called_once()"'),
            code('with patch("sample.connect") as dependency:\n    target()\n    dependency.assert_called_once()').replace('class Cases', 'patch = lambda *a: None\nclass Cases'),
            code('target(3)\ndependency.assert_called_once_with(3)', '@patch("sample.connect", new_callable=object)'),
        ]
        for candidate in invalid:
            self.assertFalse(validate_bindings(candidate, context)['valid'], candidate)
        shadowed = {**context, 'source': 'def target(connect):\n    return connect()\n'}
        self.assertFalse(validate_bindings(valid[0], shadowed)['valid'])
        asynchronous = {**context, 'source': 'async def target(value):\n    return await connect(value)\n'}
        async_code = valid[0].replace('unittest.TestCase', 'unittest.IsolatedAsyncioTestCase').replace('def test_behavior', 'async def test_behavior')
        self.assertFalse(validate_bindings(async_code, asynchronous)['valid'])
        self.assertTrue(validate_bindings(async_code.replace('target(3)', 'await target(3)'), asynchronous)['valid'])
        # The accepted patch example must also execute a real target and assertion.
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'sample.py').write_text('def connect(value): raise RuntimeError("must be mocked")\ndef target(value): return connect(value)\n', encoding='utf-8')
            Path(folder, 'generated_test.py').write_text(valid[0], encoding='utf-8')
            executed = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'generated_test'], cwd=folder,
                                      capture_output=True, text=True, timeout=10)
            self.assertEqual(executed.returncode, 0, executed.stderr)

    def test_trace_blocks_sqlite_files_shared_memory_and_swallowed_guard_errors(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database = root / 'must_not_exist.db'
            target = root / 'sample.py'
            connections = [
                f'sqlite3.connect({str(database)!r})',
                f'sqlite3.Connection({str(database)!r})',
                f'sqlite3.dbapi2.connect({str(database)!r})',
                "sqlite3.connect('file:shared?mode=memory&cache=shared', uri=True)",
            ]
            for connection in connections:
                for swallowed in (False, True):
                    body = f'    conn = {connection}\n    return 1\n'
                    if swallowed:
                        body = f'    try:\n        conn = {connection}\n    except Exception:\n        return 1\n'
                    target.write_text('import sqlite3\ndef target():\n' + body, encoding='utf-8')
                    traced = self.invoke('dynamic_tracer.py', args=[str(target), 'target'])
                    self.assertEqual(traced['examples'], [], traced)
                    self.assertEqual(traced['errors'], [], traced)
                    self.assertTrue(traced['blocked_operations'], traced)
                    self.assertFalse(database.exists())
            target.write_text('import sqlite3\nconn = sqlite3.Connection(' + repr(str(database)) + ')\n', encoding='utf-8')
            result = self.invoke('module_preflight.py', {'file': str(target), 'module': 'sample', 'importPaths': [folder]})
            self.assertFalse(result['ok'])
            self.assertEqual(result['diagnostic']['exception_type'], 'TraceSafetyError')
            self.assertFalse(database.exists())

    def test_trace_accepts_independent_in_memory_sqlite(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'sample.py'
            target.write_text("import sqlite3\ndef target():\n    with sqlite3.connect(':memory:') as conn:\n        return conn.execute('select 7').fetchone()[0]\n", encoding='utf-8')
            traced = self.invoke('dynamic_tracer.py', args=[str(target), 'target'])
            self.assertEqual(traced['examples'][0]['result'], '7')
            self.assertEqual(traced['blocked_operations'], [])

    def test_sqlite_guard_applies_to_worker_threads_during_trace(self):
        with tempfile.TemporaryDirectory() as folder:
            target, database = Path(folder) / 'sample.py', Path(folder) / 'thread.db'
            target.write_text('import sqlite3\nimport threading\ndef target():\n'
                              '    def worker():\n        try:\n'
                              f'            sqlite3.connect({str(database)!r})\n'
                              '        except Exception: pass\n'
                              '    thread = threading.Thread(target=worker)\n    thread.start()\n    thread.join()\n    return 1\n', encoding='utf-8')
            traced = self.invoke('dynamic_tracer.py', args=[str(target), 'target'])
            self.assertTrue(traced['blocked_operations'])
            self.assertFalse(any(item.get('assertable') for item in traced['examples']))
            self.assertFalse(database.exists())

    def test_isolated_sqlite_cannot_attach_or_export_to_persistent_files(self):
        with tempfile.TemporaryDirectory() as folder:
            target, database = Path(folder) / 'sample.py', Path(folder) / 'attached.db'
            for operation in (f'ATTACH DATABASE {str(database)!r} AS other', f'VACUUM INTO {str(database)!r}'):
                target.write_text('import sqlite3\ndef target():\n'
                                  '    with sqlite3.connect(":memory:") as connection:\n'
                                  f'        connection.execute({operation!r})\n    return 1\n', encoding='utf-8')
                traced = self.invoke('dynamic_tracer.py', args=[str(target), 'target'])
                self.assertTrue(traced['blocked_operations'])
                self.assertFalse(database.exists())

    def test_trace_exception_identity_is_verified_and_local_types_are_not_oracles(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'sample.py'
            target.write_text('class DomainError(ValueError): pass\ndef target(value):\n    if value == 1:\n        raise DomainError()\n    class LocalError(ValueError): pass\n    raise LocalError()\n', encoding='utf-8')
            traced = self.invoke('dynamic_tracer.py', args=[str(target), 'target', '[[1], [2]]'])
            custom = next(item for item in traced['errors'] if item['exception'] == 'DomainError')
            local = next(item for item in traced['errors'] if item['exception'] == 'LocalError')
            self.assertEqual(custom['exception_module'], 'sample')
            self.assertEqual(custom['exception_qualname'], 'DomainError')
            self.assertFalse(local['call_assertable'])

    def invoke(self, script, payload=None, args=(), code=None):
        run = subprocess.run([sys.executable, '-B', str(TOOLS / script), *args],
                             input=json.dumps(payload) if payload is not None else code,
                             capture_output=True, text=True, encoding='utf-8',
                             env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=20)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def test_preflight_does_not_call_target_and_accepts_unicode_package(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            package = root / '中性套件'
            package.mkdir()
            (package / '__init__.py').write_text('', encoding='utf-8')
            target = package / 'sample.py'
            target.write_text("print('diagnostic')\ndef target():\n    raise RuntimeError('must not execute')\n", encoding='utf-8')
            result = self.invoke('module_preflight.py', {'file': str(target), 'module': '中性套件.sample', 'importPaths': [folder]})
            self.assertTrue(result['ok'], result)

    def test_package_initializer_keeps_its_canonical_identity_and_relative_imports(self):
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder) / 'fixture_package'
            package.mkdir()
            (package / 'helper.py').write_text('VALUE = 3\n', encoding='utf-8')
            target = package / '__init__.py'
            target.write_text('from .helper import VALUE\ndef target(): return VALUE\n', encoding='utf-8')
            result = self.invoke('module_preflight.py', {'file': str(target), 'module': 'fixture_package', 'importPaths': [folder]})
            self.assertTrue(result['ok'], result)
            traced = self.invoke('dynamic_tracer.py', args=[str(target), 'target'])
            self.assertFalse(traced.get('load_error'), traced)
            self.assertTrue(traced['examples'], traced)

    def test_resource_scope_binds_all_loaded_sources_with_unicode_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '資料.py').write_text('VALUE = 3\n', encoding='utf-8')
            target = root / 'sample.py'
            target.write_text('from 資料 import VALUE\ndef target(): return VALUE\n', encoding='utf-8')
            result = self.invoke('module_preflight.py', {'file': str(target), 'module': 'sample',
                'importPaths': [folder], 'sourceRoot': folder})
            self.assertTrue(result['ok'])
            self.assertEqual({Path(item['file']).name for item in result['sourceVersions']}, {'sample.py', '資料.py'})
            identities = [[item['file'], item['hash']] for item in result['sourceVersions']]
            digest = hashlib.sha256(json.dumps(identities, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
            self.assertEqual(result['resourceScope'], {'version': 'loaded-resource-scope-v1',
                'eligible': True, 'sourceSetHash': digest})

    def test_local_conditional_or_transitive_lazy_imports_keep_full_resource_scope(self):
        for source, helper in [
            ('def target():\n    import never_loaded\n', None),
            ('if False:\n    import never_loaded\ndef target(): return 1\n', None),
            ('try:\n    import math\nexcept ImportError:\n    pass\n', None),
            ('class Example:\n    import math\n', None),
            ('from helper import VALUE\ndef target(): return VALUE\n', 'VALUE = 3\ndef lazy():\n    import never_loaded\n')
        ]:
            with self.subTest(source=source), tempfile.TemporaryDirectory() as folder:
                target = Path(folder) / 'sample.py'
                target.write_text(source, encoding='utf-8')
                if helper is not None:
                    Path(folder, 'helper.py').write_text(helper, encoding='utf-8')
                result = self.invoke('module_preflight.py', {'file': str(target), 'module': 'sample',
                    'importPaths': [folder], 'sourceRoot': folder})
                self.assertTrue(result['ok'])
                self.assertFalse(result['resourceScope']['eligible'])
                self.assertEqual(result['resourceScope']['reason'], 'nested-import')
                self.assertNotIn('never_loaded.py', [Path(item['file']).name for item in result['sourceVersions']])

    def test_resource_scope_dynamic_bindings_are_unknown_without_executing_them(self):
        sources = [
            'import importlib as loader\ndef target(name): return loader.import_module(name)\n',
            'from external import import_module as loader\n',
            'from external import __import__ as loader\n',
            'from external import *\n',
            'def target(name): return __import__(name)\n',
            'alias = eval\n', 'alias = exec\n', 'def target(): return loader.exec_module(value)\n',
            'import sys as runtime\nregistry = runtime.modules\n',
            'from sys import meta_path as hooks\n',
            'def target(obj, key): return getattr(obj, key)\n',
            'def target(key): return globals()[key]\n',
        ]
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'sample.py'
            for source in sources:
                with self.subTest(source=source):
                    target.write_text(source, encoding='utf-8')
                    versions = [{'file': str(target), 'hash': hashlib.sha256(target.read_bytes()).hexdigest()}]
                    result = module_preflight.resource_scope_evidence(versions)
                    self.assertFalse(result['eligible'])
                    self.assertEqual(result['reason'], 'dynamic-import')
                    self.assertNotIn(source, json.dumps(result))
            target.write_text('# import importlib; eval(payload)\nTEXT = "__import__ exec_module"\n'
                              'def target(): return TEXT\n', encoding='utf-8')
            versions = [{'file': str(target), 'hash': hashlib.sha256(target.read_bytes()).hexdigest()}]
            self.assertTrue(module_preflight.resource_scope_evidence(versions)['eligible'])

    def test_resource_scope_snapshot_drift_parse_and_bounds_never_authorize_filtering(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'sample.py'
            target.write_bytes(b'# coding: latin-1\nTEXT = "caf\xe9"\n')
            versions = [{'file': str(target), 'hash': hashlib.sha256(target.read_bytes()).hexdigest()}]
            self.assertTrue(module_preflight.resource_scope_evidence(versions)['eligible'])
            for setting in ['RESOURCE_SCOPE_MAX_SOURCES', 'RESOURCE_SCOPE_MAX_FILE_BYTES',
                            'RESOURCE_SCOPE_MAX_TOTAL_BYTES', 'RESOURCE_SCOPE_MAX_AST_NODES']:
                with self.subTest(setting=setting), patch.object(module_preflight, setting, 0):
                    result = module_preflight.resource_scope_evidence(versions)
                    self.assertFalse(result['eligible'])
                    self.assertEqual(result['reason'], 'source-budget')
            target.write_bytes(b'TEXT = "changed"\n')
            self.assertEqual(module_preflight.resource_scope_evidence(versions)['reason'], 'source-changed')
            target.write_bytes(b'def broken(:\n')
            versions[0]['hash'] = hashlib.sha256(target.read_bytes()).hexdigest()
            self.assertEqual(module_preflight.resource_scope_evidence(versions)['reason'], 'source-parse')
            target.unlink()
            self.assertEqual(module_preflight.resource_scope_evidence(versions)['reason'], 'source-unavailable')
            for invalid in [[], None, [{}], versions + versions,
                            [{'file': str(target), 'hash': 'invalid'}],
                            [{'file': str(Path(folder) / '\ud800.py'), 'hash': 'a' * 64}]]:
                self.assertFalse(module_preflight.resource_scope_evidence(invalid)['eligible'])

    def test_resource_scope_does_not_guess_callback_receiver_or_rebound_callee_dispatch(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'sample.py'
            for source in [
                'def target(loader):\n    return loader()\n',
                'def target(connection):\n    return connection.cursor()\n',
                'import sqlite3\ndef target():\n    return sqlite3.connect(":memory:")\n',
                'def helper(): return 1\nhelper = callback\ndef target(): return helper()\n',
                'def helper(): return 1\ndef target(helper): return helper()\n',
                '@decorator\ndef helper(): return 1\ndef target(): return helper()\n',
                'def target(decorator):\n    @decorator\n    def inner(): return 1\n    return 1\n',
                'def target(factory):\n    class Inner(metaclass=factory): pass\n    return 1\n',
                'def target(base):\n    class Inner(base): pass\n    return 1\n',
                'def helper(): return 1\ndef helper(): return 2\ndef target(): return helper()\n'
            ]:
                with self.subTest(source=source):
                    target.write_text(source, encoding='utf-8')
                    versions = [{'file': str(target), 'hash': hashlib.sha256(target.read_bytes()).hexdigest()}]
                    result = module_preflight.resource_scope_evidence(versions)
                    self.assertFalse(result['eligible'])
                    self.assertEqual(result['reason'], 'unknown-dispatch')
            target.write_text('import sqlite3\ndef helper(): return 1\ndef target(): return helper()\n', encoding='utf-8')
            versions = [{'file': str(target), 'hash': hashlib.sha256(target.read_bytes()).hexdigest()}]
            self.assertTrue(module_preflight.resource_scope_evidence(versions)['eligible'])

    def test_missing_dependency_preserves_actual_diagnostic_in_preflight_and_trace(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'sample.py'
            target.write_text('import fixture_dependency_that_does_not_exist\ndef target(value): return value\n', encoding='utf-8')
            result = self.invoke('module_preflight.py', {'file': str(target), 'module': 'sample', 'importPaths': [folder]})
            self.assertFalse(result['ok'])
            self.assertEqual(result['diagnostic']['missing_module'], 'fixture_dependency_that_does_not_exist')
            traced = self.invoke('dynamic_tracer.py', args=[str(target), 'target'])
            self.assertEqual(traced['load_diagnostic']['exception_type'], 'ModuleNotFoundError')
            self.assertIn('fixture_dependency_that_does_not_exist', traced['load_error'])
            self.assertEqual(traced['examples'], [])
            self.assertEqual(traced['errors'], [])

    def test_import_side_effect_remains_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            target, marker = Path(folder) / 'sample.py', Path(folder) / 'marker.txt'
            target.write_text(f"from pathlib import Path\nPath({str(marker)!r}).write_text('bad')\n", encoding='utf-8')
            result = self.invoke('module_preflight.py', {'file': str(target), 'module': 'sample', 'importPaths': [folder]})
            self.assertFalse(result['ok'])
            self.assertEqual(result['diagnostic']['exception_type'], 'TraceSafetyError')
            self.assertFalse(marker.exists())

    def test_invalid_import_path_and_wrong_module_identity_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'sample.py'
            target.write_text('def target(): return 1\n', encoding='utf-8')
            for module in ('old backup.sample', 'class.sample', 'json'):
                result = self.invoke('module_preflight.py', {'file': str(target), 'module': module, 'importPaths': [folder]})
                self.assertFalse(result['ok'], module)
                self.assertEqual(result['stage'], 'module-resolution')

    def test_import_gate_rejects_placeholder_wrong_source_and_class_member_import(self):
        def check(code, cls=None, dependencies=None):
            return self.invoke('validate_test_bindings.py', args=[json.dumps({
                'module': 'package.sample', 'target': 'render', 'className': cls, 'dependencies': dependencies or {}
            })], code=code)
        self.assertTrue(check('from package.sample import render as run')['valid'])
        self.assertTrue(check('from package.sample import Renderer as R', 'Renderer')['valid'])
        for code in ('from target_module import render', 'import target_module',
                     'from other.sample import render as run', 'from module_under_test import *'):
            self.assertFalse(check(code)['valid'], code)
        self.assertFalse(check('from package.sample import render', 'Renderer')['valid'])
        self.assertTrue(check('from support import render as render_input\nfrom package.sample import render',
                              dependencies={'render_input': 'support.render'})['valid'])


if __name__ == '__main__':
    unittest.main()
