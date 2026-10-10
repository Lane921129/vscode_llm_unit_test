import builtins
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import plan_import_initialization as planner


class StaticInitializationPlanTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'project'
        self.root.mkdir()
        self.file = self.root / 'sample.py'

    def write(self, name, source):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(source, encoding='utf-8')
        return file

    def check(self, source, files=None):
        self.file.write_text(source, encoding='utf-8')
        result = planner.plan_initialization({'root': str(self.root), 'files': files or [str(self.file)]})
        self.assertTrue(all(item['reason'] in planner.DIAGNOSTIC_REASONS for item in result['diagnostics']))
        return result

    def test_directory_and_callback_are_gathered_without_executing_any_source(self):
        external = self.base / 'external'
        external.mkdir()
        marker = self.base / 'backend-ran'
        (external / 'neutral_backend.py').write_text(
            'import socket\nfrom pathlib import Path\n'
            'def launch(target):\n    socket.socket().bind(("127.0.0.1", 0))\n'
            f'    Path({str(marker)!r}).write_text("executed")\n    target(None)\n', encoding='utf-8')
        source = ('from pathlib import Path\nimport neutral_backend as backend\n'
                  'BASE = Path(__file__).resolve().parent\n'
                  'DATA = BASE.parent / "neutral-data"\n'
                  'DATA.mkdir(parents=True, exist_ok=True)\n'
                  'def main(page):\n    raise RuntimeError("callback must not run")\n'
                  'backend.launch(target=main)\n')
        self.file.write_text(source, encoding='utf-8')
        with mock.patch.object(socket.socket, 'bind', side_effect=AssertionError('socket executed')), \
                mock.patch.object(socket.socket, 'connect', side_effect=AssertionError('socket executed')), \
                mock.patch.object(Path, 'resolve', side_effect=AssertionError('resolve executed')), \
                mock.patch.dict(os.environ, {'PYTHONPATH': str(external)}):
            result = planner.plan({'root': str(self.root), 'files': [str(self.file)]})
        self.assertTrue(result['complete'], result)
        self.assertEqual(result['diagnostics'], [])
        self.assertEqual([item['kind'] for item in result['candidates']], ['mkdir', 'entry-point'])
        directory, entry = result['candidates']
        self.assertEqual(directory['resourcePath'], 'neutral-data')
        self.assertEqual(directory['resourceScope'], 'project-parent')
        self.assertEqual(entry['operation'], 'neutral_backend.launch')
        self.assertEqual(entry['line'], 8)
        self.assertEqual(entry['evidence'], 'static-direct-module-call')
        self.assertEqual(entry['returnValue'], 'discarded')
        self.assertEqual(entry['sourceHash'], hashlib.sha256(self.file.read_bytes()).hexdigest())
        self.assertFalse(marker.exists())
        self.assertFalse((self.base / 'neutral-data').exists())
        self.assertNotIn('neutral_backend', sys.modules)

    def test_imported_path_and_entry_aliases(self):
        for path_import, path_call in [('from pathlib import Path as P', 'P'),
                                       ('import pathlib as paths', 'paths.Path'),
                                       ('from pathlib import Path\nP = Path', 'P')]:
            with self.subTest(path_import=path_import):
                result = self.check(path_import + '\nfrom unrelated_provider import run as begin\n'
                                    f'{path_call}("output").mkdir(exist_ok=True)\n'
                                    'def callback(): pass\nbegin(callback)\n')
                self.assertEqual([item['kind'] for item in result['candidates']], ['mkdir', 'entry-point'])
                self.assertEqual(result['candidates'][1]['operation'], 'unrelated_provider.run')

    def test_source_strings_parents_and_division_are_evaluated_lexically(self):
        nested = self.write('package/sub/sample.py', '')
        source = ('from pathlib import Path\nNAME = "da" + "ta"\n'
                  'BASE = Path(__file__).parents[2]\n'
                  'DEST = BASE / NAME\nDEST.mkdir(mode=0o700, parents=True, exist_ok=True)\n')
        nested.write_text(source, encoding='utf-8')
        result = planner.plan({'root': str(self.root), 'files': [str(nested)]})
        self.assertTrue(result['complete'], result)
        self.assertEqual(result['candidates'][0]['resourcePath'], 'data')
        self.assertNotIn('resourceScope', result['candidates'][0])

    def test_all_static_local_import_sources_are_included_without_test_targets(self):
        self.write('package/__init__.py', 'from . import settings\n')
        self.write('package/settings.py', 'from pathlib import Path\nPath("settings-data").mkdir(exist_ok=True)\n')
        self.write('package/helper.py', 'from .deep import leaf\n')
        self.write('package/deep/__init__.py', '')
        self.write('package/deep/leaf.py', 'VALUE = 1\n')
        result = self.check('from package import helper\n')
        self.assertTrue(result['complete'], result)
        self.assertEqual({item['file'] for item in result['sources']}, {
            'sample.py', 'package/__init__.py', 'package/settings.py',
            'package/helper.py', 'package/deep/__init__.py', 'package/deep/leaf.py'})
        self.assertEqual([item['file'] for item in result['candidates']], ['package/settings.py'])

    def test_import_cycles_and_duplicate_selections_are_bounded_and_deduplicated(self):
        self.write('peer.py', 'import sample\n')
        result = self.check('import peer\n', [str(self.file), str(self.file)])
        self.assertTrue(result['complete'], result)
        self.assertEqual([item['file'] for item in result['sources']], ['peer.py', 'sample.py'])

    def test_package_ancestor_initializers_are_scanned_for_selected_submodule(self):
        self.write('package/__init__.py', 'import config\n')
        self.write('config.py', 'from pathlib import Path\nPath("config-data").mkdir(exist_ok=True)\n')
        selected = self.write('package/selected.py', 'def target(): return 3\n')
        result = planner.plan({'root': str(self.root), 'files': [str(selected)]})
        self.assertTrue(result['complete'], result)
        self.assertEqual({item['file'] for item in result['sources']}, {'config.py', 'package/__init__.py', 'package/selected.py'})

    def test_preflight_ancestor_import_paths_are_scanned_only_inside_source_root(self):
        self.write('first/second/near_config.py', 'VALUE = 1\n')
        self.write('first/far_config.py', 'from pathlib import Path\nPath("owned_data").mkdir(exist_ok=True)\n')
        self.write('root_config.py', 'VALUE = 3\n')
        outside = self.base / 'outside_only.py'
        outside.write_text('raise RuntimeError("external source must never be read or imported")\n', encoding='utf-8')
        selected = self.write('first/second/third/selected.py',
                              'import near_config\nimport far_config\nimport root_config\n'
                              'import outside_only\ndef callback(): pass\noutside_only.launch(callback)\n')
        original_open = builtins.open
        def source_open(value, *args, **kwargs):
            self.assertTrue(planner.inside(value, str(self.root)))
            return original_open(value, *args, **kwargs)
        with mock.patch.object(builtins, 'open', side_effect=source_open):
            result = planner.plan({'root': str(self.root), 'files': [str(selected)]})
        self.assertTrue(result['complete'], result)
        self.assertEqual({item['file'] for item in result['sources']}, {
            'first/second/third/selected.py', 'first/second/near_config.py', 'first/far_config.py', 'root_config.py'})
        self.assertEqual({item['operation'] for item in result['candidates']}, {'pathlib.Path.mkdir', 'outside_only.launch'})

    def test_local_backend_and_local_pathlib_shadow_are_never_external_entries(self):
        self.write('local_driver.py', 'def launch(target): target()\n')
        result = self.check('import local_driver\ndef callback(): pass\nlocal_driver.launch(target=callback)\n')
        self.assertEqual(result['candidates'], [])
        self.assertIn('local_driver.py', [item['file'] for item in result['sources']])
        self.write('pathlib.py', 'class Path:\n    def mkdir(self, **kw): pass\n')
        result = self.check('from pathlib import Path\nPath("data").mkdir(exist_ok=True)\n')
        self.assertEqual(result['candidates'], [])

    def test_namespace_package_is_local_and_its_submodule_is_scanned(self):
        self.write('neutral_namespace/driver.py', 'def launch(target): target()\n')
        result = self.check('from neutral_namespace import driver\ndef callback(): pass\ndriver.launch(callback)\n')
        self.assertEqual(result['candidates'], [])
        self.assertTrue(result['complete'], result)
        self.assertEqual({item['file'] for item in result['sources']}, {'sample.py', 'neutral_namespace/driver.py'})

    def test_rebinding_wildcards_and_alias_attribute_mutations_invalidate_evidence(self):
        cases = [
            'backend = object()\n',
            'from unrelated import *\n',
            'if flag:\n    backend = None\n',
            'del backend\n',
            'backend.launch = callback\n',
            'import neutral_backend as alias\nalias.launch = callback\n',
            'setattr(backend, "launch", callback)\n',
            'globals()["backend"] = None\n',
            'backend.__dict__["launch"] = callback\n',
            'match None:\n    case backend: pass\n',
            'match []:\n    case [*backend]: pass\n',
            'match {}:\n    case {**backend}: pass\n',
            'alias = backend\nalias.launch = callback\n',
        ]
        for body in cases:
            with self.subTest(body=body):
                result = self.check('import neutral_backend as backend\ndef callback(): pass\n' + body + 'backend.launch(callback)\n')
                self.assertEqual(result['candidates'], [])
        result = self.check('from pathlib import Path\nP = Path\nP.mkdir = replacement\nPath("x").mkdir(exist_ok=True)\n')
        self.assertEqual(result['candidates'], [])

    def test_deferred_function_local_rebinding_does_not_hide_module_evidence(self):
        result = self.check('import neutral_backend as backend\n'
                            'def callback():\n    backend = None\n    import unknown\n'
                            'backend.launch(callback)\n')
        self.assertEqual(len(result['candidates']), 1)

    def test_defaults_decorators_and_annotation_side_effects_are_never_executed(self):
        headers = ['def callback(value=side_effect()): pass',
                   'def callback(value=(backend := None)): pass',
                   '@decorator\ndef callback(): pass',
                   'def callback(value: side_effect()): pass',
                   'async def callback(): pass']
        for header in headers:
            with self.subTest(header=header):
                result = self.check('import neutral_backend as backend\n' + header + '\nbackend.launch(callback)\n')
                self.assertEqual(result['candidates'], [])
        result = self.check('from pathlib import Path\nx: (Path := replacement) = 1\nPath("data").mkdir(exist_ok=True)\n')
        self.assertEqual(result['candidates'], [])

    def test_unrelated_calls_and_defaults_preserve_independent_static_bindings(self):
        result = self.check('from pathlib import Path\nimport neutral_backend as backend\n'
                            'def helper(x=unknown_default()): pass\nvalue = unknown_call()\n'
                            'helper()\nPath("data").mkdir(exist_ok=True)\n'
                            'def callback(): pass\nbackend.launch(callback)\n')
        self.assertTrue(result['complete'], result)
        self.assertEqual([item['kind'] for item in result['candidates']], ['mkdir', 'entry-point'])

    def test_deep_but_valid_expressions_do_not_escape_the_json_failure_contract(self):
        result = self.check('VALUE = ' + '+'.join(['1'] * 1200) + '\n')
        self.assertTrue(result['complete'], result)
        self.assertEqual(result['candidates'], [])

    def test_nested_dynamic_helpers_constructors_and_result_used_calls_are_not_proposed(self):
        bodies = [
            'if enabled:\n    backend.launch(callback)',
            'for _ in values:\n    backend.launch(callback)',
            'result = backend.launch(callback)',
            'def helper():\n    backend.launch(callback)\nhelper()',
            'backend.Window(callback)',
            'getattr(backend, "launch")(callback)',
            'backend.launch(factory())',
            'backend.launch(callback, option=factory())',
            'backend.launch(**options)',
            'backend.launch(callback); backend.launch(callback)',
            'callback = lambda: None\nbackend.launch(callback)',
            'class Callback: pass\nbackend.launch(Callback)',
        ]
        for body in bodies:
            with self.subTest(body=body):
                result = self.check('import neutral_backend as backend\ndef callback(): pass\n' + body + '\n')
                self.assertEqual(result['candidates'], [])

    def test_ordinary_external_calculations_without_callback_are_not_entries(self):
        result = self.check('import math\nimport logging\nmath.sin(1)\nlogging.info("hello")\n')
        self.assertEqual(result['candidates'], [])

    def test_arbitrary_mkdir_receivers_and_non_idempotent_calls_are_not_proposed(self):
        for body in ['thing.mkdir(exist_ok=True)', 'Path("x").mkdir()',
                     'Path("x").mkdir(exist_ok=False)', 'Path("x").mkdir(exist_ok=enabled)',
                     'Path("x").mkdir(parents=factory(), exist_ok=True)',
                     'result = Path("x").mkdir(exist_ok=True)',
                     'Path = replacement\nPath("x").mkdir(exist_ok=True)',
                     'Path("x").resolve().mkdir(exist_ok=True)',
                     '(Path(__file__).parent / "data").resolve().mkdir(exist_ok=True)']:
            with self.subTest(body=body):
                self.assertEqual(self.check('from pathlib import Path\n' + body + '\n')['candidates'], [])

    def test_dynamic_directory_is_a_nonfatal_diagnostic_without_a_candidate(self):
        self.write('settings.py', 'DATA_DIR = unknown_helper()\n')
        result = self.check('from settings import DATA_DIR\nDATA_DIR.mkdir(parents=True, exist_ok=True)\n')
        self.assertTrue(result['complete'], result)
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['diagnostics'], [{'file': 'sample.py', 'line': 2, 'reason': 'dynamic-directory'}])

    def test_resource_validation_never_reads_or_stats_original_resources(self):
        existing = self.base / 'outside-parent' / 'private-data'
        existing.mkdir(parents=True)
        sentinel = existing / 'secret.txt'
        sentinel.write_text('unchanged', encoding='utf-8')
        source = 'from pathlib import Path\nPath(' + repr(str(existing)) + ').mkdir(exist_ok=True)\n'
        self.file.write_text(source, encoding='utf-8')
        original_open, original_lstat = builtins.open, os.lstat
        checked = []
        def source_open(value, *args, **kwargs):
            self.assertEqual(os.path.normcase(os.fspath(value)), os.path.normcase(str(self.file)))
            return original_open(value, *args, **kwargs)
        def source_lstat(value, *args, **kwargs):
            name = os.path.normcase(os.fspath(value))
            checked.append(name)
            self.assertFalse(planner.inside(name, str(existing)))
            self.assertFalse(planner.is_unc_or_device(name))
            return original_lstat(value, *args, **kwargs)
        with mock.patch.object(builtins, 'open', side_effect=source_open), \
                mock.patch.object(os, 'lstat', side_effect=source_lstat), \
                mock.patch.object(os.path, 'realpath', side_effect=AssertionError('realpath called')):
            result = planner.plan({'root': str(self.root), 'files': [str(self.file)]})
        self.assertTrue(result['complete'], result)
        self.assertEqual(result['candidates'][0]['resourceScope'], 'project-parent')
        self.assertEqual(sentinel.read_text(encoding='utf-8'), 'unchanged')
        self.assertTrue(checked)

    def test_unsafe_directory_spellings_are_rejected_before_normalization(self):
        paths = ['../escape', 'nested/../escape', 'bad.py', 'data/bad.py/inside',
                 'data/CON', 'data/trailing.', 'data/trailing ', 'data/colon:name']
        if os.name == 'nt':
            paths += ['C:relative', '/drive-relative', '//?/C:/device', '//server/IPC$/data']
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.check('from pathlib import Path\nPath(' + repr(path) + ').mkdir(exist_ok=True)\n')['candidates'], [])
        for expression in ['Path(__file__).parent', 'Path(__file__).parent.parent']:
            self.assertEqual(self.check('from pathlib import Path\n' + expression + '.mkdir(exist_ok=True)\n')['candidates'], [])

    @unittest.skipUnless(os.name == 'nt', 'native Windows drive and UNC identity')
    def test_external_drive_and_unc_are_purely_lexical_candidates(self):
        paths = [('Z:/planner-sentinel-absent/data', 'external-exact', 'z:/planner-sentinel-absent/data'),
                 ('//planner.invalid/share/data', 'unc-virtual', '//planner.invalid/share/data')]
        original_lstat = os.lstat
        for path, scope, identity in paths:
            with self.subTest(path=path):
                self.file.write_text('from pathlib import Path\nPath(' + repr(path) + ').mkdir(exist_ok=True)\n', encoding='utf-8')
                def guarded(value, *args, **kwargs):
                    spelling = os.fsdecode(value).replace('\\', '/').lower()
                    self.assertFalse(spelling.startswith('//') or spelling.startswith('z:'))
                    return original_lstat(value, *args, **kwargs)
                with mock.patch.object(os, 'lstat', side_effect=guarded), \
                        mock.patch.object(os.path, 'realpath', side_effect=AssertionError('realpath called')):
                    result = planner.plan({'root': str(self.root), 'files': [str(self.file)]})
                self.assertTrue(result['complete'], result)
                self.assertEqual(result['candidates'][0]['resourcePath'], identity)
                self.assertEqual(result['candidates'][0]['resourceScope'], scope)

    def test_unsafe_root_and_selected_files_are_rejected_without_remote_access(self):
        with mock.patch.object(os, 'lstat', side_effect=AssertionError('metadata called')):
            for root in ['//planner.invalid/share/project', 'relative']:
                result = planner.plan({'root': root, 'files': []})
                self.assertFalse(result['complete'])
                self.assertEqual(result['diagnostics'][0]['reason'], 'invalid-root')
        result = planner.plan({'root': str(self.root), 'files': [str(self.base / 'outside.py'), '//planner.invalid/share/x.py']})
        self.assertFalse(result['complete'])
        self.assertEqual(result['sources'], [])

    def test_source_link_and_junction_checks_stop_before_descendant_metadata(self):
        self.write('linked/entry.py', 'raise RuntimeError("never read")\n')
        link = os.path.normcase(str(self.root / 'linked'))
        original_lstat = os.lstat
        for kind, attributes in [(stat.S_IFLNK, 0), (stat.S_IFDIR, 1024)]:
            with self.subTest(kind=kind):
                def guarded(value, *args, **kwargs):
                    path = os.path.normcase(os.fspath(value))
                    self.assertFalse(path.startswith(link + os.sep), 'link descendant was touched')
                    if path == link:
                        return SimpleNamespace(st_mode=kind, st_file_attributes=attributes)
                    return original_lstat(value, *args, **kwargs)
                with mock.patch.object(os, 'lstat', side_effect=guarded), \
                        mock.patch.object(builtins, 'open', side_effect=AssertionError('source through link opened')):
                    result = planner.plan({'root': str(self.root), 'files': [str(self.root / 'linked' / 'entry.py')]})
                self.assertFalse(result['complete'])
                self.assertIn('source-link', [item['reason'] for item in result['diagnostics']])

    def test_local_import_link_is_never_traversed_or_treated_as_external(self):
        self.write('linked.py', '')
        original_lstat = os.lstat
        def guarded(value, *args, **kwargs):
            if os.path.normcase(os.fspath(value)) == os.path.normcase(str(self.root / 'linked.py')):
                return SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0)
            return original_lstat(value, *args, **kwargs)
        with mock.patch.object(os, 'lstat', side_effect=guarded):
            result = self.check('import linked\ndef callback(): pass\nlinked.launch(callback)\n')
        self.assertFalse(result['complete'])
        self.assertEqual(result['candidates'], [])

    def test_parse_read_size_and_scan_limits_are_explicit_incomplete_results(self):
        result = self.check('this is not valid Python !!!\n')
        self.assertFalse(result['complete'])
        self.assertEqual(result['diagnostics'][0]['reason'], 'source-syntax-error')
        result = planner.plan({'root': str(self.root), 'files': [str(self.root / 'missing.py')]})
        self.assertFalse(result['complete'])
        self.assertIn('source-unreadable', [item['reason'] for item in result['diagnostics']])
        with mock.patch.object(planner, 'MAX_SOURCE_BYTES', 10):
            result = self.check('VALUE = "source exceeds ten bytes"\n')
        self.assertFalse(result['complete'])
        self.assertEqual(result['diagnostics'][0]['reason'], 'source-too-large')
        with mock.patch.object(planner, 'MAX_AST_NODES', 2):
            result = self.check('VALUE = 1\n')
        self.assertFalse(result['complete'])
        self.assertEqual(result['diagnostics'][0]['reason'], 'source-ast-limit')

    def test_files_candidates_and_import_limits_never_silently_truncate(self):
        self.write('dependency.py', '')
        with mock.patch.object(planner, 'MAX_FILES', 1):
            result = self.check('import dependency\n')
        self.assertFalse(result['complete'])
        self.assertIn('file-limit', [item['reason'] for item in result['diagnostics']])
        with mock.patch.object(planner, 'MAX_CANDIDATES', 1):
            result = self.check('from pathlib import Path\nPath("a").mkdir(exist_ok=True)\nPath("b").mkdir(exist_ok=True)\n')
        self.assertFalse(result['complete'])
        self.assertEqual(len(result['candidates']), 1)
        self.assertIn('candidate-limit', [item['reason'] for item in result['diagnostics']])
        with mock.patch.object(planner, 'MAX_IMPORTS', 1):
            result = self.check('import math\nimport collections\n')
        self.assertFalse(result['complete'])
        self.assertIn('import-limit', [item['reason'] for item in result['diagnostics']])
        with mock.patch.object(planner, 'MAX_DIAGNOSTICS', 3):
            result = self.check('unknown.mkdir(exist_ok=True)\n' * 8)
        self.assertFalse(result['complete'])
        self.assertEqual(len(result['diagnostics']), 3)
        self.assertEqual(result['diagnostics'][-1]['reason'], 'diagnostic-limit')

    def test_unresolved_and_multiple_local_imports_are_not_external_entries(self):
        self.write('package/__init__.py', '')
        result = self.check('import package.missing\ndef callback(): pass\npackage.missing.launch(callback)\n')
        self.assertFalse(result['complete'])
        self.assertEqual(result['candidates'], [])
        self.write('driver.py', '')
        self.write('sub/driver.py', '')
        selected = self.write('sub/selected.py', 'import driver\ndef callback(): pass\ndriver.launch(callback)\n')
        result = planner.plan({'root': str(self.root), 'files': [str(selected)]})
        self.assertTrue(result['complete'], result)
        self.assertEqual({item['file'] for item in result['sources']}, {'sub/selected.py', 'sub/driver.py', 'driver.py'})
        self.assertEqual(result['candidates'], [])
        selected = self.write('sub/relative.py', 'from .missing import value\n')
        result = planner.plan({'root': str(self.root), 'files': [str(selected)]})
        self.assertFalse(result['complete'])
        self.assertIn('unresolved-local-import', [item['reason'] for item in result['diagnostics']])

    def test_cli_reads_one_request_and_outputs_one_machine_json_result(self):
        self.file.write_text('from pathlib import Path\nPath("data").mkdir(exist_ok=True)\n', encoding='utf-8')
        result = subprocess.run([sys.executable, str(Path(planner.__file__))], input=json.dumps({
            'root': str(self.root), 'files': [str(self.file)]}), text=True, capture_output=True, check=True)
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed['schemaVersion'], 'import-initialization-plan-v1')
        self.assertTrue(parsed['complete'], parsed)
        self.assertEqual(len(parsed['candidates']), 1)
        invalid = subprocess.run([sys.executable, str(Path(planner.__file__))], input='{invalid', text=True,
                                 capture_output=True, check=True)
        self.assertFalse(json.loads(invalid.stdout)['complete'])


if __name__ == '__main__':
    unittest.main()
