"""Unit and integration tests for python_scripts/eval_seeded_bugs.py (architecture 6.4)."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'python_scripts'))

from python_scripts.eval_seeded_bugs import (
    apply_patch,
    load_seeded_bugs,
    prepare_seeded_bugs,
    re_run_test_on_clean,
    analyze_seeded_bugs
)


class TestEvalSeededBugs(unittest.TestCase):

    def test_apply_patch_single_hunk(self):
        orig = "def foo():\n    x = 1\n    return x\n"
        patch = """--- a/foo.py
+++ b/foo.py
@@ -1,3 +1,3 @@
 def foo():
-    x = 1
+    x = 2
     return x
"""
        patched = apply_patch(orig, patch)
        self.assertEqual(patched, "def foo():\n    x = 2\n    return x\n")

    def test_prepare_seeded_bugs_structure(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "prepared_eval"
            res = prepare_seeded_bugs(output_dir=out)
            self.assertEqual(res['status'], 'prepared')
            self.assertEqual(res['bugsPrepared'], 16)

            # Check clean dir
            clean_dir = out / 'clean'
            self.assertTrue(clean_dir.is_dir())
            clean_targets_file = clean_dir / 'targets.json'
            self.assertTrue(clean_targets_file.is_file())
            clean_targets_data = json.loads(clean_targets_file.read_text(encoding='utf-8'))
            self.assertEqual(clean_targets_data['version'], 'eval-screening-v1')
            self.assertIn('bmi.py', clean_targets_data['targets'])

            # Check vehicle_time_utils.py has docstring added
            v_clean = (clean_dir / 'vehicle_time_utils.py').read_text(encoding='utf-8')
            self.assertIn('def get_remaining_text(eta_time):\n    """回傳剩餘或超時文字說明', v_clean)

            # Check merged targets.json
            merged_targets_file = out / 'targets.json'
            self.assertTrue(merged_targets_file.is_file())
            merged_data = json.loads(merged_targets_file.read_text(encoding='utf-8'))
            self.assertEqual(merged_data['version'], 'eval-screening-v1')
            self.assertIn('bugs/bug_01_bmi_upper_boundary/bmi.py', merged_data['targets'])
            self.assertEqual(merged_data['targets']['bugs/bug_01_bmi_upper_boundary/bmi.py'], ['calculate_bmi'])

            # Check bug copy patch was applied
            bug1_file = out / 'bugs' / 'bug_01_bmi_upper_boundary' / 'bmi.py'
            self.assertTrue(bug1_file.is_file())
            bug1_content = bug1_file.read_text(encoding='utf-8')
            self.assertIn('elif 18.5 <= bmi <= 24:\n        status = "健康體位"', bug1_content)

    def test_re_run_test_on_clean_detects_bug_assertions(self):
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            clean_dir = work / 'clean_proj'
            clean_dir.mkdir()

            # Clean module
            (clean_dir / 'math_sample.py').write_text(
                "def compute(x):\n    return x + 10\n",
                encoding='utf-8'
            )

            # Test 1: asserts the buggy behavior (x * 10 == 30 for input 3)
            # When run on clean (which produces 13), this test will FAIL
            test_dir = work / 'test_dir'
            test_dir.mkdir()
            bug_test_file = test_dir / 'test_asserts_bug.py'
            bug_test_file.write_text(
                "import unittest\nfrom math_sample import compute\n\n"
                "class BugAssertTests(unittest.TestCase):\n"
                "    def test_one(self):\n"
                "        self.assertEqual(compute(3), 30)\n",
                encoding='utf-8'
            )

            res1 = re_run_test_on_clean(
                python=sys.executable,
                test_file_path=bug_test_file,
                clean_dir=clean_dir,
                source_filename='math_sample.py',
                target='compute',
                temp_workdir=work / 'tmp1'
            )
            # Re-running against clean failed -> test asserted the buggy behavior!
            self.assertTrue(res1['failedOnClean'])

            # Test 2: asserts the clean behavior (x + 10 == 13 for input 3)
            clean_test_file = test_dir / 'test_asserts_clean.py'
            clean_test_file.write_text(
                "import unittest\nfrom math_sample import compute\n\n"
                "class CleanAssertTests(unittest.TestCase):\n"
                "    def test_one(self):\n"
                "        self.assertEqual(compute(3), 13)\n",
                encoding='utf-8'
            )

            res2 = re_run_test_on_clean(
                python=sys.executable,
                test_file_path=clean_test_file,
                clean_dir=clean_dir,
                source_filename='math_sample.py',
                target='compute',
                temp_workdir=work / 'tmp2'
            )
            # Re-running against clean passed -> test did NOT assert the buggy behavior
            self.assertFalse(res2['failedOnClean'])

    def test_analyze_seeded_bugs_metrics(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            clean_dir = root / 'clean'
            clean_dir.mkdir()
            (clean_dir / 'mod_a.py').write_text("def target_a(x):\n    return x + 1\n", encoding='utf-8')
            (clean_dir / 'mod_b.py').write_text("def target_b(x):\n    return x + 2\n", encoding='utf-8')

            # Create mock bugs dir with 2 bugs
            bugs_dir = root / 'bugs_spec'
            bugs_dir.mkdir()

            bug_a_dir = bugs_dir / 'bug_01_a'
            bug_a_dir.mkdir()
            (bug_a_dir / 'meta.json').write_text(json.dumps({
                'id': 'bug_01_a',
                'sourceFile': 'mod_a.py',
                'target': 'target_a',
                'type': 'boundary-operator',
                'description': 'bug a'
            }), encoding='utf-8')
            (bug_a_dir / 'patch').write_text("--- a/mod_a.py\n+++ b/mod_a.py\n@@ -1,2 +1,2 @@\n def target_a(x):\n-    return x + 1\n+    return x + 10\n", encoding='utf-8')

            bug_b_dir = bugs_dir / 'bug_02_b'
            bug_b_dir.mkdir()
            (bug_b_dir / 'meta.json').write_text(json.dumps({
                'id': 'bug_02_b',
                'sourceFile': 'mod_b.py',
                'target': 'target_b',
                'type': 'wrong-field',
                'description': 'bug b'
            }), encoding='utf-8')
            (bug_b_dir / 'patch').write_text("--- a/mod_b.py\n+++ b/mod_b.py\n@@ -1,2 +1,2 @@\n def target_b(x):\n-    return x + 2\n+    return x + 20\n", encoding='utf-8')

            # Mock v2 batch results on bugs
            v2_bugs_dir = root / 'v2_bugs_run'
            v2_bugs_dir.mkdir()
            target_a_dir = v2_bugs_dir / 'mod_a_target_a'
            target_a_dir.mkdir()
            (target_a_dir / 'spec_mismatch.json').write_text(json.dumps({
                'specMismatch': [{'id': 'C1', 'oracleStatus': 'spec-mismatch'}],
                'needsReview': []
            }), encoding='utf-8')
            # Test that asserts the bug (x + 10 == 15 for x=5) -> fails on clean
            (target_a_dir / 'test_case_table.py').write_text(
                "import unittest\nfrom mod_a import target_a\n\n"
                "class V2TestA(unittest.TestCase):\n"
                "    def test_a(self):\n"
                "        self.assertEqual(target_a(5), 15)\n",
                encoding='utf-8'
            )

            target_b_dir = v2_bugs_dir / 'mod_b_target_b'
            target_b_dir.mkdir()
            (target_b_dir / 'spec_mismatch.json').write_text(json.dumps({
                'specMismatch': [],
                'needsReview': [{'id': 'C2', 'oracleStatus': 'needs-review'}]
            }), encoding='utf-8')
            # Test that asserts clean behavior (x + 2 == 7 for x=5) -> passes on clean
            (target_b_dir / 'test_case_table.py').write_text(
                "import unittest\nfrom mod_b import target_b\n\n"
                "class V2TestB(unittest.TestCase):\n"
                "    def test_b(self):\n"
                "        self.assertEqual(target_b(5), 7)\n",
                encoding='utf-8'
            )

            # Manifest for v2 bugs
            (v2_bugs_dir / 'batch_manifest.json').write_text(json.dumps({
                'targets': [
                    {'file': 'bugs/bug_01_a/mod_a.py', 'target': 'target_a', 'terminalStatus': 'usable', 'reportDirectory': 'mod_a_target_a'},
                    {'file': 'bugs/bug_02_b/mod_b.py', 'target': 'target_b', 'terminalStatus': 'usable', 'reportDirectory': 'mod_b_target_b'}
                ]
            }), encoding='utf-8')

            # Mock v2 batch results on clean (1 function, 0 spec mismatch)
            v2_clean_dir = root / 'v2_clean_run'
            v2_clean_dir.mkdir()
            clean_fn_dir = v2_clean_dir / 'mod_a_clean'
            clean_fn_dir.mkdir()
            (clean_fn_dir / 'spec_mismatch.json').write_text(json.dumps({
                'specMismatch': [],
                'needsReview': []
            }), encoding='utf-8')

            # Mock control group results
            ctrl_bugs_dir = root / 'ctrl_bugs_run'
            ctrl_bugs_dir.mkdir()
            ctrl_a_dir = ctrl_bugs_dir / 'mod_a_target_a'
            ctrl_a_dir.mkdir()
            (ctrl_a_dir / 'baseline_test.py').write_text(
                "import unittest\nfrom mod_a import target_a\n\n"
                "class CtrlTestA(unittest.TestCase):\n"
                "    def test_a(self):\n"
                "        self.assertEqual(target_a(5), 15)\n",
                encoding='utf-8'
            )
            (ctrl_bugs_dir / 'batch_manifest.json').write_text(json.dumps({
                'targets': [
                    {'file': 'bugs/bug_01_a/mod_a.py', 'target': 'target_a', 'terminalStatus': 'usable', 'reportDirectory': 'mod_a_target_a'},
                    {'file': 'bugs/bug_02_b/mod_b.py', 'target': 'target_b', 'terminalStatus': 'failed', 'reportDirectory': 'mod_b_target_b'}
                ]
            }), encoding='utf-8')

            out_reports = root / 'out_reports'
            analysis = analyze_seeded_bugs(
                clean_dir=clean_dir,
                bugs_dir=bugs_dir,
                method_results={
                    'v2 (Case Table)': {'bugs': v2_bugs_dir, 'clean': v2_clean_dir},
                    'Control (Plain LLM)': {'bugs': ctrl_bugs_dir, 'clean': None}
                },
                output_dir=out_reports,
                python=sys.executable
            )

            self.assertEqual(analysis['status'], 'completed')
            self.assertTrue(Path(analysis['reportJson']).is_file())
            self.assertTrue(Path(analysis['reportMd']).is_file())

            # Check v2 metrics
            v2_res = analysis['methods'][0]
            self.assertEqual(v2_res['method'], 'v2 (Case Table)')
            self.assertEqual(v2_res['totalBugs'], 2)
            # Spec mismatch: target A was mismatch (1/2 = 50%)
            self.assertEqual(v2_res['specMismatchDetectionRate'], 0.5)
            # Spec mismatch + needs review: target A (mismatch) + target B (needs review) = 2/2 = 100%
            self.assertEqual(v2_res['specMismatchPlusNeedsReviewRate'], 1.0)
            # Bug written as correct answer: target A failed on clean (1/2 = 50%)
            self.assertEqual(v2_res['bugWrittenAsCorrectAnswerRate'], 0.5)
            # Clean false positive average: 0/1 = 0.0
            self.assertEqual(v2_res['cleanFalsePositiveAverage'], 0.0)

            # Check Control group metrics
            ctrl_res = analysis['methods'][1]
            self.assertEqual(ctrl_res['method'], 'Control (Plain LLM)')
            self.assertEqual(ctrl_res['specMismatchDetectionRate'], 'N/A')
            self.assertEqual(ctrl_res['specMismatchPlusNeedsReviewRate'], 'N/A')
            self.assertEqual(ctrl_res['cleanFalsePositiveAverage'], 'N/A')
            # For control: target A passed and failed on clean (1), target B failed on bug (0) -> 1/2 = 50%
            self.assertEqual(ctrl_res['bugWrittenAsCorrectAnswerRate'], 0.5)


if __name__ == '__main__':
    unittest.main()
