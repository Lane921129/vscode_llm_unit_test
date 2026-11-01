import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('skill_ab_summary', Path(__file__).resolve().parents[1] / 'test/skill_ab_summary.py')
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class SkillAbSummaryTests(unittest.TestCase):
    def test_legacy_manifest_without_capability_totals_stays_readable(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / 'legacy'
            folder.mkdir()
            data = {'batchId': 'legacy', 'model': 'same', 'validationMode': 'full', 'expectedTargets': 1,
                    'attemptedTargets': 0, 'finishedTargets': 0, 'statusCounts': {'pending': 1}}
            (folder / 'batch_manifest.json').write_text(json.dumps(data), encoding='utf-8')
            result = summary.group([str(folder)])
            self.assertIsNone(result['modelCapabilitySummary'])
            self.assertEqual(result['capabilitySummaryRuns'], 0)

    def test_pending_stays_pending_and_no_quality_claim_is_created(self):
        with tempfile.TemporaryDirectory() as root:
            dirs = []
            for identity in ['A', 'B']:
                folder = Path(root) / identity
                folder.mkdir()
                data = {'batchId': identity, 'model': 'same', 'validationMode': 'full', 'expectedTargets': 5,
                        'attemptedTargets': 1, 'finishedTargets': 1, 'statusCounts': {'failed': 1, 'pending': 4},
                        'scope': {'selectedFiles': ['subject.py']}, 'modelCapabilitySummary': {
                            'version': 'model-capability-summary-v1', 'completedTransports': 1,
                            'timedOutTransports': 0, 'lengthStoppedTransports': 0, 'outputTokens': 20, 'outputEvalMs': 500}}
                (folder / 'batch_manifest.json').write_text(json.dumps(data), encoding='utf-8')
                dirs.append(str(folder))
            result = summary.summarize([dirs[0]], [dirs[1]])
            self.assertEqual(result['A']['statusCounts'], {'failed': 1, 'pending': 4})
            self.assertFalse(result['qualityEvidenceRevalidated'])
            self.assertTrue(all(result['comparisonFacts'].values()))
            self.assertEqual(result['schemaVersion'], 'skill-ab-summary-v2')
            self.assertEqual(result['A']['modelCapabilitySummary']['outputTokens'], 20)
            self.assertIn('transport observations', result['note'])
            with self.assertRaises(ValueError):
                summary.summarize([dirs[0]], [dirs[0]])
            with self.assertRaises(ValueError):
                summary.group([dirs[0], dirs[0]])
            data['expectedTargets'] = 6
            (Path(dirs[1]) / 'batch_manifest.json').write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(ValueError):
                summary.group([dirs[1]])
            data['expectedTargets'] = 5
            data['modelCapabilitySummary']['outputTokens'] = -1
            (Path(dirs[1]) / 'batch_manifest.json').write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'invalid-model-capability-summary'):
                summary.group([dirs[1]])


if __name__ == '__main__':
    unittest.main()
