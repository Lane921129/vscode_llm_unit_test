"""Build a reproducible model/Tier scorecard from extension final reports.

The generator deliberately does not call a model or manufacture test output.
It reads only completed ``final_report.md`` files, maps them to the public
fixture corpus, and compares the reported coverage and mutation score with the
manifest thresholds.  This makes a later Ollama, Cloud, or Custom API run
comparable without adding credentials to the repository.

Usage:
    python python_scripts/fixture_scorecard.py <report-root>
    python python_scripts/fixture_scorecard.py <report-root> --output-dir <dir> --require-complete
    python python_scripts/fixture_scorecard.py <report-root> --model-identity cloud/example --require-tier1-llm-release
"""

import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

from lab_batch_plan import DEFAULT_BATCH_MANIFEST, resolve_lab_batch
from quality_policy import create_fixture_quality_policy, evaluate_quality, validate_quality_policy


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = ROOT / 'test' / 'fixtures' / 'python' / 'manifest.json'
REPORT_NAME = 'final_report.md'
TIER1_GENERATION_MODES = {'llm-evidence-bound', 'deterministic-fallback'}


def load_manifest(manifest_path=DEFAULT_MANIFEST):
    """Load the versioned public fixture contract without executing fixtures."""
    return json.loads(Path(manifest_path).read_text(encoding='utf-8'))


def percentage_values(markdown, field_name):
    pattern = re.compile(rf'\*\*{re.escape(field_name)}\*\*:\s*(\d+(?:\.\d+)?)%')
    return [float(value) for value in pattern.findall(markdown)]


def _local_artifact(directory, name):
    if type(name) is not str or not name or Path(name).name != name or '/' in name or '\\' in name:
        raise ValueError('invalid artifact name')
    return directory / name


def _same_json(left, right):
    # Match JSON number semantics without Python's True == 1 shortcut. Mutation
    # contexts may carry fractional stage deadlines; policy hashes remain on
    # the stricter shared canonical integer contract.
    if type(left) in (int, float) and type(right) in (int, float):
        try:
            return math.isfinite(left) and math.isfinite(right) and left == right
        except OverflowError:
            return False
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(_same_json(left[key], right[key]) for key in left)
    if type(left) is list:
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    return left == right


def _read_policy_assessment(report_path, knowledge, manifest, target_file, target_function):
    """Recompute new evidence; serialized pass booleans never authorize a pass."""
    if knowledge.get('evidenceValid') is False:
        raise ValueError('quality evidence explicitly invalidated')
    directory = Path(report_path).parent
    snapshot = json.loads((directory / 'quality_baseline.json').read_text(encoding='utf-8'))
    if any(item.get('qualityContractVersion') != 'quality-policy-v1' for item in (manifest, knowledge)):
        raise ValueError('quality contract version missing or unsupported')
    policies = [validate_quality_policy(item.get('qualityPolicy')) for item in (manifest, knowledge, snapshot)]
    if not all(item['ok'] for item in policies) or not all(_same_json(policies[0]['policy'], item['policy']) for item in policies[1:]):
        raise ValueError('quality policies do not match')
    policy = policies[0]['policy']
    if snapshot.get('schemaVersion') != 'quality-baseline-v1' or not manifest.get('runId') \
            or manifest['runId'] != knowledge.get('runId') \
            or type(knowledge.get('terminalStatus')) is not str \
            or any(item.get('sourceHash') != manifest.get('sourceHash') for item in (knowledge, snapshot)) \
            or any(item.get('target') != target_function for item in (manifest, knowledge, snapshot)):
        raise ValueError('quality snapshot identity mismatch')
    code = snapshot.get('code')
    digest = hashlib.sha256(_local_artifact(directory, snapshot.get('testFile')).read_bytes()).hexdigest()
    accepted_digest = hashlib.sha256(_local_artifact(directory, knowledge.get('acceptedTest')).read_bytes()).hexdigest()
    if type(code) is not str or hashlib.sha256(code.encode('utf-8')).hexdigest() != digest \
            or digest != snapshot.get('codeHash') or digest != knowledge.get('acceptedCodeHash') or digest != accepted_digest:
        raise ValueError('quality snapshot test mismatch')
    for field in ('mutation', 'reviewStatus', 'generationMode', 'execution'):
        if not _same_json(snapshot.get(field), knowledge.get(field)):
            raise ValueError('quality snapshot evidence mismatch')
    if not _same_json(snapshot['coverage']['assessment'], knowledge['coverage']['assessment']):
        raise ValueError('quality snapshot coverage mismatch')
    if snapshot.get('tier') != knowledge.get('resolvedTier'):
        raise ValueError('quality snapshot tier mismatch')
    if any(type(snapshot.get(field)) is not list or not all(type(item) is str for item in snapshot[field])
           for field in ('qualityGaps', 'measuredQualityGaps')):
        raise ValueError('invalid quality gap provenance')
    target_scope = {'kind': 'function', 'qualifiedName': target_function}
    evidence = {
        'identity': {'sourcePath': target_file, 'sourceHash': manifest.get('sourceHash'), 'testHash': digest,
                     'targetScope': target_scope, 'policyHash': policy['policyHash']},
        'executionPassed': type(snapshot.get('execution')) is str and bool(snapshot['execution'].strip()),
        'coverage': {'sourceHash': manifest.get('sourceHash'), 'testHash': digest, 'targetScope': target_scope,
                     'assessment': snapshot['coverage']['assessment']},
        'mutation': snapshot['mutation'], 'reviewStatus': snapshot.get('reviewStatus'),
        # Coverage gaps are derived display strings, already evaluated through
        # native counts/arcs. They must not become a second threshold policy.
        'generationMode': snapshot.get('generationMode'), 'qualityGaps': [],
    }
    assessed = evaluate_quality(policy, evidence)
    if not _same_json(assessed, snapshot.get('qualityAssessment')) or not _same_json(assessed, knowledge.get('qualityAssessment')):
        raise ValueError('quality assessment does not match recomputed evidence')
    return policy, assessed


