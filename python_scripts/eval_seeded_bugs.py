"""Seeded bug evaluation tool (architecture 6.4).

Provides two subcommands:
  prepare: applies each seeded bug patch to an independent copy in a target folder,
           generates clean copy and targets.json for batch execution in the extension.
  analyze: reads v1, v2, and control group results on bugs and clean copies,
           computes detection rate, bug written as correct answer rate, and false positives,
           and writes seeded_bug_report.md and seeded_bug_report.json.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any
import uuid

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_BUGS_DIR = ROOT / 'eval' / 'seeded_bugs'
DEFAULT_SCREENING_DIR = ROOT / 'eval' / 'eval_screening'

DOCSTRINGS_TO_ADD = {
    'vehicle_time_utils.py': [
        ('def get_remaining_text(eta_time):\n',
         'def get_remaining_text(eta_time):\n    """回傳剩餘或超時文字說明與是否超時之布林值元組 (text, is_overdue)"""\n'),
        ('def format_eta_time(eta_time):\n',
         'def format_eta_time(eta_time):\n    """將預計到達時間字串轉為月/日 時:分格式字串 (%m/%d %H:%M)"""\n')
    ]
}


def apply_patch(original_text: str, patch_text: str) -> str:
    """Apply a unified diff patch to original text in pure Python."""
    orig_lines = original_text.splitlines(keepends=True)
    patch_lines = patch_text.splitlines(keepends=True)
    hunks = []
    current_hunk: dict[str, Any] | None = None
    for line in patch_lines:
        if line.startswith('@@'):
            m = re.match(r'^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@', line)
            if m:
                orig_start = int(m.group(1))
                orig_len = int(m.group(2)) if m.group(2) is not None else 1
                new_start = int(m.group(3))
                new_len = int(m.group(4)) if m.group(4) is not None else 1
                current_hunk = {
                    'orig_start': orig_start,
                    'orig_len': orig_len,
                    'new_start': new_start,
                    'new_len': new_len,
                    'lines': []
                }
                hunks.append(current_hunk)
        elif current_hunk is not None:
            if line.startswith((' ', '-', '+', '\\')):
                current_hunk['lines'].append(line)

    out_lines = list(orig_lines)
    for hunk in reversed(hunks):
        start_idx = hunk['orig_start'] - 1
        del_count = 0
        new_block = []
        for hline in hunk['lines']:
            if hline.startswith(' '):
                del_count += 1
                new_block.append(hline[1:])
            elif hline.startswith('-'):
                del_count += 1
            elif hline.startswith('+'):
                new_block.append(hline[1:])
        out_lines[start_idx : start_idx + del_count] = new_block
    return ''.join(out_lines)


def load_seeded_bugs(bugs_dir: Path | str) -> list[dict[str, Any]]:
    """Load metadata and patches for all seeded bugs sorted by bug id."""
    bugs_dir = Path(bugs_dir)
    if not bugs_dir.is_dir():
        raise FileNotFoundError(f"Bugs directory not found: {bugs_dir}")
    bugs = []
    for item in sorted(bugs_dir.iterdir()):
        if not item.is_dir():
            continue
        meta_file = item / 'meta.json'
        patch_file = item / 'patch'
        if meta_file.is_file() and patch_file.is_file():
            meta = json.loads(meta_file.read_text(encoding='utf-8'))
            patch = patch_file.read_text(encoding='utf-8')
            bugs.append({
                'id': meta.get('id', item.name),
                'meta': meta,
                'patch': patch,
                'dir': item
            })
    return bugs


def prepare_seeded_bugs(output_dir: Path | str,
                        bugs_dir: Path | str = DEFAULT_BUGS_DIR,
                        screening_dir: Path | str = DEFAULT_SCREENING_DIR) -> dict[str, Any]:
    """Prepare clean and bug copies with merged targets.json outside the repo."""
    output_dir = Path(output_dir)
    bugs_dir = Path(bugs_dir)
    screening_dir = Path(screening_dir)

    bugs = load_seeded_bugs(bugs_dir)
    if not bugs:
        raise ValueError(f"No seeded bugs found in {bugs_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)
    clean_dir = output_dir / 'clean'
    clean_dir.mkdir(parents=True, exist_ok=True)

    # 1. Create clean copy
    for item in screening_dir.iterdir():
        if item.is_file() and item.name.endswith('.py'):
            content = item.read_text(encoding='utf-8')
            if item.name in DOCSTRINGS_TO_ADD:
                for old_s, new_s in DOCSTRINGS_TO_ADD[item.name]:
                    content = content.replace(old_s, new_s, 1)
            (clean_dir / item.name).write_text(content, encoding='utf-8')

    # Collect clean targets
    clean_targets_map: dict[str, list[str]] = {}
    for bug in bugs:
        source_file = bug['meta']['sourceFile']
        target_name = bug['meta']['target']
        if source_file not in clean_targets_map:
            clean_targets_map[source_file] = []
        if target_name not in clean_targets_map[source_file]:
            clean_targets_map[source_file].append(target_name)

    # Sort files and targets
    for sf in clean_targets_map:
        clean_targets_map[sf].sort(key=lambda s: s.lower())
    sorted_clean_targets = dict(sorted(clean_targets_map.items(), key=lambda kv: kv[0].lower()))

    clean_manifest = {
        'version': 'eval-screening-v1',
        'created': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
        'targets': sorted_clean_targets
    }
    (clean_dir / 'targets.json').write_text(json.dumps(clean_manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # 2. Create bug copies
    bugs_root = output_dir / 'bugs'
    bugs_root.mkdir(parents=True, exist_ok=True)

    merged_targets_map: dict[str, list[str]] = {}
    per_bug_targets_map: dict[str, list[str]] = {}

    for bug in bugs:
        bug_id = bug['id']
        bug_copy_dir = bugs_root / bug_id
        bug_copy_dir.mkdir(parents=True, exist_ok=True)

        # Copy all files from clean
        for py_file in clean_dir.iterdir():
            if py_file.is_file() and py_file.name.endswith('.py'):
                shutil.copy2(py_file, bug_copy_dir / py_file.name)

        # Apply patch
        source_file = bug['meta']['sourceFile']
        clean_file_path = bug_copy_dir / source_file
        orig_content = clean_file_path.read_text(encoding='utf-8')
        patched_content = apply_patch(orig_content, bug['patch'])
        clean_file_path.write_text(patched_content, encoding='utf-8')

        # Relpath in merged targets.json (from output_dir)
        rel_path = f"bugs/{bug_id}/{source_file}"
        merged_targets_map[rel_path] = [bug['meta']['target']]

        # Relpath from bugs_root
        per_bug_targets_map[f"{bug_id}/{source_file}"] = [bug['meta']['target']]

    # Write merged targets.json at output root
    merged_manifest = {
        'version': 'eval-screening-v1',
        'created': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
        'targets': merged_targets_map
    }
    (output_dir / 'targets.json').write_text(json.dumps(merged_manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # Also write bugs/targets.json for flexibility if user opens bugs folder directly
    bugs_manifest = {
        'version': 'eval-screening-v1',
        'created': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
        'targets': per_bug_targets_map
    }
    (bugs_root / 'targets.json').write_text(json.dumps(bugs_manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    return {
        'status': 'prepared',
        'outputDir': str(output_dir),
        'cleanDir': str(clean_dir),
        'bugsPrepared': len(bugs),
        'mergedTargetsFile': str(output_dir / 'targets.json'),
        'cleanTargetsFile': str(clean_dir / 'targets.json')
    }


def _run_python_guarded(python: str, script_name: str, args: list[str], cwd: Path, import_paths: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    script_path = str(SCRIPTS_DIR / script_name)
    env = dict(os.environ)
    env.pop('PYTHONPATH', None)
    env['LLM_UNIT_TEST_IMPORT_PATHS'] = json.dumps(import_paths)
    env['PYTHONIOENCODING'] = 'utf-8'
    return subprocess.run(
        [python, '-E', '-X', 'utf8', '-B', script_path, *args],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        encoding='utf-8',
        timeout=timeout
    )


def run_test_in_isolation(python: str,
                          test_file_path: Path,
                          source_dir: Path,
                          source_filename: str,
                          target: str,
                          temp_workdir: Path,
                          timeout: int = 60) -> dict[str, Any]:
    """Execute a test file with generated_test_runner in isolation against a given source."""
    source_file = source_dir / source_filename
    if not source_file.is_file():
        return {
            'status': 'unavailable',
            'reason': 'source-not-found',
            'observed': False,
            'testFailures': [],
            'detail': f"Source file not found: {source_file}"
        }

    temp_workdir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex[:8]
    evidence_file = temp_workdir / f"recheck_{token}.invocation.json"
    result_file = temp_workdir / f"recheck_{token}.result.json"
    violation_file = temp_workdir / f"recheck_{token}.isolation.jsonl"

    module_name = test_file_path.stem
    import_paths = [str(source_dir), str(test_file_path.parent)]

    args = [
        module_name,
        '-v',
        '--target-file', str(source_file),
        '--target-name', target,
        '--target-test-file', str(test_file_path),
        '--target-evidence', str(evidence_file),
        '--target-run-id', str(uuid.uuid4()),
        '--violation-report', str(violation_file),
        '--result-json', str(result_file)
    ]

    try:
        run = _run_python_guarded(python, 'generated_test_runner.py', args, test_file_path.parent, import_paths, timeout)
    except subprocess.TimeoutExpired:
        return {
            'status': 'unavailable',
            'reason': 'timeout',
            'observed': False,
            'testFailures': [],
            'detail': 'timeout'
        }

    if violation_file.is_file():
        try:
            for line in violation_file.read_text(encoding='utf-8').splitlines():
                if line.strip():
                    ev = json.loads(line)
                    if ev.get('event') == 'completed' and ev.get('status') == 'isolation-blocked':
                        return {
                            'status': 'unavailable',
                            'reason': 'isolation-blocked',
                            'observed': False,
                            'testFailures': [],
                            'detail': ev.get('operation', 'isolation-blocked')
                        }
        except Exception:
            pass

    observed = False
    if evidence_file.is_file():
        try:
            ev_data = json.loads(evidence_file.read_text(encoding='utf-8'))
            observed = bool(ev_data.get('observed', False))
        except Exception:
            pass

    result_data = None
    if result_file.is_file():
        try:
            result_data = json.loads(result_file.read_text(encoding='utf-8'))
        except Exception:
            pass

    if not isinstance(result_data, dict):
        return {
            'status': 'unavailable',
            'reason': 'missing-result',
            'observed': observed,
            'testFailures': [],
            'detail': (run.stdout + run.stderr)[-1000:]
        }

    runner_status = result_data.get('status')
    failures = result_data.get('testFailures', [])

    if runner_status == 'passed' and run.returncode == 0:
        if observed:
            return {
                'status': 'passed',
                'reason': None,
                'observed': True,
                'testFailures': []
            }
        else:
            return {
                'status': 'unavailable',
                'reason': 'target-not-observed',
                'observed': False,
                'testFailures': []
            }

    if runner_status == 'failed':
        if not observed:
            return {
                'status': 'unavailable',
                'reason': 'target-not-observed',
                'observed': False,
                'testFailures': failures
            }
        target_behavior_failures = [
            f for f in failures
            if f.get('phase') == 'test' and f.get('kind') in ('failure', 'error')
        ]
        if target_behavior_failures:
            return {
                'status': 'failed',
                'reason': None,
                'observed': True,
                'testFailures': target_behavior_failures
            }
        else:
            return {
                'status': 'unavailable',
                'reason': 'runner-error',
                'observed': observed,
                'testFailures': failures
            }

    return {
        'status': 'unavailable',
        'reason': runner_status or 'runner-error',
        'observed': observed,
        'testFailures': failures,
        'detail': (run.stdout + run.stderr)[-1000:]
    }


def re_run_test_on_clean(python: str,
                         test_file_path: Path,
                         clean_dir: Path,
                         source_filename: str,
                         target: str,
                         temp_workdir: Path,
                         timeout: int = 60) -> dict[str, Any]:
    """Re-run a formal test against the clean version of the target.

    Only when runner completes normally, invocation evidence shows target was observed,
    and test result is failure/error from target behavior, is failedOnClean=True.
    Other situations are cleanRecheck='unavailable'.
    """
    clean_source_file = clean_dir / source_filename
    if not clean_source_file.is_file():
        raise FileNotFoundError(f"Clean source file not found: {clean_source_file}")

    res = run_test_in_isolation(python, test_file_path, clean_dir, source_filename, target, temp_workdir, timeout)
    if res['status'] == 'failed':
        return {
            'cleanRunStatus': 'failed',
            'cleanRecheck': 'failed',
            'failedOnClean': True,
            'reason': None,
            'observed': True,
            'testFailures': res.get('testFailures', [])
        }
    elif res['status'] == 'passed':
        return {
            'cleanRunStatus': 'passed',
            'cleanRecheck': 'passed',
            'failedOnClean': False,
            'reason': None,
            'observed': True,
            'testFailures': []
        }
    else:
        return {
            'cleanRunStatus': 'unavailable',
            'cleanRecheck': 'unavailable',
            'failedOnClean': False,
            'reason': res.get('reason', 'unavailable'),
            'observed': res.get('observed', False),
            'testFailures': res.get('testFailures', []),
            'detail': res.get('detail')
        }


def find_formal_test_file(target_dir: Path) -> Path | None:
    """Find the formal test file generated for a target."""
    # 1. v2 formal test
    v2_test = target_dir / 'test_case_table.py'
    if v2_test.is_file():
        return v2_test

    # 2. Control group formal test
    control_test = target_dir / 'baseline_test.py'
    if control_test.is_file():
        return control_test

    # 3. v1 quality_baseline or executable_baseline
    for baseline_name in ('quality_baseline.json', 'executable_baseline.json'):
        candidates = [
            target_dir / baseline_name,
            target_dir / 'loop' / '_run' / baseline_name,
        ]
        candidates.extend(list(target_dir.glob(f"**/{baseline_name}")))
        for base_file in candidates:
            if base_file.is_file():
                try:
                    data = json.loads(base_file.read_text(encoding='utf-8'))
                    code = data.get('code')
                    if code and isinstance(code, str):
                        temp_test = target_dir / 'v1_formal_test.py'
                        temp_test.write_text(code, encoding='utf-8')
                        return temp_test
                except Exception:
                    pass

    # 4. Search for other test_*.py or *_test.py in target_dir or loop subdirs
    candidates = list(target_dir.glob('**/*test*.py'))
    for c in candidates:
        if c.is_file() and not c.name.startswith('test_spec_mismatch'):
            return c

    return None


def find_target_directory(batch_root: Path, bug_id: str, target_name: str, source_file: str) -> Path | None:
    """Locate the target output folder within a batch run."""
    manifest_file = batch_root / 'batch_manifest.json'
    if manifest_file.is_file():
        try:
            manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
            for item in manifest.get('targets', []):
                file_str = item.get('file', '')
                rep_dir = item.get('reportDirectory', '')
                if item.get('target') == target_name and (bug_id in file_str or bug_id in rep_dir):
                    if rep_dir:
                        cand = batch_root / rep_dir
                        if cand.is_dir():
                            return cand
        except Exception:
            pass

    # Direct scan by folder name containing bug_id and target_name
    for folder in batch_root.rglob(f"*{target_name}*"):
        if folder.is_dir() and (bug_id in str(folder) or bug_id in folder.parent.name):
            return folder

    # Fallback scan any folder with target_name
    for folder in batch_root.rglob(f"*{target_name}*"):
        if folder.is_dir():
            return folder

    return None


def extract_spec_mismatch_info(target_dir: Path) -> dict[str, Any]:
    """Extract spec mismatch information from spec_mismatch.json or case_table.json."""
    spec_json = target_dir / 'spec_mismatch.json'
    if not spec_json.is_file():
        # Check subdirectories
        sub = list(target_dir.glob('**/spec_mismatch.json'))
        if sub:
            spec_json = sub[0]

    if spec_json.is_file():
        try:
            data = json.loads(spec_json.read_text(encoding='utf-8'))
            mismatches = data.get('specMismatch', [])
            reviews = data.get('needsReview', [])
            return {
                'hasSpecInfo': True,
                'specMismatchCount': len(mismatches),
                'needsReviewCount': len(reviews),
                'detectedMismatch': len(mismatches) > 0,
                'detectedNeedsReview': (len(mismatches) > 0 or len(reviews) > 0)
            }
        except Exception:
            pass

    return {
        'hasSpecInfo': False,
        'specMismatchCount': 0,
        'needsReviewCount': 0,
        'detectedMismatch': False,
        'detectedNeedsReview': False
    }


def analyze_seeded_bugs(clean_dir: Path | str,
                        bugs_dir: Path | str = DEFAULT_BUGS_DIR,
                        method_results: dict[str, dict[str, Path | None]] | None = None,
                        output_dir: Path | str = Path('.'),
                        python: str = sys.executable) -> dict[str, Any]:
    """Analyze evaluation results across v1, v2, and control group."""
    clean_dir = Path(clean_dir)
    bugs_dir = Path(bugs_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    bugs = load_seeded_bugs(bugs_dir)
    if not bugs:
        raise ValueError(f"No seeded bugs found in {bugs_dir}")

    if not method_results:
        raise ValueError("No method results provided for analysis")

    report_methods: list[dict[str, Any]] = []

    for method_name, paths in method_results.items():
        bugs_batch_dir = paths.get('bugs')
        clean_batch_dir = paths.get('clean')

        is_v2 = ('v2' in method_name.lower() or 'case-table' in method_name.lower())
        total_bugs = len(bugs)

        spec_mismatch_detected_count = 0
        needs_review_detected_count = 0
        written_as_correct_count = 0
        clean_unavailable_count = 0
        no_test_count = 0
        evaluated_bugs_count = 0

        per_bug_records = []

        if bugs_batch_dir and Path(bugs_batch_dir).is_dir():
            bugs_root = Path(bugs_batch_dir)
            temp_dir = bugs_root / '_clean_recheck_tmp'
            temp_dir.mkdir(parents=True, exist_ok=True)

            for bug in bugs:
                bug_id = bug['id']
                meta = bug['meta']
                target = meta['target']
                source_file = meta['sourceFile']

                target_dir = find_target_directory(bugs_root, bug_id, target, source_file)
                if not target_dir:
                    no_test_count += 1
                    per_bug_records.append({
                        'bugId': bug_id,
                        'target': target,
                        'sourceFile': source_file,
                        'hasTestFile': False,
                        'formalTestStatus': 'no-test',
                        'status': 'missing-target-run',
                        'formalPassedOnBug': False,
                        'cleanRecheck': 'not-run',
                        'cleanRecheckReason': 'missing-target-run',
                        'failedOnClean': False,
                        'writtenAsCorrect': False,
                        'detectedMismatch': False if is_v2 else 'N/A',
                        'detectedNeedsReview': False if is_v2 else 'N/A'
                    })
                    continue

                evaluated_bugs_count += 1

                # 1. Spec mismatch detection (v2 only)
                spec_info = extract_spec_mismatch_info(target_dir) if is_v2 else {'hasSpecInfo': False, 'detectedMismatch': False, 'detectedNeedsReview': False}
                if is_v2:
                    if spec_info['detectedMismatch']:
                        spec_mismatch_detected_count += 1
                    if spec_info['detectedNeedsReview']:
                        needs_review_detected_count += 1

                # 2. Bug written as correct answer
                test_file = find_formal_test_file(target_dir)
                if not test_file:
                    no_test_count += 1
                    per_bug_records.append({
                        'bugId': bug_id,
                        'target': target,
                        'sourceFile': source_file,
                        'hasTestFile': False,
                        'formalTestStatus': 'no-test',
                        'formalPassedOnBug': False,
                        'cleanRecheck': 'not-run',
                        'cleanRecheckReason': 'no-formal-test',
                        'failedOnClean': False,
                        'writtenAsCorrect': False,
                        'detectedMismatch': spec_info['detectedMismatch'] if is_v2 else 'N/A',
                        'detectedNeedsReview': spec_info['detectedNeedsReview'] if is_v2 else 'N/A'
                    })
                    continue

                # Locate or create bug source directory
                bug_source_dir = None
                cand_dirs = [
                    clean_dir.parent / 'bugs' / bug_id,
                    clean_dir.parent / bug_id,
                    bugs_root / 'bugs' / bug_id,
                    bugs_root.parent / 'bugs' / bug_id
                ]
                for d in cand_dirs:
                    if (d / source_file).is_file():
                        bug_source_dir = d
                        break

                if bug_source_dir is None:
                    bug_env = temp_dir / f"bug_env_{bug_id}"
                    bug_env.mkdir(parents=True, exist_ok=True)
                    for pf in clean_dir.iterdir():
                        if pf.is_file() and pf.name.endswith('.py'):
                            shutil.copy2(pf, bug_env / pf.name)
                    orig_content = (clean_dir / source_file).read_text(encoding='utf-8')
                    patched = apply_patch(orig_content, bug['patch'])
                    (bug_env / source_file).write_text(patched, encoding='utf-8')
                    bug_source_dir = bug_env

                # Re-run formal test on bug version
                bug_res = run_test_in_isolation(python, test_file, bug_source_dir, source_file, target, temp_dir)
                formal_passed = (bug_res['status'] == 'passed' and bug_res.get('observed') is True)

                failed_on_clean = False
                clean_recheck = 'not-run'
                clean_recheck_reason = 'failed-on-bug' if not formal_passed else None

                if formal_passed and clean_dir.is_dir():
                    clean_res = re_run_test_on_clean(python, test_file, clean_dir, source_file, target, temp_dir)
                    clean_recheck = clean_res['cleanRecheck']
                    clean_recheck_reason = clean_res.get('reason')
                    failed_on_clean = clean_res['failedOnClean']
                    if clean_recheck == 'unavailable':
                        clean_unavailable_count += 1

                written_as_correct = bool(formal_passed and failed_on_clean)
                if written_as_correct:
                    written_as_correct_count += 1

                per_bug_records.append({
                    'bugId': bug_id,
                    'target': target,
                    'sourceFile': source_file,
                    'hasTestFile': True,
                    'formalTestStatus': 'delivered',
                    'formalPassedOnBug': formal_passed,
                    'cleanRecheck': clean_recheck,
                    'cleanRecheckReason': clean_recheck_reason,
                    'failedOnClean': failed_on_clean,
                    'writtenAsCorrect': written_as_correct,
                    'detectedMismatch': spec_info['detectedMismatch'] if is_v2 else 'N/A',
                    'detectedNeedsReview': spec_info['detectedNeedsReview'] if is_v2 else 'N/A'
                })

        # 3. False positive rate on clean copy
        false_positive_avg: float | str = 'N/A'
        clean_functions_count = 0
        total_clean_spec_mismatches = 0

        if is_v2 and clean_batch_dir and Path(clean_batch_dir).is_dir():
            clean_root = Path(clean_batch_dir)
            spec_files = list(clean_root.rglob('spec_mismatch.json'))
            for sf in spec_files:
                try:
                    data = json.loads(sf.read_text(encoding='utf-8'))
                    total_clean_spec_mismatches += len(data.get('specMismatch', []))
                    clean_functions_count += 1
                except Exception:
                    pass
            if clean_functions_count > 0:
                false_positive_avg = round(total_clean_spec_mismatches / clean_functions_count, 4)
            else:
                false_positive_avg = 0.0

        # The denominator includes all bugs in the evaluation set (all failures/unrun count in denominator)
        eval_count = total_bugs

        method_summary = {
            'method': method_name,
            'isV2': is_v2,
            'totalBugs': total_bugs,
            'evaluatedBugs': evaluated_bugs_count,
            'specMismatchDetectionRate': (round(spec_mismatch_detected_count / eval_count, 4) if is_v2 else 'N/A'),
            'specMismatchDetectionRatio': (f"{spec_mismatch_detected_count}/{eval_count}" if is_v2 else 'N/A'),
            'specMismatchPlusNeedsReviewRate': (round(needs_review_detected_count / eval_count, 4) if is_v2 else 'N/A'),
            'specMismatchPlusNeedsReviewRatio': (f"{needs_review_detected_count}/{eval_count}" if is_v2 else 'N/A'),
            'bugWrittenAsCorrectAnswerRate': round(written_as_correct_count / eval_count, 4),
            'bugWrittenAsCorrectAnswerRatio': f"{written_as_correct_count}/{eval_count}",
            'cleanUnavailableCount': clean_unavailable_count,
            'cleanUnavailableRatio': f"{clean_unavailable_count}/{eval_count}",
            'noTestCount': no_test_count,
            'noTestRatio': f"{no_test_count}/{eval_count}",
            'cleanFalsePositiveAverage': false_positive_avg,
            'cleanEvaluatedFunctions': clean_functions_count if is_v2 else 'N/A',
            'perBugRecords': per_bug_records
        }
        report_methods.append(method_summary)

    # Output JSON report
    report_json = {
        'version': 'seeded-bug-eval-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'methods': report_methods
    }
    json_path = output_dir / 'seeded_bug_report.json'
    json_path.write_text(json.dumps(report_json, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # Output Markdown report
    md_lines = [
        '# 埋 Bug 評估報告 (Seeded Bug Evaluation Report)',
        '',
        f"產生時間：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}",
        '',
        '## 1. 三大指標綜整比較',
        '',
        '| 方法 (Method) | 評估 Bug 數 | 偵測率 (spec-mismatch) | 偵測率 (+ needs-review) | Bug 被寫成正確答案比例 | 乾淨版無法重驗 | 沒有測試 | 乾淨版誤報 (每函式平均) |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |'
    ]

    for m in report_methods:
        det_mismatch = (f"{m['specMismatchDetectionRate'] * 100:.1f}% ({m['specMismatchDetectionRatio']})"
                        if isinstance(m['specMismatchDetectionRate'], float) else 'N/A')
        det_review = (f"{m['specMismatchPlusNeedsReviewRate'] * 100:.1f}% ({m['specMismatchPlusNeedsReviewRatio']})"
                      if isinstance(m['specMismatchPlusNeedsReviewRate'], float) else 'N/A')
        written_correct = f"{m['bugWrittenAsCorrectAnswerRate'] * 100:.1f}% ({m['bugWrittenAsCorrectAnswerRatio']})"
        clean_unavail = str(m.get('cleanUnavailableRatio', '0/0'))
        no_test = str(m.get('noTestRatio', '0/0'))
        fp_str = str(m['cleanFalsePositiveAverage']) if m['cleanFalsePositiveAverage'] != 'N/A' else 'N/A'
        md_lines.append(f"| {m['method']} | {m['totalBugs']} | {det_mismatch} | {det_review} | {written_correct} | {clean_unavail} | {no_test} | {fp_str} |")

    md_lines.extend([
        '',
        '## 2. 指標定義與說明',
        '',
        '1. **偵測率 (Detection rate)**：該 bug 對應目標被列為 `spec-mismatch`（以及加上 `needs-review`）之比例。只有具備規格預測之 v2 計算此項，對照組與 v1 不支援規格預測標為 N/A。',
        '2. **Bug 被寫成正確答案比例 (Bug written as correct answer rate)**：正式測試在埋有 bug 的程式上重跑通過、且對乾淨版本重跑 (`generated_test_runner.py`) 時確認失敗的比例。本系統 (v1/v2) 與對照組均量測此項，為核心比較指標。',
        '3. **乾淨版無法重驗 (Clean recheck unavailable)**：測試在 bug 版通過，但在乾淨版重跑時因 runner 錯誤、環境阻擋、目標未呼叫或逾時等非被測行為因素無法重驗之數量；不計入分子。',
        '4. **沒有測試 (No test delivered)**：該目標未交付正式測試檔之數量；計入分母、不計入分子。',
        '5. **乾淨版誤報 (False positive rate on clean code)**：在未埋 bug 的乾淨版本上，每個函式產生的 `spec-mismatch` 列平均數。對照組與 v1 標為 N/A。',
        ''
    ])

    md_path = output_dir / 'seeded_bug_report.md'
    md_path.write_text('\n'.join(md_lines) + '\n', encoding='utf-8')

    return {
        'status': 'completed',
        'reportJson': str(json_path),
        'reportMd': str(md_path),
        'methods': report_methods
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seeded bug evaluation tool (architecture 6.4).")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    # prepare subcommand
    prep_p = subparsers.add_parser("prepare", help="Prepare clean and bug evaluation copies.")
    prep_p.add_argument("-o", "--output-dir", required=True, help="Destination directory for prepared copies.")
    prep_p.add_argument("--bugs-dir", default=str(DEFAULT_BUGS_DIR), help="Seeded bugs directory.")
    prep_p.add_argument("--screening-dir", default=str(DEFAULT_SCREENING_DIR), help="Screening directory.")

    # analyze subcommand
    ana_p = subparsers.add_parser("analyze", help="Analyze results on bug and clean copies.")
    ana_p.add_argument("--clean-dir", required=True, help="Clean project copy directory.")
    ana_p.add_argument("--bugs-dir", default=str(DEFAULT_BUGS_DIR), help="Seeded bugs directory.")
    ana_p.add_argument("--v1-bugs-result", help="v1 result directory on bugs.")
    ana_p.add_argument("--v1-clean-result", help="v1 result directory on clean.")
    ana_p.add_argument("--v2-bugs-result", help="v2 result directory on bugs.")
    ana_p.add_argument("--v2-clean-result", help="v2 result directory on clean.")
    ana_p.add_argument("--control-bugs-result", help="Control group result directory on bugs.")
    ana_p.add_argument("--control-clean-result", help="Control group result directory on clean.")
    ana_p.add_argument("--output-dir", default=".", help="Output directory for reports.")
    ana_p.add_argument("--python", default=sys.executable, help="Python executable.")

    args = parser.parse_args(argv)

    if args.subcommand == "prepare":
        res = prepare_seeded_bugs(args.output_dir, args.bugs_dir, args.screening_dir)
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0

    if args.subcommand == "analyze":
        method_results: dict[str, dict[str, Path | None]] = {}
        if args.v2_bugs_result or args.v2_clean_result:
            method_results['v2 (Case Table)'] = {
                'bugs': Path(args.v2_bugs_result) if args.v2_bugs_result else None,
                'clean': Path(args.v2_clean_result) if args.v2_clean_result else None
            }
        if args.v1_bugs_result or args.v1_clean_result:
            method_results['v1 (Orchestrator)'] = {
                'bugs': Path(args.v1_bugs_result) if args.v1_bugs_result else None,
                'clean': Path(args.v1_clean_result) if args.v1_clean_result else None
            }
        if args.control_bugs_result or args.control_clean_result:
            method_results['Control (Plain LLM)'] = {
                'bugs': Path(args.control_bugs_result) if args.control_bugs_result else None,
                'clean': Path(args.control_clean_result) if args.control_clean_result else None
            }

        res = analyze_seeded_bugs(
            clean_dir=args.clean_dir,
            bugs_dir=args.bugs_dir,
            method_results=method_results,
            output_dir=args.output_dir,
            python=args.python
        )
        print(json.dumps({'status': res['status'], 'reportJson': res['reportJson'], 'reportMd': res['reportMd']},
                         ensure_ascii=False, indent=2))
        return 0

    return 1


if __name__ == '__main__':
    sys.exit(main())
