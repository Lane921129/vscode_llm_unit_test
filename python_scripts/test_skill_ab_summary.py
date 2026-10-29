import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('skill_ab_summary', Path(__file__).resolve().parents[1] / 'test/skill_ab_summary.py')
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class SkillAbSummaryTests(unittest.TestCase):
    def test_pending_stays_pending_and_no_quality_claim_is_created(self):
        with tempfile.TemporaryDirectory() as root:
            dirs = []
            for identity in ['A', 'B']:
                folder = Path(root) / identity
                folder.mkdir()
                data = {'batchId': identity, 'model': 'same', 'validationMode': 'full', 'expectedTargets': 5,
                        'attemptedTargets': 1, 'finishedTargets': 1, 'statusCounts': {'failed': 1, 'pending': 4},
                        'scope': {'selectedFiles': ['subject.py']}}
                (folder / 'batch_manifest.json').write_text(json.dumps(data), encoding='utf-8')
                dirs.append(str(folder))
            result = summary.summarize([dirs[0]], [dirs[1]])
            self.assertEqual(result['A']['statusCounts'], {'failed': 1, 'pending': 4})
            self.assertFalse(result['qualityEvidenceRevalidated'])
            self.assertTrue(all(result['comparisonFacts'].values()))
            with self.assertRaises(ValueError):
                summary.summarize([dirs[0]], [dirs[0]])
            with self.assertRaises(ValueError):
                summary.group([dirs[0], dirs[0]])
            data['expectedTargets'] = 6
            (Path(dirs[1]) / 'batch_manifest.json').write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(ValueError):
                summary.group([dirs[1]])


if __name__ == '__main__':
    unittest.main()