def report_fields(report_path):
    """Extract only stable, user-visible facts from one final report."""
    text = Path(report_path).read_text(encoding='utf-8', errors='replace')
    target_match = re.search(r'^- \*\*目標檔案\*\*:\s*(.+)$', text, re.MULTILINE)
    function_match = re.search(r'^- \*\*測試函式\*\*:\s*(.+)$', text, re.MULTILINE)
    tier_match = re.search(r'^- \*\*策略\*\*:\s*請求\s+([^，\n]+)，實際 Tier\s+(\d+)', text, re.MULTILINE)
    model_identity_match = re.search(r'^- \*\*模型識別\*\*:\s*`?([^`\n]+?)`?\s*$', text, re.MULTILINE)
    generation_mode_match = re.search(r'^- \*\*Tier 1 generation mode\*\*:\s*([^\s]+)\s*$', text, re.MULTILINE)
    failure_category_match = re.search(r'^- \*\*失敗分類\*\*:\s*([^\s]+)\s*$', text, re.MULTILINE)
    coverage = percentage_values(text, '覆蓋率')
    mutation = percentage_values(text, '突變分數')
    review_states = re.findall(r'^- \*\*Reviewer status\*\*:\s*([^\s]+)\s*$', text, re.MULTILINE)
    review_status = review_states[-1] if review_states else None
    if review_status is None and 'Reviewer 審查未完成' in text:
        review_status = 'incomplete'
    terminal_status, quality_gaps, invalid_journal = None, [], False
    new_quality_policy, policy, quality_assessment = False, None, None
    checkpoint_path = Path(report_path).with_name('quality_baseline.json')
    if checkpoint_path.exists():
        try:
            checkpoint = json.loads(checkpoint_path.read_text(encoding='utf-8'))
            new_quality_policy = any(key in checkpoint for key in ('qualityPolicy', 'qualityAssessment', 'qualityContractVersion'))
        except (OSError, ValueError, TypeError):
            pass  # A declared new contract below still fails its mandatory read.
    coverage_scope, module_coverage, retained_tier = 'module', coverage[-1] if coverage else None, None
    journal_path = Path(report_path).with_name('function_knowledge.json')
    if journal_path.exists():
        try:
            knowledge = json.loads(journal_path.read_text(encoding='utf-8'))
            new_quality_policy = new_quality_policy or any(key in knowledge for key in ('qualityPolicy', 'qualityAssessment', 'qualityContractVersion'))
            terminal_status = knowledge.get('terminalStatus')
            review_status = knowledge.get('reviewStatus', review_status)
            if not knowledge.get('reviewStatus') and any('審查未完成' in warning for warning in knowledge.get('reviewWarnings', [])):
                review_status = 'incomplete'
            quality_gaps = knowledge.get('qualityGaps', [])
            # Scores and review must describe the retained file from this run,
            # never independently selected maxima from different repair loops.
            manifest = json.loads(journal_path.with_name('run_manifest.json').read_text(encoding='utf-8'))
            new_quality_policy = new_quality_policy or 'qualityPolicy' in manifest or 'qualityContractVersion' in manifest
            accepted = knowledge.get('acceptedTest', '')
            if not accepted or Path(accepted).name != accepted or '/' in accepted or '\\' in accepted:
                raise ValueError('missing retained test')
            digest = hashlib.sha256(journal_path.with_name(accepted).read_bytes()).hexdigest()
            if (not knowledge.get('runId') or manifest.get('runId') != knowledge['runId']
                    or manifest.get('sourceHash') != knowledge.get('sourceHash')
                    or digest != knowledge.get('acceptedCodeHash')):
                raise ValueError('mismatched evidence')
            coverage_text = (knowledge.get('coverage') or {}).get('coverageText', '')
            coverage = [float(value) for value in re.findall(r'^(\d+(?:\.\d+)?)%$', coverage_text)]
            module_coverage = coverage[-1] if coverage else None
            selected = (knowledge.get('coverage') or {}).get('selectedTarget')
            if selected is not None:
                if (not isinstance(selected, dict) or not function_match
                        or selected.get('qualifiedName') != function_match.group(1).strip()
                        or selected.get('qualifiedName') != manifest.get('target')):
                    raise ValueError('mismatched coverage target')
                lines, missing = selected.get('executableLines'), selected.get('missingLines')
                if (not isinstance(lines, list) or not lines or not isinstance(missing, list)
                        or any(type(line) is not int or line <= 0 for line in lines + missing)
                        or len(set(lines)) != len(lines) or len(set(missing)) != len(missing)
                        or not set(missing).issubset(lines) or type(selected.get('branchesCovered')) is not bool):
                    raise ValueError('invalid target coverage measurement')
                coverage = [100 * (len(lines) - len(missing)) / len(lines)]
                coverage_scope = 'selected-target'
                if not selected['branchesCovered']:
                    quality_gaps = [*quality_gaps, 'selected target has uncovered branches']
            if 'resolvedTier' in knowledge:
                retained_tier = knowledge['resolvedTier']
                if type(retained_tier) is not int or not 1 <= retained_tier <= 4:
                    raise ValueError('invalid retained tier')
            score = knowledge.get('mutationScore')
            mutation = [score] if isinstance(score, (int, float)) and not isinstance(score, bool) and 0 <= score <= 100 else []
            if new_quality_policy:
                policy, quality_assessment = _read_policy_assessment(report_path, knowledge, manifest,
                    target_match.group(1).strip() if target_match else None,
                    function_match.group(1).strip() if function_match else None)
                counts = quality_assessment['counts']
                coverage = [100 * counts['lines']['executed'] / counts['lines']['total']] if counts['lines'] else []
                mutation = [100 * counts['mutation']['killed'] / counts['mutation']['total']] \
                    if counts['mutation'] and counts['mutation']['total'] and quality_assessment['measurementStatus'] == 'complete' else []
                coverage_scope = 'selected-target'
                if retained_tier == 1 and knowledge.get('generationMode') != (generation_mode_match.group(1) if generation_mode_match else None):
                    raise ValueError('quality generation mode mismatch')
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            invalid_journal = True
    else:
        # A new-format manifest cannot silently fall back to Markdown when its
        # mandatory journal is absent. Old reports without policy stay readable.
        manifest_path = journal_path.with_name('run_manifest.json')
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                new_quality_policy = new_quality_policy or 'qualityPolicy' in manifest or 'qualityContractVersion' in manifest
                invalid_journal = new_quality_policy
            except (OSError, ValueError, TypeError):
                invalid_journal = True
    return {
        'target_file': target_match.group(1).strip() if target_match else None,
        'target_function': function_match.group(1).strip() if function_match else None,
        'requested_tier': tier_match.group(1).strip() if tier_match else None,
        'resolved_tier': retained_tier if retained_tier is not None else int(tier_match.group(2)) if tier_match else None,
        'model_identity': model_identity_match.group(1).strip() if model_identity_match else None,
        'tier1_generation_mode': generation_mode_match.group(1) if generation_mode_match else None,
        'failure_category': failure_category_match.group(1) if failure_category_match else None,
        'coverage': coverage[-1] if coverage else None,
        'coverage_scope': coverage_scope,
        'module_coverage': module_coverage,
        'mutation_score': mutation[-1] if mutation else None,
        'review_status': review_status,
        'terminal_status': terminal_status,
        'quality_gaps': quality_gaps,
        'invalid_journal': invalid_journal,
        'new_quality_policy': new_quality_policy,
        'quality_policy': policy,
        'quality_assessment': quality_assessment,
        'execution_error': '### ❌ 執行中斷' in text or '### 執行停止' in text,
    }


