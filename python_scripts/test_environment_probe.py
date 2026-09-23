import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from python_scripts import dependency_inventory


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

    def scan(self):
        result = subprocess.run([sys.executable, '-B', str(TOOLS / 'environment_probe.py')],
                                input=json.dumps({'scanRoot': str(self.root), 'sourceRoot': str(self.root)}),
                                text=True, encoding='utf-8', capture_output=True, cwd=self.root, timeout=20,
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def write(self, relative, source):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(source, encoding='utf-8')

    def test_folder_collects_all_files_and_nested_imports_without_executing_source(self):
        self.write('first.py', "import neutral_missing_alpha\nraise RuntimeError('PRIVATE_SOURCE')\n")
        self.write('nested/second.py', 'def target():\n    import neutral_missing_beta.child\n')
        self.write('effect.py', "from pathlib import Path\nPath('should_not_exist').touch()\n")
        value = self.scan()
        self.assertEqual(value['status'], 'missing')
        self.assertEqual(value['inventory']['missing'], ['neutral_missing_alpha', 'neutral_missing_beta'])
        self.assertEqual(value['inventory']['filesScanned'], 3)
        item = next(item for item in value['inventory']['imports'] if item['module'].endswith('.child'))
        self.assertEqual(item['references'], [{'file': 'nested/second.py', 'line': 2, 'context': 'required'}])
        self.assertNotIn('PRIVATE_SOURCE', json.dumps(value))
        self.assertFalse((self.root / 'should_not_exist').exists())

    def test_local_namespace_src_relative_and_stdlib_are_not_pip_candidates(self):
        self.write('src/package/helper.py', '')
        self.write('entry.py', 'import package.helper\nimport os\nfrom json import loads\n')
        self.write('src/package/entry.py', 'from .helper import value\n')
        value = self.scan()['inventory']
        self.assertEqual(value['missing'], [])
        self.assertEqual(next(item for item in value['imports'] if item['module'] == 'package.helper')['kind'], 'local')
        self.assertEqual(next(item for item in value['imports'] if item['module'] == 'os')['kind'], 'stdlib')

    def test_plain_ancestor_module_is_unresolved_local_instead_of_a_pip_candidate(self):
        self.write('application/neutral_store.py', 'def target(): return 1\n')
        self.write('application/archive/entry.py', 'import neutral_store\nimport neutral_absent\n')
        value = self.scan()['inventory']
        self.assertFalse(value['complete'])
        self.assertEqual(value['missing'], ['neutral_absent'])
        self.assertEqual(next(item for item in value['imports'] if item['module'] == 'neutral_store')['kind'], 'unresolved-local')
        self.assertTrue(any(issue['reason'] == 'local-import-root-unresolved' for issue in value['issues']))

    def test_inventory_does_not_import_installed_package_or_submodule(self):
        self.write('sample.py', 'import coverage.nonexistent_submodule\n')
        with patch('importlib.machinery.PathFinder.find_spec', return_value=object()) as lookup:
            value = dependency_inventory.inventory(self.root)
        lookup.assert_called_once_with('coverage')
        self.assertEqual(value['imports'][0]['availability'], 'available')
        self.assertEqual(value['missing'], [])

    def test_conditional_optional_and_type_only_dependencies_are_reported_separately(self):
        self.write('sample.py', '''from typing import TYPE_CHECKING
if TYPE_CHECKING:
    import neutral_typing
if True:
    import neutral_conditional
try:
    import neutral_optional
except ImportError:
    import neutral_fallback
import neutral_required
def nested():
    import neutral_required
''')
        value = self.scan()['inventory']
        self.assertEqual(value['missing'], ['neutral_required'])
        self.assertEqual(value['optionalMissing'], ['neutral_conditional', 'neutral_fallback', 'neutral_optional', 'neutral_typing'])
        self.assertEqual(len(next(item for item in value['imports'] if item['module'] == 'neutral_required')['references']), 2)

    def test_excludes_environments_generated_artifacts_and_configured_output(self):
        self.write('sample.py', 'import math\n')
        for directory in ('.venv', 'node_modules', '__pycache__', 'build', 'custom_environment', 'result/run', 'configured_output'):
            self.write(directory + '/sample.py', 'import neutral_unwanted\n')
        (self.root / 'custom_environment/pyvenv.cfg').write_text('home = neutral\n')
        (self.root / 'result/run/run_manifest.json').write_text(json.dumps({'schemaVersion': 2, 'runId': 'neutral',
                                                                        'sourceHash': 'neutral', 'promptVersion': 'role-contracts-v1'}))
        value = dependency_inventory.inventory(self.root, excluded_paths=[self.root / 'configured_output'])
        self.assertEqual(value['filesScanned'], 1)
        self.assertEqual(value['missing'], [])
        self.assertEqual(value['excludedDirectories'], 7)

    def test_bad_source_is_partial_inventory_and_never_ready(self):
        self.write('valid.py', 'import neutral_missing\n')
        self.write('broken.py', 'def invalid(PRIVATE_SOURCE:\n')
        result = self.scan()
        self.assertEqual(result['status'], 'import-error')
        self.assertFalse(result['inventory']['complete'])
        self.assertEqual(result['inventory']['issues'], [{'file': 'broken.py', 'reason': 'source-parse-error'}])
        self.assertNotIn('PRIVATE_SOURCE', json.dumps(result))

    def test_scan_limits_fail_closed_and_empty_scope_is_not_success(self):
        self.assertFalse(dependency_inventory.inventory(self.root)['complete'])
        self.write('a.py', 'import alpha\n')
        self.write('b.py', 'import beta\n')
        with patch.object(dependency_inventory, 'MAX_FILES', 1):
            value = dependency_inventory.inventory(self.root)
        self.assertFalse(value['complete'])
        self.assertEqual(value['issues'][0]['reason'], 'scan-limit')
        with patch.object(dependency_inventory, 'MAX_FILE_BYTES', 1):
            self.assertFalse(dependency_inventory.inventory(self.root)['complete'])

    def test_declared_source_encoding_and_dynamic_limitations(self):
        (self.root / 'sample.py').write_bytes(b'# coding: latin-1\n# caf\xe9\nimport math\n__import__(name)\n')
        value = self.scan()['inventory']
        self.assertTrue(value['complete'])
        self.assertEqual(value['dynamicImports'], 1)

    def test_linked_directory_outside_scope_is_not_scanned(self):
        self.write('sample.py', 'import math\n')
        with tempfile.TemporaryDirectory() as external:
            Path(external, 'sample.py').write_text('import neutral_outside\n')
            try:
                (self.root / 'linked').symlink_to(external, target_is_directory=True)
            except OSError:
                self.skipTest('Symlinks unavailable for current user')
            value = dependency_inventory.inventory(self.root)
            self.assertEqual(value['missing'], [])
            self.assertEqual(value['excludedDirectories'], 1)


if __name__ == '__main__':
    unittest.main()
