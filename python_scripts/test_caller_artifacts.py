"""Runner-generated tests must never feed back into application caller discovery."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from ast_caller_finder import find_call_sites


class CallerArtifactTests(unittest.TestCase):
    def test_round_artifacts_do_not_become_caller_or_dependency_facts(self):
        from dependency_inventory import inventory
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'sample.py'
            target.write_text('def target(value):\n    return value\n', encoding='utf-8')
            (root / 'caller.py').write_text('from sample import target\ntarget(2)\n', encoding='utf-8')
            data = root / 'generated' / 'loop' / '_run'
            data.mkdir(parents=True)
            (data / 'layout.json').write_text(json.dumps({'schemaVersion': 'function-loops-v1'}))
            (data / 'run_manifest.json').write_text(json.dumps({'schemaVersion': 2, 'promptVersion': 'role-contracts-v7',
                                                              'runId': 'generated', 'sourceHash': 'snapshot'}))
            round_folder = data.parent / '1'
            round_folder.mkdir()
            (round_folder / 'candidate.py').write_text('import unwanted_generated_dependency\nfrom sample import target\ntarget(999)\n')
            self.assertEqual([call['trace_args'] for call in find_call_sites('target', str(root), str(target))], [[2]])
            scanned = inventory(root)
            self.assertEqual(scanned['filesScanned'], 2)
            self.assertNotIn('unwanted_generated_dependency', str(scanned))

    def test_versioned_outputs_are_excluded_without_guessing_directory_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'sample.py'
            target.write_text('def target(value):\n    return value + 1\n', encoding='utf-8')
            (root / 'caller.py').write_text('from sample import target\ntarget(2)\n', encoding='utf-8')
            generated = root / 'arbitrary-name'
            generated.mkdir()
            (generated / 'run_manifest.json').write_text(json.dumps({
                'schemaVersion': 2, 'promptVersion': 'role-contracts-v7',
                'runId': 'generated', 'sourceHash': 'snapshot'
            }), encoding='utf-8')
            (generated / 'candidate.py').write_text('from sample import target\ntarget(999)\n', encoding='utf-8')
            calls = find_call_sites('target', str(root), str(target))
            self.assertEqual([call['trace_args'] for call in calls], [[2]])
            # An unrelated application's manifest is not a reason to discard its code.
            (generated / 'run_manifest.json').write_text('{"schemaVersion": 99}', encoding='utf-8')
            self.assertEqual(len(find_call_sites('target', str(root), str(target))), 2)


if __name__ == '__main__':
    unittest.main()