def matching_reports(report_root, fixture):
    """Find reports for the exact source filename and selected callable."""
    source_name = Path(fixture['source']).name
    target = fixture['target']
    matches = []
    for candidate in Path(report_root).rglob(REPORT_NAME):
        try:
            fields = report_fields(candidate)
        except OSError:
            continue
        reported_name = Path(fields['target_file']).name if fields['target_file'] else None
        if reported_name == source_name and fields['target_function'] == target:
            matches.append((candidate, fields))
    return sorted(matches, key=lambda pair: pair[0].stat().st_mtime, reverse=True)


def evaluate_fixture(report_root, fixture, tier1_generation_mode=None, model_identity=None, manifest_hash=None):
    """Classify one fixture without treating missing data as a passing score."""
    matches = matching_reports(report_root, fixture)
    result = {
        'id': fixture['id'],
        'tier': fixture['tier'],
        'target': fixture['target'],
        'min_line_coverage': fixture['acceptance']['min_line_coverage'],
        'min_mutation_score': fixture['acceptance']['min_mutation_score'],
        'status': 'missing_report',
        'report': None,
        'coverage': None,
        'mutation_score': None,
        'requested_tier': None,
        'resolved_tier': None,
        'tier1_generation_mode': None,
        'available_tier1_generation_modes': [],
        'model_identity': None,
        'available_model_identities': [],
        'failure_category': None,
        'review_status': None,
        'terminal_status': None,
        'reason': '找不到對應的 final_report.md。',
    }
    if not matches:
        return result

    known_model_identities = sorted({
        fields['model_identity']
        for _, fields in matches
        if fields['model_identity']
    })
    result['available_model_identities'] = known_model_identities
    if model_identity:
        matches = [
            (path, fields) for path, fields in matches
            if fields['model_identity'] == model_identity
        ]
        if not matches:
            result.update(
                status='missing_report',
                reason=f'找不到模型識別為 {model_identity} 的對應 final_report.md。'
            )
            return result

    if fixture['tier'] == 1:
        known_modes = sorted({
            fields['tier1_generation_mode']
            for _, fields in matches
            if fields['tier1_generation_mode'] in TIER1_GENERATION_MODES
        })
        result['available_tier1_generation_modes'] = known_modes
        if tier1_generation_mode:
            matches = [
                (path, fields) for path, fields in matches
                if fields['tier1_generation_mode'] == tier1_generation_mode
            ]
            if not matches:
                result.update(
                    status='missing_report',
                    reason=f'找不到 Tier 1 產生模式為 {tier1_generation_mode} 的對應 final_report.md。'
                )
                return result
        elif len(known_modes) > 1:
            result.update(
                status='mixed_generation_modes',
                reason='同一 fixture 同時有 LLM 與 deterministic fallback 報告；請以 --tier1-generation-mode 分開評分。'
            )
            return result

    report_path, fields = matches[0]
    result.update({
        'report': str(report_path.relative_to(report_root)).replace('\\', '/'),
        'coverage': fields['coverage'],
        'coverage_scope': fields['coverage_scope'],
        'module_coverage': fields['module_coverage'],
        'mutation_score': fields['mutation_score'],
        'requested_tier': fields['requested_tier'],
        'resolved_tier': fields['resolved_tier'],
        'model_identity': fields['model_identity'],
        'tier1_generation_mode': fields['tier1_generation_mode'],
        'failure_category': fields['failure_category'],
        'review_status': fields['review_status'],
        'terminal_status': fields['terminal_status'],
        'quality_policy': fields['quality_policy'],
        'quality_assessment': fields['quality_assessment'],
        'policy_mode': fields['quality_policy']['mode'] if fields['quality_policy'] else 'legacy',
    })
    if fixture['tier'] == 1 and fields['tier1_generation_mode'] not in TIER1_GENERATION_MODES:
        result.update(status='incomplete_provenance', reason='Tier 1 報告缺少可機讀的 generation mode；不與 LLM 或 deterministic fallback 成績混算。')
    elif fields['resolved_tier'] != fixture['tier']:
        result.update(
            status='tier_mismatch',
            reason=f"報告實際 Tier 為 {fields['resolved_tier'] if fields['resolved_tier'] is not None else '未知'}，與 fixture 要求的 Tier {fixture['tier']} 不一致。"
        )
    elif fields['execution_error']:
        result.update(status='execution_error', reason='報告記錄了執行中斷；不採計既有分數。')
    elif fields['terminal_status'] and fields['terminal_status'] not in {'passed', 'execution-passed-review-incomplete'}:
        result.update(status='incomplete_run', reason=f"執行尚未完整通過（{fields['terminal_status']}）；stub、running 或失敗不採計為通過。")
    elif fields['review_status'] == 'incomplete' or fields['terminal_status'] == 'execution-passed-review-incomplete':
        result.update(status='review_incomplete', reason='Reviewer 審查未完成；工具分數不能代替完整品質驗收。')
    elif fields['review_status'] != 'completed' and not (
            fields['review_status'] == 'not-required' and fields['tier1_generation_mode'] == 'deterministic-fallback'):
        result.update(status='incomplete_provenance', reason='缺少可確認的 Reviewer 完成狀態。')
    elif fields['invalid_journal']:
        result.update(status='incomplete_provenance', reason='執行 journal 不完整，或保留測試與執行證據的身分不一致。')
    elif fields['new_quality_policy']:
        policy, assessment = fields['quality_policy'], fields['quality_assessment']
        fixture_policy_matches = True
        if policy and policy['mode'] == 'fixture':
            try:
                expected_policy = create_fixture_quality_policy(fixtureId=fixture['id'], manifestHash=manifest_hash,
                    minLineCoverage=fixture['acceptance']['min_line_coverage'], minMutationScore=fixture['acceptance']['min_mutation_score'])
                fixture_policy_matches = _same_json(policy, expected_policy)
            except (ValueError, TypeError):
                fixture_policy_matches = False
        if not policy or not assessment or not fixture_policy_matches:
            result.update(status='incomplete_provenance', reason='品質政策與執行前 fixture 契約不一致，不能事後改用較低門檻。')
        elif assessment['policyStatus'] == 'unassessable':
            result.update(status='unscored', reason='品質測量不完整或不適用，不能形成完整通過結論。')
        elif assessment['policyStatus'] == 'below-threshold':
            numeric_only = set(assessment['reasons']).issubset({'line-threshold-not-met', 'mutation-threshold-not-met'})
            result.update(status='threshold_failed' if numeric_only else 'quality_incomplete',
                          reason='未符合執行前固定的品質政策：' + ', '.join(assessment['reasons']))
        elif not assessment['fullyPassed']:
            result.update(status='review_incomplete', reason='工具政策達標，但完整審查尚未完成。')
        else:
            result.update(status='passed', reason='符合執行前固定的品質政策：' + policy['policyId'])
    elif fields['quality_gaps']:
        result.update(status='quality_incomplete', reason='已測量的品質缺口仍未解決，不能以數值分數宣稱通過。')
    elif fields['coverage'] is None or fields['mutation_score'] is None:
        result.update(status='unscored', reason='報告缺少可解析的 coverage 或突變分數。')
    elif fields['coverage'] < result['min_line_coverage'] or fields['mutation_score'] < result['min_mutation_score']:
        result.update(status='threshold_failed', reason='coverage 或 mutation score 未達 fixture 門檻。')
    else:
        result.update(status='passed', reason='coverage 與 mutation score 均達 fixture 門檻。')
    if len(matches) > 1:
        result['reason'] += f' 已選用最新的 {len(matches)} 份對應報告。'
    return result


