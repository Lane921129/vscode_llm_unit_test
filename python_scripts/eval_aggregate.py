"""Aggregate multiple model screening batch runs from batch_manifest.json and target journals.

Reads a directory containing one subfolder per model run (each with ``batch_manifest.json``)
or explicit batch directories, separates cancelled/incomplete batches from comparable runs,
and outputs per-model metrics in Markdown or JSON.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import sys
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EVAL_SET = ROOT / "eval" / "eval-set-v1.json"

PASSED_STATUSES = {"passed", "quality-passed"}
RETAINED_STATUSES = {"retained-after-failure", "usable", "execution-passed"}
REVIEW_BLOCKED_STATUSES = {"review-blocked"}
FAILED_STATUSES = {"failed"}
INCOMPLETE_BATCH_STATUSES = {"cancelled", "incomplete", "running", "discovering", "policy-stopped"}
INCOMPLETE_TARGET_STATUSES = {"cancelled", "pending", "running", "policy-not-run", "incomplete-report"}


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def load_eval_set_spec_map(eval_set_path: Path | None = DEFAULT_EVAL_SET) -> dict[tuple[str, str], bool]:
    """Map (file, target) -> hasSpec from eval/eval-set-v1.json if available."""
    if eval_set_path is None or not Path(eval_set_path).is_file():
        return {}
    data = json.loads(Path(eval_set_path).read_text(encoding="utf-8-sig"))
    spec_map: dict[tuple[str, str], bool] = {}
    for entry in data.get("entries", []):
        if isinstance(entry, dict) and isinstance(entry.get("file"), str) and isinstance(entry.get("target"), str):
            spec_map[(entry["file"], entry["target"])] = bool(entry.get("hasSpec", False))
    return spec_map


def discover_batch_manifests(paths: list[str | Path]) -> list[Path]:
    """Resolve input paths to a deterministic list of batch_manifest.json files."""
    manifests: list[Path] = []
    seen: set[Path] = set()
    for raw in paths:
        candidate = Path(raw)
        if not candidate.exists():
            raise ValueError(f"Path does not exist: {candidate}")
        if candidate.is_file():
            if candidate.name != "batch_manifest.json":
                raise ValueError(f"Expected batch_manifest.json file, got: {candidate}")
            resolved = candidate.resolve()
            if resolved not in seen:
                seen.add(resolved)
                manifests.append(candidate)
            continue

        direct = candidate / "batch_manifest.json"
        if direct.is_file():
            resolved = direct.resolve()
            if resolved not in seen:
                seen.add(resolved)
                manifests.append(direct)
            continue

        children = sorted(
            (child / "batch_manifest.json" for child in candidate.iterdir() if child.is_dir() and (child / "batch_manifest.json").is_file()),
            key=lambda p: p.parent.name.lower(),
        )
        if not children:
            raise ValueError(f"No batch_manifest.json found in {candidate}")
        for child_manifest in children:
            resolved = child_manifest.resolve()
            if resolved not in seen:
                seen.add(resolved)
                manifests.append(child_manifest)

    if not manifests:
        raise ValueError("No batch manifests discovered.")
    return manifests


def _resolve_target_run_dir(batch_dir: Path, report_directory: str | None) -> Path | None:
    if not report_directory or not isinstance(report_directory, str):
        return None
    target_root = batch_dir / report_directory
    loop_run = target_root / "loop" / "_run"
    if loop_run.is_dir():
        return loop_run
    if target_root.is_dir():
        return target_root
    return None


def _extract_coverage_percent(payload: dict[str, Any] | None) -> float | None:
    if not isinstance(payload, dict):
        return None
    coverage = payload.get("coverage")
    if not isinstance(coverage, dict):
        return None
    selected = coverage.get("selectedTarget")
    if isinstance(selected, dict):
        exec_lines = selected.get("executableLines")
        miss_lines = selected.get("missingLines")
        if isinstance(exec_lines, list) and isinstance(miss_lines, list) and len(exec_lines) > 0:
            executed = max(0, len(exec_lines) - len(miss_lines))
            return (executed / len(exec_lines)) * 100.0
    assessment = coverage.get("assessment")
    if isinstance(assessment, dict):
        exec_lines = assessment.get("executableTargetLines")
        miss_lines = assessment.get("missingTargetLines")
        if isinstance(exec_lines, list) and isinstance(miss_lines, list) and len(exec_lines) > 0:
            executed = max(0, len(exec_lines) - len(miss_lines))
            return (executed / len(exec_lines)) * 100.0
    return None


def _extract_mutation_score(payload: dict[str, Any] | None) -> float | None:
    if not isinstance(payload, dict):
        return None
    score = payload.get("mutationScore")
    if _is_number(score):
        return float(score)
    return None


def _scan_role_events(role_events_path: Path) -> dict[str, Any]:
    length_count = 0
    requested = 0
    completed = 0
    errors = 0
    by_role: dict[str, dict[str, int]] = {}

    for line in role_events_path.read_text(encoding="utf-8-sig").splitlines():
        text = line.strip()
        if not text:
            continue
        event = json.loads(text)
        if not isinstance(event, dict):
            continue
        detail = event.get("detail")
        if not isinstance(detail, dict):
            detail = {}

        ollama = detail.get("ollama")
        completion_reason = (
            ollama.get("completionReason") if isinstance(ollama, dict) else None
        ) or detail.get("completionReason")
        if completion_reason == "length":
            length_count += 1

        if event.get("stage") == "model-request":
            status = event.get("status")
            role = detail.get("role") if isinstance(detail.get("role"), str) else "unknown"
            if status in ("requested", "completed", "error"):
                role_bucket = by_role.setdefault(role, {"requested": 0, "completed": 0, "error": 0})
                role_bucket[status] += 1
                if status == "requested":
                    requested += 1
                elif status == "completed":
                    completed += 1
                elif status == "error":
                    errors += 1

    return {
        "lengthTruncatedCount": length_count,
        "requested": requested,
        "completed": completed,
        "error": errors,
        "byRole": by_role,
    }


def _summarize_target_subset(targets: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(targets)
    passed = sum(1 for t in targets if t["bucket"] == "passed")
    retained = sum(1 for t in targets if t["bucket"] == "retained")
    review_blocked = sum(1 for t in targets if t["bucket"] == "review-blocked")
    failed = sum(1 for t in targets if t["bucket"] == "failed")
    executable = sum(1 for t in targets if t["executableTest"])
    covs = [t["coveragePercent"] for t in targets if t["coveragePercent"] is not None]
    muts = [t["mutationScore"] for t in targets if t["mutationScore"] is not None]
    return {
        "total": total,
        "passed": passed,
        "retained": retained,
        "reviewBlocked": review_blocked,
        "failed": failed,
        "executableTests": executable,
        "executableRate": (executable / total) if total > 0 else 0.0,
        "avgCoverage": (sum(covs) / len(covs)) if covs else None,
        "mutationMeasuredCount": len(muts),
        "avgMutationScore": (sum(muts) / len(muts)) if muts else None,
    }


def evaluate_batch_manifest(
    manifest_path: Path,
    spec_map: dict[tuple[str, str], bool] | None = None,
) -> dict[str, Any]:
    """Summarize a single batch_manifest.json and its target run artifacts."""
    manifest_path = Path(manifest_path)
    batch_dir = manifest_path.parent
    data = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"Invalid batch manifest object in {manifest_path}")

    spec_lookup = spec_map or {}
    status = str(data.get("status") or "unknown")
    expected_targets = int(data.get("expectedTargets") or 0)
    finished_targets = int(data.get("finishedTargets") or 0)
    attempted_targets = int(data.get("attemptedTargets") or 0)
    status_counts = data.get("statusCounts") if isinstance(data.get("statusCounts"), dict) else {}
    discovery_failures = data.get("discoveryFailures") if isinstance(data.get("discoveryFailures"), list) else []
    targets_raw = data.get("targets") if isinstance(data.get("targets"), list) else []

    exclusion_reasons: list[str] = []
    if status in INCOMPLETE_BATCH_STATUSES:
        exclusion_reasons.append(f"status={status}")
    if expected_targets <= 0:
        exclusion_reasons.append("expectedTargets=0")
    elif finished_targets < expected_targets:
        exclusion_reasons.append(f"finishedTargets={finished_targets}/{expected_targets}")
    if not data.get("finishedAt"):
        exclusion_reasons.append("missing-finishedAt")
    if discovery_failures:
        exclusion_reasons.append(f"discoveryFailures={len(discovery_failures)}")

    for inc_key in ("cancelled", "pending", "running", "policy-not-run", "incomplete-report"):
        inc_val = status_counts.get(inc_key, 0)
        if isinstance(inc_val, int) and inc_val > 0:
            exclusion_reasons.append(f"{inc_key}={inc_val}")

    unfinished_target_states = sum(
        1
        for item in targets_raw
        if isinstance(item, dict)
        and (
            item.get("state") != "finished"
            or item.get("terminalStatus") in INCOMPLETE_TARGET_STATUSES
        )
    )
    if unfinished_target_states > 0 and not any(
        r.startswith(("pending=", "cancelled=", "running=", "finishedTargets=")) for r in exclusion_reasons
    ):
        exclusion_reasons.append(f"unfinishedTargets={unfinished_target_states}")

    comparable = len(exclusion_reasons) == 0

    elapsed_seconds: float | None = None
    if isinstance(data.get("startedAt"), str) and isinstance(data.get("finishedAt"), str):
        started = datetime.fromisoformat(data["startedAt"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(data["finishedAt"].replace("Z", "+00:00"))
        diff = (finished - started).total_seconds()
        if diff < 0:
            raise ValueError(f"Negative elapsed time in {manifest_path}")
        elapsed_seconds = diff

    passed = 0
    retained = 0
    review_blocked = 0
    failed = 0
    other_statuses: dict[str, int] = {}

    target_records: list[dict[str, Any]] = []
    role_events_found = 0
    role_length_total = 0
    role_requested_total = 0
    role_completed_total = 0
    role_error_total = 0
    by_role_totals: dict[str, dict[str, int]] = {}

    for item in targets_raw:
        if not isinstance(item, dict):
            continue
        file_name = str(item.get("file") or "")
        target_name = str(item.get("target") or "")
        terminal = str(item.get("terminalStatus") or item.get("state") or "unknown")

        if terminal in PASSED_STATUSES:
            bucket = "passed"
            passed += 1
        elif terminal in RETAINED_STATUSES:
            bucket = "retained"
            retained += 1
        elif terminal in REVIEW_BLOCKED_STATUSES:
            bucket = "review-blocked"
            review_blocked += 1
        elif terminal in FAILED_STATUSES:
            bucket = "failed"
            failed += 1
        else:
            bucket = "other"
            other_statuses[terminal] = other_statuses.get(terminal, 0) + 1

        run_dir = _resolve_target_run_dir(batch_dir, item.get("reportDirectory"))
        fk_data: dict[str, Any] | None = None
        eb_data: dict[str, Any] | None = None
        qb_data: dict[str, Any] | None = None

        if run_dir is not None:
            fk_path = run_dir / "function_knowledge.json"
            if fk_path.is_file():
                fk_data = json.loads(fk_path.read_text(encoding="utf-8-sig"))
            eb_path = run_dir / "executable_baseline.json"
            if eb_path.is_file():
                eb_data = json.loads(eb_path.read_text(encoding="utf-8-sig"))
            qb_path = run_dir / "quality_baseline.json"
            if qb_path.is_file():
                qb_data = json.loads(qb_path.read_text(encoding="utf-8-sig"))

            re_path = run_dir / "role_events.jsonl"
            if re_path.is_file():
                role_events_found += 1
                re_stats = _scan_role_events(re_path)
                target_len_count = re_stats["lengthTruncatedCount"]
                role_length_total += target_len_count
                role_requested_total += re_stats["requested"]
                role_completed_total += re_stats["completed"]
                role_error_total += re_stats["error"]
                for r_name, r_counts in re_stats["byRole"].items():
                    agg = by_role_totals.setdefault(r_name, {"requested": 0, "completed": 0, "error": 0})
                    agg["requested"] += r_counts["requested"]
                    agg["completed"] += r_counts["completed"]
                    agg["error"] += r_counts["error"]
            else:
                cap = item.get("capabilitySummary")
                target_len_count = (
                    int(cap.get("lengthStoppedTransports", 0))
                    if isinstance(cap, dict) and isinstance(cap.get("lengthStoppedTransports"), int)
                    else 0
                )
                role_length_total += target_len_count
        else:
            cap = item.get("capabilitySummary")
            target_len_count = (
                int(cap.get("lengthStoppedTransports", 0))
                if isinstance(cap, dict) and isinstance(cap.get("lengthStoppedTransports"), int)
                else 0
            )
            role_length_total += target_len_count

        cov_pct = _extract_coverage_percent(fk_data)
        if cov_pct is None:
            cov_pct = _extract_coverage_percent(qb_data)
        if cov_pct is None:
            cov_pct = _extract_coverage_percent(eb_data)

        mut_score = _extract_mutation_score(fk_data)
        if mut_score is None:
            mut_score = _extract_mutation_score(qb_data)

        executable_test = cov_pct is not None
        has_spec = spec_lookup.get((file_name, target_name))

        target_records.append(
            {
                "file": file_name,
                "target": target_name,
                "terminalStatus": terminal,
                "bucket": bucket,
                "executableTest": executable_test,
                "coveragePercent": cov_pct,
                "mutationScore": mut_score,
                "lengthTruncatedCount": target_len_count,
                "hasSpec": has_spec,
            }
        )

    if not targets_raw and status_counts:
        for st_name, st_count in status_counts.items():
            if not isinstance(st_count, int):
                continue
            if st_name in PASSED_STATUSES:
                passed += st_count
            elif st_name in RETAINED_STATUSES:
                retained += st_count
            elif st_name in REVIEW_BLOCKED_STATUSES:
                review_blocked += st_count
            elif st_name in FAILED_STATUSES:
                failed += st_count
            else:
                other_statuses[st_name] = other_statuses.get(st_name, 0) + st_count

    cost = data.get("cost") if isinstance(data.get("cost"), dict) else {}
    cap_summary = data.get("modelCapabilitySummary") if isinstance(data.get("modelCapabilitySummary"), dict) else {}

    model_requests = (
        int(cost["modelRequests"])
        if isinstance(cost.get("modelRequests"), int)
        else sum(int(t.get("modelRequests") or 0) for t in targets_raw if isinstance(t, dict))
    )
    output_tokens = (
        int(cost["outputTokens"])
        if isinstance(cost.get("outputTokens"), int)
        else int(cap_summary.get("outputTokens") or 0)
    )

    if role_events_found == 0 and role_length_total == 0 and isinstance(cap_summary.get("lengthStoppedTransports"), int):
        length_truncated_count = int(cap_summary["lengthStoppedTransports"])
        length_truncation_source = "batch_manifest.modelCapabilitySummary"
    else:
        length_truncated_count = role_length_total
        length_truncation_source = "role_events.jsonl" if role_events_found > 0 else "batch_manifest.capabilitySummary"

    overall_subset = _summarize_target_subset(target_records)
    with_spec_targets = [t for t in target_records if t["hasSpec"] is True]
    without_spec_targets = [t for t in target_records if t["hasSpec"] is False]

    denom = expected_targets if expected_targets > 0 else len(target_records)
    executable_tests = overall_subset["executableTests"]
    executable_rate = (executable_tests / denom) if denom > 0 else 0.0
    quality_passed_rate = (passed / denom) if denom > 0 else 0.0
    usable_rate = ((passed + retained) / denom) if denom > 0 else 0.0

    role_usable_rate = (
        (role_completed_total / role_requested_total) if role_requested_total > 0 else None
    )

    return {
        "folder": batch_dir.name,
        "batchId": data.get("batchId"),
        "model": str(data.get("model") or batch_dir.name),
        "status": status,
        "comparable": comparable,
        "exclusionReasons": exclusion_reasons,
        "expectedTargets": expected_targets,
        "finishedTargets": finished_targets,
        "attemptedTargets": attempted_targets,
        "passed": passed,
        "retained": retained,
        "reviewBlocked": review_blocked,
        "failed": failed,
        "otherStatuses": other_statuses,
        "executableTests": executable_tests,
        "executableRate": executable_rate,
        "qualityPassedRate": quality_passed_rate,
        "usableRate": usable_rate,
        "avgCoverage": overall_subset["avgCoverage"],
        "mutationMeasuredCount": overall_subset["mutationMeasuredCount"],
        "avgMutationScore": overall_subset["avgMutationScore"],
        "elapsedSeconds": elapsed_seconds,
        "elapsedMinutes": (elapsed_seconds / 60.0) if elapsed_seconds is not None else None,
        "avgTargetSeconds": (elapsed_seconds / denom) if (elapsed_seconds is not None and denom > 0) else None,
        "modelRequests": model_requests,
        "outputTokens": output_tokens,
        "lengthTruncatedCount": length_truncated_count,
        "lengthTruncationSource": length_truncation_source,
        "roleReplySummary": {
            "requested": role_requested_total,
            "completed": role_completed_total,
            "error": role_error_total,
            "usableRate": role_usable_rate,
            "byRole": by_role_totals,
        },
        "specBreakdown": {
            "withSpec": _summarize_target_subset(with_spec_targets),
            "withoutSpec": _summarize_target_subset(without_spec_targets),
        },
    }


def _sort_key_comparable(item: dict[str, Any]) -> tuple[Any, ...]:
    avg_cov = item["avgCoverage"] if item["avgCoverage"] is not None else -1.0
    elapsed = item["elapsedSeconds"] if item["elapsedSeconds"] is not None else float("inf")
    return (
        -item["passed"],
        -item["executableTests"],
        -avg_cov,
        -item["mutationMeasuredCount"],
        elapsed,
        item["folder"].lower(),
    )


def aggregate_batches(
    paths: list[str | Path],
    eval_set_path: Path | None = DEFAULT_EVAL_SET,
) -> dict[str, Any]:
    """Aggregate all discovered batch manifests into comparable and excluded groups."""
    spec_map = load_eval_set_spec_map(eval_set_path)
    manifest_paths = discover_batch_manifests(paths)
    evaluated = [evaluate_batch_manifest(path, spec_map=spec_map) for path in manifest_paths]

    comparable = sorted(
        [item for item in evaluated if item["comparable"]],
        key=_sort_key_comparable,
    )
    excluded = sorted(
        [item for item in evaluated if not item["comparable"]],
        key=lambda x: x["folder"].lower(),
    )

    return {
        "schemaVersion": "eval-aggregate-v1",
        "evalSetVersion": "eval-set-v1" if spec_map else None,
        "totalBatches": len(evaluated),
        "comparableCount": len(comparable),
        "excludedCount": len(excluded),
        "comparableBatches": comparable,
        "excludedBatches": excluded,
    }


def _fmt_pct(value: float | None, decimals: int = 1) -> str:
    if value is None:
        return "N/A"
    return f"{value:.{decimals}f}%"


def _fmt_minutes(minutes: float | None) -> str:
    if minutes is None:
        return "N/A"
    return f"{minutes:.1f} 分"


def format_markdown(summary: dict[str, Any]) -> str:
    """Format aggregated model screening results as a Markdown report."""
    lines: list[str] = [
        "# 模型篩選評估彙總報告",
        "",
        "## 模型比較總表（僅含已完成批次）",
        "",
        "| 模型 | 資料夾 | 完整通過 | 保留可用 | 審查阻擋 | 失敗 | 其他終態 | 產生可執行測試 | 平均覆蓋率 | 量到突變分數 | 平均突變分數 | 耗時 | 請求數 | 輸出 tokens | 輸出被截斷 |",
        "| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]

    for b in summary.get("comparableBatches", []):
        denom = b["expectedTargets"]
        exec_count = b["executableTests"]
        exec_pct = round(b["executableRate"] * 100)
        exec_cell = f"{exec_count}／{denom}（{exec_pct}%）"
        other_cell = (
            ", ".join(f"{k}: {v}" for k, v in sorted(b["otherStatuses"].items()))
            if b.get("otherStatuses")
            else "—"
        )
        lines.append(
            f"| {b['model']} | `{b['folder']}` | {b['passed']} | {b['retained']} | "
            f"{b['reviewBlocked']} | {b['failed']} | {other_cell} | {exec_cell} | "
            f"{_fmt_pct(b['avgCoverage'])} | {b['mutationMeasuredCount']} | "
            f"{_fmt_pct(b['avgMutationScore'])} | {_fmt_minutes(b['elapsedMinutes'])} | "
            f"{b['modelRequests']} | {b['outputTokens']:,} | {b['lengthTruncatedCount']} |"
        )

    if not summary.get("comparableBatches"):
        lines.append("| （無已完成的可比較批次） | — | — | — | — | — | — | — | — | — | — | — | — | — | — |")

    excluded = summary.get("excludedBatches", [])
    lines.extend(
        [
            "",
            "## 被取消或未完成的批次（不列入比較）",
            "",
        ]
    )
    if excluded:
        lines.extend(
            [
                "| 模型 | 資料夾 | 批次狀態 | 完成／預期目標 | 排除原因 | 請求數 | 輸出 tokens |",
                "| --- | --- | --- | ---: | --- | ---: | ---: |",
            ]
        )
        for b in excluded:
            reasons = ", ".join(b.get("exclusionReasons", [])) or "incomplete"
            lines.append(
                f"| {b['model']} | `{b['folder']}` | `{b['status']}` | "
                f"{b['finishedTargets']}／{b['expectedTargets']} | {reasons} | "
                f"{b['modelRequests']} | {b['outputTokens']:,} |"
            )
    else:
        lines.append("無被取消或未完成的批次。")

    if any(
        b["specBreakdown"]["withSpec"]["total"] > 0 or b["specBreakdown"]["withoutSpec"]["total"] > 0
        for b in summary.get("comparableBatches", [])
    ):
        lines.extend(
            [
                "",
                "## 有規格來源 vs 無規格來源分開統計",
                "",
                "| 模型 | 分類 | 目標數 | 完整通過 | 保留可用 | 審查阻擋 | 失敗 | 產生可執行測試 | 平均覆蓋率 | 量到突變分數 |",
                "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for b in summary.get("comparableBatches", []):
            for label, key in (("有規格來源", "withSpec"), ("無規格來源", "withoutSpec")):
                sub = b["specBreakdown"][key]
                if sub["total"] == 0:
                    continue
                sub_pct = round(sub["executableRate"] * 100)
                lines.append(
                    f"| {b['model']} | {label} | {sub['total']} | {sub['passed']} | "
                    f"{sub['retained']} | {sub['reviewBlocked']} | {sub['failed']} | "
                    f"{sub['executableTests']}／{sub['total']}（{sub_pct}%） | "
                    f"{_fmt_pct(sub['avgCoverage'])} | {sub['mutationMeasuredCount']} |"
                )

    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Aggregate model screening batch_manifest.json results."
    )
    parser.add_argument(
        "paths",
        nargs="+",
        help="Parent directory containing per-model batch folders, or individual batch directories / batch_manifest.json files.",
    )
    parser.add_argument(
        "--eval-set",
        default=str(DEFAULT_EVAL_SET),
        help="Path to eval/eval-set-v1.json for spec/no-spec classification.",
    )
    parser.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="Output format (default: markdown).",
    )
    parser.add_argument(
        "--output",
        help="Optional file path to write the output report.",
    )
    args = parser.parse_args(argv)

    eval_set_path = Path(args.eval_set) if args.eval_set else None
    summary = aggregate_batches(args.paths, eval_set_path=eval_set_path)
    rendered = (
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
        if args.format == "json"
        else format_markdown(summary)
    )

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(rendered, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
