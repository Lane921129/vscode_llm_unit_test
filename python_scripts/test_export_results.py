import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from python_scripts import export_results as tool


class ResultExportTests(unittest.TestCase):
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