def tier1_llm_release_summary(results, tier1_generation_mode, model_identity):
    """Return a narrow, auditable gate for an LLM Tier 1 quality claim."""
    tier1_results = [item for item in results if item['tier'] == 1]
    blockers = [
        {'id': item['id'], 'status': item['status'], 'reason': item['reason']}
        for item in tier1_results
        if item['status'] != 'passed' or item['tier1_generation_mode'] != 'llm-evidence-bound'
    ]
    filter_is_llm = tier1_generation_mode == 'llm-evidence-bound'
    if not filter_is_llm:
        blockers.insert(0, {
            'id': 'generation-mode-filter',
            'status': 'wrong_generation_mode_filter',
            'reason': 'Tier 1 LLM 發行門檻必須以 --tier1-generation-mode llm-evidence-bound 建立 scorecard。'
        })
    if not model_identity:
        blockers.insert(0, {
            'id': 'model-identity-filter',
            'status': 'missing_model_identity_filter',
            'reason': 'Tier 1 LLM 發行門檻必須指定單一 --model-identity，不能混合不同 provider 或模型的報告。'
        })
    return {
        'required_generation_mode': 'llm-evidence-bound',
        'model_identity_filter': model_identity,
        'fixture_count': len(tier1_results),
        'passed': sum(item['status'] == 'passed' and item['tier1_generation_mode'] == 'llm-evidence-bound' for item in tier1_results),
        'ready': bool(tier1_results) and filter_is_llm and not blockers,
        'blockers': blockers,
    }


