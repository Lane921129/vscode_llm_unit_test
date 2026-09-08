import json
import pathlib
import sys
import tempfile
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).parent
sys.path.insert(0, str(SCRIPTS_DIR))
from fixture_scorecard import build_scorecard, format_markdown, write_scorecard


def report(target_file, target_function, coverage, mutation, error=False, generation_mode='llm-evidence-bound'):
    interrupted = '\n### ❌ 執行中斷（第 2 輪）\n' if error else ''
    mode_line = f'- **Tier 1 generation mode**: {generation_mode}\n' if generation_mode else ''
    return f'''# 突變測試與修復分析報告

- **目標檔案**: {target_file}
- **測試函式**: {target_function}

- **策略**: 請求 tier3，實際 Tier 3
{mode_line}- **覆蓋率**: {coverage}% (未覆蓋行號: 無)
- **突變分數**: {mutation}%
{interrupted}'''


class FixtureScorecardTests(unittest.TestCase):
    def write_report(self, root, directory, content):
        path = root / directory / 'final_report.md'
        path.parent.mkdir(parents=True)
        path.write_text(content, encoding='utf-8')
        return path

    def test_scorecard_uses_actual_report_facts_and_keeps_missing_fixtures_unpassed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            self.write_report(root, 'pass', report('/portable/tier1_boundary.py', 'clamp', 100, 100))
            self.write_report(root, 'below-threshold', report('/portable/tier1_exception.py', 'require_value', 60, 60))
            card = build_scorecard(root)

        results = {item['id']: item for item in card['results']}
        self.assertEqual(results['tier1-boundary']['status'], 'passed')
        self.assertEqual(results['tier1-boundary']['tier1_generation_mode'], 'llm-evidence-bound')
        self.assertEqual(results['tier1-boundary']['report'], 'pass/final_report.md')
        self.assertEqual(results['tier1-explicit-exception']['status'], 'threshold_failed')
        self.assertEqual(results['tier1-class-method']['status'], 'missing_report')
        self.assertEqual(card['status_counts']['passed'], 1)
        self.assertEqual(card['status_counts']['threshold_failed'], 1)

    def test_execution_error_cannot_be_counted_as_a_pass_and_outputs_are_machine_readable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            self.write_report(root, 'error', report('/portable/tier1_boundary.py', 'clamp', 100, 100, error=True))
            card = build_scorecard(root)
            output = root / 'scorecard'
            json_path, markdown_path = write_scorecard(card, output)
            stored = json.loads(json_path.read_text(encoding='utf-8'))
            markdown = markdown_path.read_text(encoding='utf-8')

        result = next(item for item in card['results'] if item['id'] == 'tier1-boundary')
        self.assertEqual(result['status'], 'execution_error')
        self.assertEqual(stored['schema_version'], 2)
        self.assertIn('execution_error', format_markdown(card))
        self.assertIn('Fixture Corpus Scorecard', markdown)

    def test_tier1_modes_are_not_mixed_and_can_be_scored_separately(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            self.write_report(root, 'llm', report('/portable/tier1_boundary.py', 'clamp', 100, 100, generation_mode='llm-evidence-bound'))
            self.write_report(root, 'fallback', report('/portable/tier1_boundary.py', 'clamp', 100, 100, generation_mode='deterministic-fallback'))

            mixed = build_scorecard(root)
            llm_only = build_scorecard(root, tier1_generation_mode='llm-evidence-bound')
            fallback_only = build_scorecard(root, tier1_generation_mode='deterministic-fallback')

        mixed_result = next(item for item in mixed['results'] if item['id'] == 'tier1-boundary')
        llm_result = next(item for item in llm_only['results'] if item['id'] == 'tier1-boundary')
        fallback_result = next(item for item in fallback_only['results'] if item['id'] == 'tier1-boundary')
        self.assertEqual(mixed_result['status'], 'mixed_generation_modes')
        self.assertEqual(mixed_result['available_tier1_generation_modes'], ['deterministic-fallback', 'llm-evidence-bound'])
        self.assertEqual(llm_result['status'], 'passed')
        self.assertEqual(llm_result['tier1_generation_mode'], 'llm-evidence-bound')
        self.assertEqual(fallback_result['status'], 'passed')
        self.assertEqual(fallback_result['tier1_generation_mode'], 'deterministic-fallback')

    def test_legacy_tier1_report_without_mode_is_not_counted_as_an_llm_result(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            self.write_report(root, 'legacy', report('/portable/tier1_boundary.py', 'clamp', 100, 100, generation_mode=None))
            card = build_scorecard(root)

        result = next(item for item in card['results'] if item['id'] == 'tier1-boundary')
        self.assertEqual(result['status'], 'incomplete_provenance')


if __name__ == '__main__':
    unittest.main()
