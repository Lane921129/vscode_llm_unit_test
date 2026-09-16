import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parent


class PipelineReliabilityTests(unittest.TestCase):
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