def build_scorecard(report_root, manifest_path=DEFAULT_MANIFEST, tier1_generation_mode=None,
                    model_identity=None, batch_manifest_path=None):
    report_root = Path(report_root).resolve()
    manifest = (
        resolve_lab_batch(manifest_path, batch_manifest_path)
        if batch_manifest_path
        else load_manifest(manifest_path)
    )
    if tier1_generation_mode and tier1_generation_mode not in TIER1_GENERATION_MODES:
        raise ValueError(f'unsupported Tier 1 generation mode: {tier1_generation_mode}')
    manifest_hash = hashlib.sha256(Path(manifest_path).read_bytes()).hexdigest()
    results = [
        evaluate_fixture(report_root, fixture, tier1_generation_mode, model_identity,
                         manifest_hash)
        for fixture in manifest['fixtures']
    ]
    status_counts = Counter(item['status'] for item in results)
    tier_summary = {}
    for tier in sorted({item['tier'] for item in results}):
        entries = [item for item in results if item['tier'] == tier]
        tier_summary[str(tier)] = {
            'total': len(entries),
            'passed': sum(item['status'] == 'passed' for item in entries),
            'scored': sum(item['status'] in {'passed', 'threshold_failed'} for item in entries),
        }
    return {
        'schema_version': 3,
        'manifest_schema_version': manifest['schema_version'],
        'batch_manifest_schema_version': manifest.get('batch_schema_version'),
        'batch_name': manifest.get('batch_name'),
        'batch_categories': manifest.get('categories', []),
        'tier1_generation_mode_filter': tier1_generation_mode,
        'model_identity_filter': model_identity,
        'fixture_count': len(results),
        'status_counts': dict(sorted(status_counts.items())),
        'tier_summary': tier_summary,
        'tier1_llm_release': tier1_llm_release_summary(results, tier1_generation_mode, model_identity),
        'results': results,
    }


