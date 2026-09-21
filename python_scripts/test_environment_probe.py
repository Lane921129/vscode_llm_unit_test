import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parent


class EnvironmentProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def probe(self, source, relative='sample.py'):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(source, encoding='utf-8')
        result = subprocess.run([sys.executable, '-B', str(TOOLS / 'environment_probe.py')],
                                input=json.dumps({'file': str(file), 'sourceRoot': str(self.root),
                                                  'importPaths': [str(file.parent), str(self.root)]}),
                                text=True, encoding='utf-8', capture_output=True, cwd=self.root, timeout=20,
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_existing_environment_imports_target_without_creating_venv(self):
        result = self.probe('import math\ndef target(value):\n    return math.sqrt(value)\n')
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(os.path.normcase(result['python']), os.path.normcase(sys.executable))
        self.assertTrue(result['coverage'])
        self.assertFalse((self.root / '.venv').exists())

    def test_external_missing_dependency_is_structured(self):
        result = self.probe('import neutral_uninstalled_environment_dependency\n')
        self.assertEqual(result['status'], 'missing')
        self.assertEqual(result['missing'], 'neutral_uninstalled_environment_dependency')
        self.assertNotIn('traceback', result)

    def test_local_submodule_is_not_a_distribution_to_install(self):
        package = self.root / 'local_package'
        package.mkdir()
        (package / '__init__.py').write_text('', encoding='utf-8')
        result = self.probe('import local_package.missing\n')
        self.assertEqual(result['status'], 'local-or-submodule')

    def test_side_effect_is_still_blocked_without_creating_directory(self):
        result = self.probe("from pathlib import Path\nPath('should_not_exist').mkdir()\n")
        self.assertEqual(result['status'], 'blocked')
        self.assertFalse((self.root / 'should_not_exist').exists())

    def test_import_error_does_not_copy_private_exception_text(self):
        result = self.probe("raise ImportError('PRIVATE_DIAGNOSTIC_SENTINEL')\n")
        self.assertEqual(result['status'], 'import-error')
        self.assertNotIn('PRIVATE_DIAGNOSTIC_SENTINEL', json.dumps(result))

    def test_namespace_relative_import_uses_canonical_module(self):
        package = self.root / 'neutral_namespace'
        package.mkdir()
        (package / 'helper.py').write_text('value = 1\n', encoding='utf-8')
        result = self.probe('from .helper import value\ndef target():\n    return value\n', 'neutral_namespace/entry.py')
        self.assertEqual(result['status'], 'ready')

    def test_broken_python_source_is_not_a_missing_package(self):
        result = self.probe('def invalid(:\n')
        self.assertEqual(result['status'], 'import-error')
        self.assertEqual(result['stage'], 'static-analysis')

    def test_pip_runner_does_not_execute_project_local_pip_module(self):
        (self.root / 'pip.py').write_text("from pathlib import Path\nPath('hijacked').touch()\n", encoding='utf-8')
        env = {key: value for key, value in os.environ.items() if key.upper() not in ('PYTHONPATH', 'PYTHONHOME')}
        env['PYTHONIOENCODING'] = 'utf-8'
        result = subprocess.run([sys.executable, '-B', str(TOOLS / 'package_installer.py'), '--version'],
                                cwd=self.root, env=env, text=True, encoding='utf-8', capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('pip ', result.stdout)
        self.assertFalse((self.root / 'hijacked').exists())


if __name__ == '__main__':
    unittest.main()
