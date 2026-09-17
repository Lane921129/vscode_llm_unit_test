import json
import hashlib
import pathlib
import sys
import tempfile
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).parent
sys.path.insert(0, str(SCRIPTS_DIR))
from fixture_scorecard import DEFAULT_BATCH_MANIFEST, build_scorecard, format_markdown, load_manifest, main, write_scorecard


def report(target_file, target_function, coverage, mutation, error=False, generation_mode='llm-evidence-bound', failure_category=None, resolved_tier=1, model_identity='cloud/test-model'):
    interrupted = '\n### ❌ 執行中斷（第 2 輪）\n' if error else ''
    mode_line = f'- **Tier 1 generation mode**: {generation_mode}\n' if generation_mode else ''
    failure_line = f'- **失敗分類**: {failure_category}\n' if failure_category else ''
    return f'''# 突變測試與修復分析報告

- **目標檔案**: {target_file}
- **測試函式**: {target_function}

- **模型識別**: `{model_identity}`
- **Reviewer status**: completed
- **策略**: 請求 tier{resolved_tier}，實際 Tier {resolved_tier}
{mode_line}{failure_line}- **覆蓋率**: {coverage}% (未覆蓋行號: 無)
- **突變分數**: {mutation}%
{interrupted}'''


class FixtureScorecardTests(unittest.TestCase):
    def test_selected_target_coverage_is_bound_to_retained_test_and_keeps_module_coverage_separate(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            path = self.write_report(root, 'case', report('/portable/tier1_class.py', 'Labeler.render', 86, 100))
            code = b'# retained neutral fixture\n'
            path.with_name('loop1_test.py').write_bytes(code)
            identity = {'runId': 'run', 'sourceHash': 'source', 'target': 'Labeler.render'}
            path.with_name('run_manifest.json').write_text(json.dumps(identity), encoding='utf-8')
            selected = {'qualifiedName': 'Labeler.render', 'executableLines': [6], 'missingLines': [], 'branchesCovered': True}
            knowledge = {**identity, 'terminalStatus': 'passed', 'reviewStatus': 'completed', 'resolvedTier': 1,
                         'acceptedTest': 'loop1_test.py', 'acceptedCodeHash': hashlib.sha256(code).hexdigest(),
                         'coverage': {'coverageText': '86%', 'selectedTarget': selected}, 'mutationScore': 100, 'qualityGaps': []}
            def evaluate():
                path.with_name('function_knowledge.json').write_text(json.dumps(knowledge), encoding='utf-8')
                return next(item for item in build_scorecard(root)['results'] if item['id'] == 'tier1-class-method')
            result = evaluate()
            self.assertEqual((result['coverage'], result['module_coverage'], result['coverage_scope']), (100, 86, 'selected-target'))
            self.assertEqual(result['status'], 'passed')
            knowledge['coverage']['coverageText'] = ''
            self.assertIsNone(evaluate()['module_coverage'], 'a target measurement cannot invent missing module coverage')
            knowledge['coverage']['coverageText'] = '86%'
            selected['missingLines'] = [6]
            self.assertEqual(evaluate()['status'], 'threshold_failed')
            selected.update(missingLines=[], branchesCovered=False)
            self.assertEqual(evaluate()['status'], 'quality_incomplete')
            selected.update(branchesCovered=True, qualifiedName='render')
            self.assertEqual(evaluate()['status'], 'incomplete_provenance')
            selected['qualifiedName'] = 'Labeler.render'
            selected['executableLines'] = []
            self.assertEqual(evaluate()['status'], 'incomplete_provenance')
            selected['executableLines'] = [6]
            knowledge['resolvedTier'] = 2
            self.assertEqual(evaluate()['status'], 'tier_mismatch', 'retained Tier supersedes stale report header')
            knowledge['resolvedTier'] = 1
            del knowledge['coverage']['selectedTarget']
            self.assertEqual(evaluate()['status'], 'threshold_failed', 'legacy module scores are never silently upgraded')

    def test_incomplete_reviews_missing_review_provenance_and_unexecuted_runs_never_pass(self):
        for review_status, terminal, expected in [
                ('incomplete', 'passed', 'review_incomplete'),
                ('completed', 'execution-passed-review-incomplete', 'review_incomplete'),
                ('completed', 'stub-smoke-generated', 'incomplete_run'),
                ('completed', 'running', 'incomplete_run'),
                ('completed', 'retained-after-failure', 'incomplete_run'),
                (None, None, 'incomplete_provenance'),
                ('not-required', None, 'incomplete_provenance')]:
            with self.subTest(review_status=review_status, terminal=terminal), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder)
                content = report('/portable/tier1_boundary.py', 'clamp', 100, 100)
                content = content.replace('- **Reviewer status**: completed\n',
                                          f'- **Reviewer status**: {review_status}\n' if review_status else '')
                path = self.write_report(root, 'case', content)
                if terminal:
                    path.with_name('function_knowledge.json').write_text(json.dumps({
                        'terminalStatus': terminal, 'reviewStatus': review_status}), encoding='utf-8')
                result = next(item for item in build_scorecard(root)['results'] if item['id'] == 'tier1-boundary')
                self.assertEqual(result['status'], expected)

    def test_scorecard_binds_scores_to_retained_file_and_rejects_stale_or_incomplete_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            path = self.write_report(root, 'case', report('/portable/tier1_boundary.py', 'clamp', 100, 100))
            code = b'# neutral retained test\n'
            path.with_name('loop1_test.py').write_bytes(code)
            identity = {'runId': 'neutral-run', 'sourceHash': 'neutral-source'}
            path.with_name('run_manifest.json').write_text(json.dumps(identity), encoding='utf-8')
            knowledge = {**identity, 'terminalStatus': 'passed', 'reviewStatus': 'completed',
                         'acceptedTest': 'loop1_test.py', 'acceptedCodeHash': hashlib.sha256(code).hexdigest(),
                         'coverage': {'coverageText': '80%'}, 'mutationScore': 70, 'qualityGaps': []}
            def evaluate():
                path.with_name('function_knowledge.json').write_text(json.dumps(knowledge), encoding='utf-8')
                return next(item for item in build_scorecard(root)['results'] if item['id'] == 'tier1-boundary')
            result = evaluate()
            self.assertEqual((result['coverage'], result['mutation_score']), (80, 70))
            self.assertEqual(result['status'], 'threshold_failed')
            knowledge.update(coverage={'coverageText': '100%'}, mutationScore=100, qualityGaps=['missing branch'])
            self.assertEqual(evaluate()['status'], 'quality_incomplete')
            knowledge['qualityGaps'] = []
            self.assertEqual(evaluate()['status'], 'passed')
            path.with_name('loop1_test.py').write_bytes(b'# changed\n')
            self.assertEqual(evaluate()['status'], 'incomplete_provenance')

    def test_legacy_review_warning_and_last_loop_scores_cannot_be_hidden_by_earlier_high_scores(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            content = report('/portable/tier1_boundary.py', 'clamp', 100, 100)
            content = content.replace('- **Reviewer status**: completed\n', '') + '\nReviewer 審查未完成\n'
            path = self.write_report(root, 'case', content)
            def evaluate():
                return next(item for item in build_scorecard(root)['results'] if item['id'] == 'tier1-boundary')
            self.assertEqual(evaluate()['status'], 'review_incomplete')
            path.write_text(report('/portable/tier1_boundary.py', 'clamp', 100, 70) +
                            '\n- **覆蓋率**: 70%\n- **突變分數**: 100%\n', encoding='utf-8')
            self.assertEqual(evaluate()['status'], 'threshold_failed')

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
            self.write_report(root, 'error', report('/portable/tier1_boundary.py', 'clamp', 100, 100, error=True, failure_category='model-format'))
            card = build_scorecard(root)
            output = root / 'scorecard'
            json_path, markdown_path = write_scorecard(card, output)
            stored = json.loads(json_path.read_text(encoding='utf-8'))
            markdown = markdown_path.read_text(encoding='utf-8')

        result = next(item for item in card['results'] if item['id'] == 'tier1-boundary')
        self.assertEqual(result['status'], 'execution_error')
        self.assertEqual(result['failure_category'], 'model-format')
        self.assertEqual(stored['schema_version'], 3)
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

    def test_scorecard_filters_the_exact_provider_model_identity(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            self.write_report(root, 'cloud', report('/portable/tier1_boundary.py', 'clamp', 100, 100, model_identity='cloud/shared-name'))
            self.write_report(root, 'local', report('/portable/tier1_boundary.py', 'clamp', 100, 100, model_identity='local/shared-name'))
            cloud = build_scorecard(root, model_identity='cloud/shared-name')
            unavailable = build_scorecard(root, model_identity='custom/shared-name')

        cloud_result = next(item for item in cloud['results'] if item['id'] == 'tier1-boundary')
        unavailable_result = next(item for item in unavailable['results'] if item['id'] == 'tier1-boundary')
        self.assertEqual(cloud_result['status'], 'passed')
        self.assertEqual(cloud_result['model_identity'], 'cloud/shared-name')
        self.assertEqual(cloud_result['available_model_identities'], ['cloud/shared-name', 'local/shared-name'])
        self.assertEqual(unavailable_result['status'], 'missing_report')

    def test_tier1_llm_release_gate_requires_all_llm_reports_at_the_correct_tier(self):
        tier1_fixtures = [fixture for fixture in load_manifest()['fixtures'] if fixture['tier'] == 1]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            for fixture in tier1_fixtures:
                self.write_report(
                    root,
                    fixture['id'],
                    report(
                        f"/portable/{fixture['source']}", fixture['target'], 100, 100,
                        generation_mode='llm-evidence-bound', resolved_tier=1
                    )
                )
            unfiltered = build_scorecard(root)
            llm_only = build_scorecard(root, tier1_generation_mode='llm-evidence-bound', model_identity='cloud/test-model')
            self.assertFalse(unfiltered['tier1_llm_release']['ready'])
            self.assertTrue(llm_only['tier1_llm_release']['ready'])
            self.assertEqual(llm_only['tier1_llm_release']['passed'], len(tier1_fixtures))
            self.assertEqual(main([str(root), '--model-identity', 'cloud/test-model', '--require-tier1-llm-release']), 0)

            self.write_report(
                root,
                'wrong-tier',
                report('/portable/tier1_boundary.py', 'clamp', 100, 100, resolved_tier=2)
            )
            mismatch = build_scorecard(root, tier1_generation_mode='llm-evidence-bound', model_identity='cloud/test-model')
            self.assertEqual(main([str(root), '--model-identity', 'cloud/test-model', '--require-tier1-llm-release']), 1)

        result = next(item for item in mismatch['results'] if item['id'] == 'tier1-boundary')
        self.assertEqual(result['status'], 'tier_mismatch')
        self.assertFalse(mismatch['tier1_llm_release']['ready'])

    def test_lab_batch_manifest_scores_only_the_five_selected_fixtures(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            card = build_scorecard(temp_dir, batch_manifest_path=DEFAULT_BATCH_MANIFEST)

        self.assertEqual(card['batch_name'], 'five-category-lab-batch')
        self.assertEqual(card['fixture_count'], 5)
        self.assertEqual(
            [item['id'] for item in card['results']],
            [
                'tier1-boundary',
                'tier1-class-method',
                'tier3-database-context',
                'tier4-async-context',
                'tier3-http-client',
            ],
        )
        self.assertIn('five-category-lab-batch', format_markdown(card))


if __name__ == '__main__':
    unittest.main()