def format_markdown(scorecard):
    lines = [
        '# Fixture Corpus Scorecard',
        '',
        '> 此報表僅彙整 extension 已產生的 final_report.md；未產生或未計分的項目不會被視為通過。',
        '',
        f"- Fixture 總數：{scorecard['fixture_count']}",
        f"- 批次：{scorecard['batch_name'] or '完整 fixture corpus'}",
        f"- 通過：{scorecard['status_counts'].get('passed', 0)}",
        f"- 已計分但未達門檻：{scorecard['status_counts'].get('threshold_failed', 0)}",
        f"- 未計分／缺報告／執行中斷：{scorecard['fixture_count'] - scorecard['status_counts'].get('passed', 0) - scorecard['status_counts'].get('threshold_failed', 0)}",
        f"- Tier 1 產生模式篩選：{scorecard['tier1_generation_mode_filter'] or '未篩選（混合模式會拒絕計分）'}",
        f"- 模型識別篩選：{scorecard['model_identity_filter'] or '未篩選（不可作為單一模型發行證據）'}",
        f"- Tier 1 LLM 發行門檻：{'通過' if scorecard['tier1_llm_release']['ready'] else '未通過'}（{scorecard['tier1_llm_release']['passed']}/{scorecard['tier1_llm_release']['fixture_count']}）",
        '',
        '| Tier | Fixture | 模型識別 | 產生模式 | 狀態 | 失敗分類 | Coverage（範圍） | Mutation | 報告 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ]
    for result in scorecard['results']:
        coverage = f"{result['coverage']:g}%" if result['coverage'] is not None else 'N/A'
        mutation = f"{result['mutation_score']:g}%" if result['mutation_score'] is not None else 'N/A'
        report = result['report'] or '—'
        lines.append(
            f"| {result['tier']} | {result['id']} | {result['model_identity'] or '—'} | {result['tier1_generation_mode'] or '—'} | {result['status']} | {result['failure_category'] or '—'} | {coverage} / {result['min_line_coverage']}% ({result.get('coverage_scope', 'module')}) | "
            f"{mutation} / {result['min_mutation_score']}% | {report} |"
        )
    lines.extend(['', '## 判定說明', ''])
    for result in scorecard['results']:
        lines.append(f"- `{result['id']}`：{result['reason']}")
    if scorecard['tier1_llm_release']['blockers']:
        lines.extend(['', '## Tier 1 LLM 發行門檻阻擋原因', ''])
        for blocker in scorecard['tier1_llm_release']['blockers']:
            lines.append(f"- `{blocker['id']}`（{blocker['status']}）：{blocker['reason']}")
    return '\n'.join(lines) + '\n'


def write_scorecard(scorecard, output_dir):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / 'fixture_scorecard.json'
    markdown_path = output_dir / 'fixture_scorecard.md'
    json_path.write_text(json.dumps(scorecard, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    markdown_path.write_text(format_markdown(scorecard), encoding='utf-8')
    return json_path, markdown_path


def main(argv=None):
    parser = argparse.ArgumentParser(description='Score public fixtures from existing extension reports.')
    parser.add_argument('report_root', help='Directory containing final_report.md files from extension runs.')
    parser.add_argument('--output-dir', help='Destination for fixture_scorecard.json and fixture_scorecard.md.')
    parser.add_argument('--require-complete', action='store_true', help='Return non-zero unless every fixture passes its thresholds.')
    parser.add_argument('--tier1-generation-mode', choices=sorted(TIER1_GENERATION_MODES), help='Score LLM and deterministic Tier 1 reports separately.')
    parser.add_argument('--model-identity', help='Exact provider/model identity recorded by the extension, for example cloud/gemma-4-31b-it.')
    parser.add_argument('--batch-manifest', help='Optional five-category lab batch manifest; score only the fixtures it selects.')
    parser.add_argument('--require-tier1-llm-release', action='store_true', help='Return non-zero unless every Tier 1 fixture has a passing llm-evidence-bound report.')
    args = parser.parse_args(argv)

    root = Path(args.report_root)
    if not root.is_dir():
        parser.error(f'report root is not a directory: {root}')
    if args.require_tier1_llm_release and args.tier1_generation_mode not in {None, 'llm-evidence-bound'}:
        parser.error('--require-tier1-llm-release requires llm-evidence-bound, not deterministic-fallback.')
    if args.require_tier1_llm_release and not args.model_identity:
        parser.error('--require-tier1-llm-release requires one --model-identity.')
    generation_mode = 'llm-evidence-bound' if args.require_tier1_llm_release else args.tier1_generation_mode
    scorecard = build_scorecard(
        root,
        tier1_generation_mode=generation_mode,
        model_identity=args.model_identity,
        batch_manifest_path=args.batch_manifest,
    )
    output_dir = Path(args.output_dir) if args.output_dir else root / 'fixture_scorecard'
    json_path, markdown_path = write_scorecard(scorecard, output_dir)
    print(json.dumps({
        'fixture_count': scorecard['fixture_count'],
        'status_counts': scorecard['status_counts'],
        'model_identity_filter': scorecard['model_identity_filter'],
        'batch_name': scorecard['batch_name'],
        'tier1_llm_release': scorecard['tier1_llm_release'],
        'json': str(json_path),
        'markdown': str(markdown_path),
    }, ensure_ascii=False))
    if args.require_complete and scorecard['status_counts'].get('passed', 0) != scorecard['fixture_count']:
        return 1
    if args.require_tier1_llm_release and not scorecard['tier1_llm_release']['ready']:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
