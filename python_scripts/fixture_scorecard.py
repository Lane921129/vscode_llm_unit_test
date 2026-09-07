"""Build a reproducible model/Tier scorecard from extension final reports.

The generator deliberately does not call a model or manufacture test output.
It reads only completed ``final_report.md`` files, maps them to the public
fixture corpus, and compares the reported coverage and mutation score with the
manifest thresholds.  This makes a later Ollama, Cloud, or Custom API run
comparable without adding credentials to the repository.

Usage:
    python python_scripts/fixture_scorecard.py <report-root>
    python python_scripts/fixture_scorecard.py <report-root> --output-dir <dir> --require-complete
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = ROOT / 'test' / 'fixtures' / 'python' / 'manifest.json'
REPORT_NAME = 'final_report.md'


def load_manifest(manifest_path=DEFAULT_MANIFEST):
    """Load the versioned public fixture contract without executing fixtures."""
    return json.loads(Path(manifest_path).read_text(encoding='utf-8'))


def percentage_values(markdown, field_name):
    pattern = re.compile(rf'\*\*{re.escape(field_name)}\*\*:\s*(\d+(?:\.\d+)?)%')
    return [float(value) for value in pattern.findall(markdown)]


def report_fields(report_path):
    """Extract only stable, user-visible facts from one final report."""
    text = Path(report_path).read_text(encoding='utf-8', errors='replace')
    target_match = re.search(r'^- \*\*目標檔案\*\*:\s*(.+)$', text, re.MULTILINE)
    function_match = re.search(r'^- \*\*測試函式\*\*:\s*(.+)$', text, re.MULTILINE)
    tier_match = re.search(r'^- \*\*策略\*\*:\s*請求\s+([^，\n]+)，實際 Tier\s+(\d+)', text, re.MULTILINE)
    coverage = percentage_values(text, '覆蓋率')
    mutation = percentage_values(text, '突變分數')
    return {
        'target_file': target_match.group(1).strip() if target_match else None,
        'target_function': function_match.group(1).strip() if function_match else None,
        'requested_tier': tier_match.group(1).strip() if tier_match else None,
        'resolved_tier': int(tier_match.group(2)) if tier_match else None,
        # A report can contain several repair loops. The rollback implementation
        # retains the best verified test file, so the highest reported value is
        # the conservative comparable fact for that session.
        'coverage': max(coverage) if coverage else None,
        'mutation_score': max(mutation) if mutation else None,
        'execution_error': '### ❌ 執行中斷' in text,
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


def evaluate_fixture(report_root, fixture):
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
        'reason': '找不到對應的 final_report.md。',
    }
    if not matches:
        return result

    report_path, fields = matches[0]
    result.update({
        'report': str(report_path.relative_to(report_root)).replace('\\', '/'),
        'coverage': fields['coverage'],
        'mutation_score': fields['mutation_score'],
        'requested_tier': fields['requested_tier'],
        'resolved_tier': fields['resolved_tier'],
    })
    if fields['execution_error']:
        result.update(status='execution_error', reason='報告記錄了執行中斷；不採計既有分數。')
    elif fields['coverage'] is None or fields['mutation_score'] is None:
        result.update(status='unscored', reason='報告缺少可解析的 coverage 或突變分數。')
    elif fields['coverage'] < result['min_line_coverage'] or fields['mutation_score'] < result['min_mutation_score']:
        result.update(status='threshold_failed', reason='coverage 或 mutation score 未達 fixture 門檻。')
    else:
        result.update(status='passed', reason='coverage 與 mutation score 均達 fixture 門檻。')
    if len(matches) > 1:
        result['reason'] += f' 已選用最新的 {len(matches)} 份對應報告。'
    return result


def build_scorecard(report_root, manifest_path=DEFAULT_MANIFEST):
    report_root = Path(report_root).resolve()
    manifest = load_manifest(manifest_path)
    results = [evaluate_fixture(report_root, fixture) for fixture in manifest['fixtures']]
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
        'schema_version': 1,
        'manifest_schema_version': manifest['schema_version'],
        'fixture_count': len(results),
        'status_counts': dict(sorted(status_counts.items())),
        'tier_summary': tier_summary,
        'results': results,
    }


def format_markdown(scorecard):
    lines = [
        '# Fixture Corpus Scorecard',
        '',
        '> 此報表僅彙整 extension 已產生的 final_report.md；未產生或未計分的項目不會被視為通過。',
        '',
        f"- Fixture 總數：{scorecard['fixture_count']}",
        f"- 通過：{scorecard['status_counts'].get('passed', 0)}",
        f"- 已計分但未達門檻：{scorecard['status_counts'].get('threshold_failed', 0)}",
        f"- 未計分／缺報告／執行中斷：{scorecard['fixture_count'] - scorecard['status_counts'].get('passed', 0) - scorecard['status_counts'].get('threshold_failed', 0)}",
        '',
        '| Tier | Fixture | 狀態 | Coverage | Mutation | 報告 |',
        '| --- | --- | --- | --- | --- | --- |',
    ]
    for result in scorecard['results']:
        coverage = f"{result['coverage']:g}%" if result['coverage'] is not None else 'N/A'
        mutation = f"{result['mutation_score']:g}%" if result['mutation_score'] is not None else 'N/A'
        report = result['report'] or '—'
        lines.append(
            f"| {result['tier']} | {result['id']} | {result['status']} | {coverage} / {result['min_line_coverage']}% | "
            f"{mutation} / {result['min_mutation_score']}% | {report} |"
        )
    lines.extend(['', '## 判定說明', ''])
    for result in scorecard['results']:
        lines.append(f"- `{result['id']}`：{result['reason']}")
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
    args = parser.parse_args(argv)

    root = Path(args.report_root)
    if not root.is_dir():
        parser.error(f'report root is not a directory: {root}')
    scorecard = build_scorecard(root)
    output_dir = Path(args.output_dir) if args.output_dir else root / 'fixture_scorecard'
    json_path, markdown_path = write_scorecard(scorecard, output_dir)
    print(json.dumps({
        'fixture_count': scorecard['fixture_count'],
        'status_counts': scorecard['status_counts'],
        'json': str(json_path),
        'markdown': str(markdown_path),
    }, ensure_ascii=False))
    if args.require_complete and scorecard['status_counts'].get('passed', 0) != scorecard['fixture_count']:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
