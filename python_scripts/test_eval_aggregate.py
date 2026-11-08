import ast
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from eval_aggregate import (
    DEFAULT_EVAL_SET,
    aggregate_batches,
    discover_batch_manifests,
    evaluate_batch_manifest,
    format_markdown,
    load_eval_set_spec_map,
    main,
)


class EvalSetAndAggregateTests(unittest.TestCase):
    def test_eval_set_v1_matches_eval_screening_sources_and_licenses(self):
        self.assertTrue(DEFAULT_EVAL_SET.is_file(), "eval/eval-set-v1.json must exist")
        eval_set = json.loads(DEFAULT_EVAL_SET.read_text(encoding="utf-8"))
        self.assertEqual(eval_set["schemaVersion"], "eval-set-v1")
        self.assertEqual(eval_set["version"], "eval-screening-v1")
        self.assertEqual(eval_set["num_ctx"], 8192)
        self.assertEqual(eval_set["totalFiles"], 7)
        self.assertEqual(eval_set["totalTargets"], 26)
        self.assertEqual(eval_set["specSummary"], {"withSpec": 18, "withoutSpec": 8})

        screening_dir = ROOT / "eval" / "eval_screening"
        targets_json = json.loads((screening_dir / "targets.json").read_text(encoding="utf-8"))
        self.assertEqual(eval_set["targets"], targets_json["targets"])

        licenses_md = (screening_dir / "LICENSES.md").read_text(encoding="utf-8")
        self.assertIn("Marcel Hellkamp", licenses_md)
        self.assertIn("Konsta Vesterinen", licenses_md)
        self.assertIn("Permission is hereby granted, free of charge", licenses_md)

        entries = eval_set["entries"]
        self.assertEqual(len(entries), 26)
        for fname, file_info in eval_set["files"].items():
            py_path = screening_dir / fname
            self.assertTrue(py_path.is_file(), f"Missing screening source {fname}")
            actual_sha = hashlib.sha256(py_path.read_bytes()).hexdigest()
            self.assertEqual(file_info["sha256"], actual_sha)

            tree = ast.parse(py_path.read_text(encoding="utf-8"))
            funcs = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
            for target_name in eval_set["targets"][fname]:
                self.assertIn(target_name, funcs)

        canonical_payload = json.dumps(
            {
                "files": {k: v["sha256"] for k, v in sorted(eval_set["files"].items())},
                "targets": eval_set["targets"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self.assertEqual(
            eval_set["contentHash"],
            hashlib.sha256(canonical_payload).hexdigest(),
        )

    def test_aggregates_repository_fixtures_and_excludes_cancelled_batch(self):
        fixture_root = ROOT / "test" / "fixtures" / "eval_screening"
        summary = aggregate_batches([fixture_root])

        self.assertEqual(summary["schemaVersion"], "eval-aggregate-v1")
        self.assertEqual(summary["totalBatches"], 3)
        self.assertEqual(summary["comparableCount"], 2)
        self.assertEqual(summary["excludedCount"], 1)

        comparable = summary["comparableBatches"]
        self.assertEqual([b["folder"] for b in comparable], ["gpt_oss20b", "ministral3_14b"])

        gpt = comparable[0]
        self.assertEqual(gpt["model"], "gpt-oss:20b")
        self.assertEqual(gpt["passed"], 1)
        self.assertEqual(gpt["retained"], 1)
        self.assertEqual(gpt["reviewBlocked"], 1)
        self.assertEqual(gpt["failed"], 0)
        self.assertEqual(gpt["executableTests"], 3)
        self.assertAlmostEqual(gpt["avgCoverage"], (80.0 + 100.0 + 100.0) / 3.0)
        self.assertEqual(gpt["mutationMeasuredCount"], 2)
        self.assertAlmostEqual(gpt["avgMutationScore"], 75.0)
        self.assertAlmostEqual(gpt["elapsedMinutes"], 10.0)
        self.assertEqual(gpt["modelRequests"], 23)
        self.assertEqual(gpt["outputTokens"], 28227)
        self.assertEqual(gpt["lengthTruncatedCount"], 8)
        self.assertEqual(gpt["lengthTruncationSource"], "role_events.jsonl")

        # Spec vs without-spec breakdown for gpt_oss20b
        self.assertEqual(gpt["specBreakdown"]["withSpec"]["total"], 2)
        self.assertEqual(gpt["specBreakdown"]["withSpec"]["retained"], 1)
        self.assertEqual(gpt["specBreakdown"]["withSpec"]["reviewBlocked"], 1)
        self.assertAlmostEqual(gpt["specBreakdown"]["withSpec"]["avgCoverage"], 90.0)
        self.assertEqual(gpt["specBreakdown"]["withoutSpec"]["total"], 1)
        self.assertEqual(gpt["specBreakdown"]["withoutSpec"]["passed"], 1)
        self.assertAlmostEqual(gpt["specBreakdown"]["withoutSpec"]["avgCoverage"], 100.0)

        ministral = comparable[1]
        self.assertEqual(ministral["model"], "ministral-3:14b")
        self.assertEqual(ministral["passed"], 0)
        self.assertEqual(ministral["retained"], 2)
        self.assertEqual(ministral["reviewBlocked"], 0)
        self.assertEqual(ministral["failed"], 1)
        self.assertEqual(ministral["executableTests"], 2)
        self.assertAlmostEqual(ministral["avgCoverage"], 80.0)
        self.assertEqual(ministral["mutationMeasuredCount"], 1)
        self.assertAlmostEqual(ministral["avgMutationScore"], 60.0)
        self.assertAlmostEqual(ministral["elapsedMinutes"], 5.0)
        self.assertEqual(ministral["modelRequests"], 18)
        self.assertEqual(ministral["outputTokens"], 4800)
        self.assertEqual(ministral["lengthTruncatedCount"], 0)

        excluded = summary["excludedBatches"]
        self.assertEqual(len(excluded), 1)
        cancelled = excluded[0]
        self.assertEqual(cancelled["folder"], "mistralnemo12b_2")
        self.assertEqual(cancelled["model"], "mistral-nemo:12b")
        self.assertFalse(cancelled["comparable"])
        self.assertIn("status=cancelled", cancelled["exclusionReasons"])
        self.assertIn("finishedTargets=2/3", cancelled["exclusionReasons"])
        self.assertIn("cancelled=1", cancelled["exclusionReasons"])
        self.assertIn("pending=1", cancelled["exclusionReasons"])

        md = format_markdown(summary)
        self.assertIn("## 模型比較總表（僅含已完成批次）", md)
        self.assertIn("## 被取消或未完成的批次（不列入比較）", md)
        self.assertIn("`mistralnemo12b_2`", md.split("## 被取消或未完成的批次（不列入比較）")[1])
        self.assertNotIn("`mistralnemo12b_2`", md.split("## 被取消或未完成的批次（不列入比較）")[0])

    def test_incomplete_batch_with_failed_status_is_still_excluded_from_comparison(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            partial_dir = root / "partial_model"
            partial_dir.mkdir()
            manifest = {
                "batchId": "partial-1",
                "startedAt": "2026-11-08T00:00:00Z",
                "finishedAt": "2026-11-08T00:05:00Z",
                "status": "failed",
                "model": "phi4:14b",
                "expectedTargets": 4,
                "finishedTargets": 2,
                "attemptedTargets": 2,
                "statusCounts": {"passed": 2, "pending": 2},
                "targets": [
                    {"id": 0, "file": "bmi.py", "target": "calculate_bmi", "state": "finished", "terminalStatus": "passed"},
                    {"id": 1, "file": "bottle_utils.py", "target": "tob", "state": "finished", "terminalStatus": "passed"},
                    {"id": 2, "file": "bottle_utils.py", "target": "touni", "state": "pending"},
                    {"id": 3, "file": "bottle_utils.py", "target": "html_escape", "state": "pending"},
                ],
            }
            (partial_dir / "batch_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

            summary = aggregate_batches([root])
            self.assertEqual(summary["comparableCount"], 0)
            self.assertEqual(summary["excludedCount"], 1)
            reasons = summary["excludedBatches"][0]["exclusionReasons"]
            self.assertIn("finishedTargets=2/4", reasons)
            self.assertIn("pending=2", reasons)

    def test_cli_writes_markdown_and_json_outputs(self):
        fixture_root = ROOT / "test" / "fixtures" / "eval_screening"
        with tempfile.TemporaryDirectory() as tmp:
            out_md = Path(tmp) / "report.md"
            out_json = Path(tmp) / "report.json"

            rc_md = main([str(fixture_root), "--output", str(out_md)])
            self.assertEqual(rc_md, 0)
            self.assertIn("模型篩選評估彙總報告", out_md.read_text(encoding="utf-8"))

            rc_json = main([str(fixture_root), "--format", "json", "--output", str(out_json)])
            self.assertEqual(rc_json, 0)
            parsed = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertEqual(parsed["comparableCount"], 2)
            self.assertEqual(parsed["excludedCount"], 1)


if __name__ == "__main__":
    unittest.main()
