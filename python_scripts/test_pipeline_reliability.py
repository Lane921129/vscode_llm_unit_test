import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import textwrap
from validate_test_bindings import validate_bindings

TOOLS = Path(__file__).resolve().parent


class PipelineReliabilityTests(unittest.TestCase):
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
