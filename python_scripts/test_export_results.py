import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from python_scripts import export_results as tool
from python_scripts.result_layout import data_directory, local_artifact


class ResultExportTests(unittest.TestCase):
    def test_result_layout_rejects_link_metadata_before_reading_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / 'loop' / '_run'
            data.mkdir(parents=True)
            layout = data / 'layout.json'
            layout.write_text('{"schemaVersion":"function-loops-v1"}', encoding='utf-8')
            real_lstat = Path.lstat
            for mode, attributes in ((stat.S_IFLNK, 0), (stat.S_IFREG, 0x400)):
                with self.subTest(mode=mode, attributes=attributes):
                    def lstat(path, *args, **kwargs):
                        if path == layout:
                            return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
                        return real_lstat(path, *args, **kwargs)
                    with patch.object(Path, 'lstat', lstat), patch.object(Path, 'read_text') as read:
                        with self.assertRaisesRegex(ValueError, 'invalid result layout'):
                            data_directory(root)
                        read.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows 8.3 aliases are platform-specific')
    def test_result_layout_accepts_real_short_and_long_paths_without_changing_artifact_identity(self):
        import ctypes
        with tempfile.TemporaryDirectory(prefix='ResultLayoutLongDirectory-') as temporary:
            root = Path(temporary).resolve()
            size = ctypes.windll.kernel32.GetShortPathNameW(str(root), None, 0)
            if not size:
                self.skipTest('The temporary volume does not expose 8.3 aliases')
            buffer = ctypes.create_unicode_buffer(size)
            if not ctypes.windll.kernel32.GetShortPathNameW(str(root), buffer, size):
                self.skipTest('The temporary volume does not expose 8.3 aliases')
            short = Path(buffer.value)
            if str(short).casefold() == str(root).casefold():
                self.skipTest('8.3 names are disabled on the temporary volume')
            self.assertTrue(os.path.samefile(root, short))
            data = root / 'loop' / '_run'
            data.mkdir(parents=True)
            (data / 'layout.json').write_text('{"schemaVersion":"function-loops-v1"}', encoding='utf-8')
            round_folder = root / 'loop' / '1'
            round_folder.mkdir()
            expected = b'# retained exact artifact\n'
            (round_folder / 'loop1_test.py').write_bytes(expected)
            (data / 'immutable_test.py').write_bytes(expected)
            for spelling in (root, short):
                with self.subTest(spelling='long' if spelling == root else 'short'):
                    self.assertTrue(os.path.samefile(data_directory(spelling), data))
                    self.assertEqual(local_artifact(spelling, 'loop1_test.py').read_bytes(), expected)
                    self.assertEqual(local_artifact(spelling, 'immutable_test.py').read_bytes(), expected)
                    self.assertFalse(local_artifact(spelling, 'loop2_test.py').exists())

    def test_result_layout_keeps_basename_and_link_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / 'loop' / '_run'
            data.mkdir(parents=True)
            (data / 'layout.json').write_text('{"schemaVersion":"function-loops-v1"}', encoding='utf-8')
            outside = root / 'outside.py'
            outside.write_text('# different artifact\n', encoding='utf-8')
            for name in ('../outside.py', '..\\outside.py', str(outside), 'C:outside.py'):
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'invalid artifact name'):
                    local_artifact(root, name)
            linked = data / 'linked.py'
            try:
                linked.symlink_to(outside)
            except OSError:
                self.skipTest('Creating a symbolic link is unavailable')
            with self.assertRaisesRegex(ValueError, 'invalid artifact path'):
                local_artifact(root, 'linked.py')
            linked.unlink()
            layout = data / 'layout.json'
            external_layout = root / 'layout.json'
            layout.rename(external_layout)
            layout.symlink_to(external_layout)
            with self.assertRaisesRegex(ValueError, 'invalid result layout'):
                data_directory(root)

    @unittest.skipUnless(os.name == 'nt', 'Windows junctions are platform-specific')
    def test_result_layout_rejects_directory_junction_even_when_artifact_is_regular(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            actual = root / 'actual'
            actual.mkdir()
            (actual / 'layout.json').write_text('{"schemaVersion":"function-loops-v1"}', encoding='utf-8')
            (actual / 'candidate.py').write_text('# exact bytes do not authorize a junction\n', encoding='utf-8')
            loop = root / 'loop'
            loop.mkdir()
            linked = loop / '_run'
            result = subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(linked), str(actual)],
                                    capture_output=True, check=False)
            if result.returncode:
                self.skipTest('Creating a directory junction is unavailable')
            try:
                with self.assertRaisesRegex(ValueError, 'invalid result layout'):
                    data_directory(root)
                with self.assertRaisesRegex(ValueError, 'invalid result layout'):
                    local_artifact(linked, 'candidate.py')
            finally:
                linked.rmdir()
            self.assertTrue((actual / 'candidate.py').is_file())

    def test_skipped_workflows_are_not_missing_final_reports_but_real_targets_still_require_one(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            targets = []
            for index, status in enumerate(['dummy-skipped', 'stub-skipped', 'stub-smoke-generated', 'failed', 'passed']):
                folder = root / str(index)
                folder.mkdir()
                (folder / 'workflow_report.md').write_text('audit')
                targets.append({'file': 'sample.py', 'target': str(index), 'terminalStatus': status,
                                'reportDirectory': str(index)})
            (root / 'batch_manifest.json').write_text(json.dumps({'targets': targets}))
            self.assertEqual([item['target'] for item in tool.missing_reports(root)], ['3', '4'])
            data = root / '0/loop/_run'
            data.mkdir(parents=True)
            (data / 'layout.json').write_text(json.dumps({'schemaVersion': 'function-loops-v1'}))
            (root / '0/workflow_report.md').rename(data / 'workflow_report.md')
            self.assertEqual([item['target'] for item in tool.missing_reports(root)], ['3', '4'])
            (data / 'workflow_report.md').unlink()
            self.assertEqual([item['target'] for item in tool.missing_reports(root)], ['0', '3', '4'])

    def test_zip_preserves_relative_paths_bytes_and_reports_missing_source_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = tool.disk_path(parent / ('long_outer_name_' * 6))
            prefix = '/'.join(['nested_source_' * 3] * 3 + ['車輛管理測試', 'target'])
            nested = root / prefix
            nested.mkdir(parents=True)
            data = {'batch_manifest.json': json.dumps({'targets': [
                {'file': 'module.py', 'target': 'target', 'reportDirectory': prefix},
                {'file': 'module.py', 'target': 'lost', 'reportDirectory': 'lost'}]}).encode(),
                prefix + '/final_report.md': '# 原始報告\n'.encode(),
                prefix + '/coverage_4a582379-61d9-4d74-9175-ac8ea9f00ed6.json': b'{"testRunId":"full-original-id"}'}
            self.assertGreater(len(str(nested / 'final_report.md')), 260)
            for name, content in data.items():
                (root / name).write_bytes(content)
            output = parent / 'r.zip'
            result = tool.export_results(root, output)
            self.assertEqual(result['files'], 3)
            self.assertEqual(len(result['missingReports']), 1)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()), set(data) | {'_transfer.json'})
                index = json.loads(archive.read('_transfer.json'))
                for record in index['entries']:
                    self.assertEqual(archive.read(record['path']), data[record['path']])
                    self.assertEqual(record['sha256'], hashlib.sha256(data[record['path']]).hexdigest())
                    self.assertEqual((root / record['path']).read_bytes(), data[record['path']])
            before = output.read_bytes()
            with self.assertRaises(FileExistsError):
                tool.export_results(root, output)
            self.assertEqual(output.read_bytes(), before)
            with self.assertRaisesRegex(ValueError, 'outside'):
                tool.export_results(root, root / 'nested.zip')

    def test_changing_inventory_aborts_and_removes_only_the_new_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / 'source'
            root.mkdir()
            (root / 'report.md').write_text('original')
            original_inventory = tool.inventory
            calls = 0

            def changed_inventory(folder):
                nonlocal calls
                calls += 1
                if calls == 2:
                    (folder / 'added.md').write_text('new')
                return original_inventory(folder)

            output = parent / 'r.zip'
            with patch.object(tool, 'inventory', changed_inventory):
                with self.assertRaisesRegex(ValueError, 'changed'):
                    tool.export_results(root, output)
            self.assertFalse(output.exists())
            self.assertEqual((root / 'report.md').read_text(), 'original')


if __name__ == '__main__':
    unittest.main()
