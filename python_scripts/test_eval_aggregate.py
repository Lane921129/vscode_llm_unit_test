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



class ThreeGroupTests(unittest.TestCase):
    """v1, v2 (with and without recorded role events) and the plain-llm control group side by side."""

    def setUp(self):
        groups = ROOT / "test" / "fixtures" / "eval_three_groups"
        self.paths = [ROOT / "test" / "fixtures" / "eval_screening" / "gpt_oss20b" / "batch_manifest.json",
                      groups / "v2_case_table" / "batch_manifest.json",
                      groups / "v2_trial_placeholder" / "batch_manifest.json",
                      groups / "plain_llm" / "batch_manifest.json"]
        self.summary = aggregate_batches([str(path) for path in self.paths], eval_set_path=None)
        self.by_folder = {item["folder"]: item for item in self.summary["comparableBatches"]}

    def test_all_three_methods_are_comparable_groups(self):
        self.assertEqual({folder: item["method"] for folder, item in self.by_folder.items()},
                         {"gpt_oss20b": "v1", "v2_case_table": "v2-case-table", "v2_trial_placeholder": "v2-case-table",
                          "plain_llm": "plain-llm"})
        v1 = self.by_folder["gpt_oss20b"]
        self.assertEqual((v1["usableRowRatio"], v1["specMismatchCount"], v1["needsReviewCount"]), (None, None, None))
        self.assertEqual(v1["outputTokens"], 28227, "v1 numbers are unchanged")

    def test_v2_reads_tier_mutation_coverage_rows_and_spec_counts_from_v2_result(self):
        v2 = self.by_folder["v2_case_table"]
        self.assertEqual((v2["retained"], v2["failed"]), (1, 1))
        self.assertEqual(v2["avgMutationScore"], 65.625)
        self.assertEqual(v2["avgCoverage"], 90.0)
        self.assertEqual(v2["v2Rows"], {"testPassed": 3, "total": 8})
        self.assertAlmostEqual(v2["usableRowRatio"], 3 / 8)
        self.assertEqual((v2["specMismatchCount"], v2["needsReviewCount"]), (1, 1))
        self.assertEqual(v2["outputTokens"], 420, "summed from v1-format transport timing events")
        self.assertEqual(v2["lengthTruncatedCount"], 1)
        self.assertEqual(v2["roleReplySummary"]["byRole"]["analyst-scenario"], {"requested": 2, "completed": 1, "error": 1})
        self.assertEqual(v2["roleReplySummary"]["byRole"]["analyst-spec"], {"requested": 1, "completed": 1, "error": 0})

    def test_placeholder_role_events_show_tokens_as_not_recorded_never_zero(self):
        trial = self.by_folder["v2_trial_placeholder"]
        self.assertFalse(trial["tokensRecorded"])
        self.assertIsNone(trial["outputTokens"])
        self.assertIsNone(trial["lengthTruncatedCount"])
        self.assertEqual(trial["modelRequests"], 2)
        self.assertEqual(trial["v2Rows"], {"testPassed": 4, "total": 4})
        md = format_markdown(self.summary)
        row = next(line for line in md.splitlines() if "`v2_trial_placeholder`" in line)
        header = next(line for line in md.splitlines() if line.startswith("| 模型 |"))
        columns = [cell.strip() for cell in header.strip("|").split("|")]
        cells = dict(zip(columns, [cell.strip() for cell in row.strip("|").split("|")]))
        self.assertEqual((cells["輸出 tokens"], cells["輸出被截斷"]), ("未記錄", "未記錄"))
        self.assertEqual((cells["規格不符數"], cells["needs-review 數"]), ("0", "0"), "row counts are recorded, so 0 is real")

    def test_control_group_and_markdown_columns(self):
        plain = self.by_folder["plain_llm"]
        self.assertEqual((plain["retained"], plain["failed"], plain["expectedTargets"]), (1, 1, 2))
        self.assertEqual(plain["avgMutationScore"], 40.0)
        self.assertEqual(plain["avgCoverage"], 50.0)
        self.assertEqual(plain["outputTokens"], 250)
        md = format_markdown(self.summary)
        self.assertIn("| 模型 | 方法 | 資料夾 |", md)
        self.assertIn("| 可用列比例 | 規格不符數 | needs-review 數 |", md)
        v2_row = next(line for line in md.splitlines() if "`v2_case_table`" in line)
        self.assertIn("| 3／8（37.5%） | 1 | 1 |", v2_row)
        plain_row = next(line for line in md.splitlines() if "`plain_llm`" in line)
        self.assertTrue(plain_row.startswith("| gpt-oss:20b (plain-llm) | plain-llm |"))
        self.assertTrue(plain_row.endswith("| — | — | — |"))


if __name__ == "__main__":
    unittest.main()
