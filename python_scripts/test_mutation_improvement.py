import ast
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from basic_mutation_runner import mutation_candidates, find_target_scope
from mutation_probe_plan import plan
from deduplicate_trace_tests import deduplicate
from fixture_scorecard import report_fields
import tempfile

SOURCE = '''def categorize(amount, scale):
    factor = scale / 10
    value = round(amount / factor ** 2, 2)
    if value < 7.5:
        label = 'low'
    elif 7.5 <= value < 13:
        label = 'middle'
    elif 13 <= value < 21:
        label = 'high'
    else:
        label = 'end'
    return value, label
'''


def payload(source=SOURCE, target='categorize'):
    tree = ast.parse(source)
    mutants = mutation_candidates(tree, find_target_scope(tree, target))
    return {'source': source, 'target': target,
            'mutants': [{**m, 'status': 'SURVIVED', 'id': str(i)} for i, m in enumerate(mutants)],
            'observations': [{'args': ['2', '10'], 'call_assertable': True}]}


class MutationInputsTests(unittest.TestCase):
    def test_starting_tier_is_not_used_as_retained_scorecard_tier(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'final_report.md'
            report.write_text('- **起始策略**: 請求 tier2，起始 Tier 2（中途切換見策略執行摘要）\n', encoding='utf-8')
            fields = report_fields(report)
            self.assertEqual(fields['requested_tier'], 'tier2')
            self.assertIsNone(fields['resolved_tier'])

    def test_boundaries_are_inputs_only_and_redundant_bounds_remain_in_score(self):
        result = plan(payload())
        self.assertFalse(result['assertionOracle'])
        self.assertTrue(result['inputs'])
        reached = {round(i['args'][0] / (i['args'][1] / 10) ** 2, 2) for i in result['inputs']}
        self.assertTrue({7.5, 13, 21}.issubset(reached))
        self.assertLessEqual(len(result['inputs']), 12)
        self.assertTrue(all(set(i) == {'args', 'kwargs', 'mutantId'} for i in result['inputs']))
        equivalents = [d for d in result['diagnostics'] if d['status'] == 'conditional-equivalence']
        self.assertEqual(len(equivalents), 2)
        self.assertTrue(all(d['excludedFromScore'] is False for d in equivalents))

    def test_unknown_calls_side_effects_and_blocked_observations_do_not_supply_inputs(self):
        for expression in ["helper(amount)", "__import__('os').system('echo unsafe')", 'amount * amount']:
            data = payload(SOURCE.replace('round(amount / factor ** 2, 2)', expression))
            self.assertEqual(plan(data)['inputs'], [])
        data = payload()
        data['observations'][0]['call_assertable'] = False
        self.assertEqual(plan(data)['inputs'], [])
        data['observations'] = [{'args': ["__import__('os').system('echo unsafe')", '10']}]
        self.assertEqual(plan(data)['inputs'], [])

    def test_source_mapping_and_custom_setup_are_not_guessed(self):
        data = payload()
        for item in data['mutants']: item['line'] += 100
        self.assertEqual(plan(data)['inputs'], [])
        data = payload()
        data['source'] = 'round = custom_round\n' + SOURCE
        self.assertEqual(plan(data)['inputs'], [])
        data = payload()
        data['observations'][0]['constructor_args'] = ['1']
        self.assertEqual(plan(data)['inputs'], [])

    def test_existing_boundaries_and_unmatched_thresholds_are_not_relabelled_as_progress(self):
        data = payload('def categorize(amount, scale):\n    if amount < 7.5: return 0\n    return scale\n')
        data['observations'] = [{'args': ['7.5', '10']}]
        self.assertEqual(plan(data)['inputs'], [])
        data = payload(SOURCE.replace('elif 7.5 <= value', 'elif 8 <= value'))
        self.assertEqual(len([d for d in plan(data)['diagnostics'] if d.get('line') == 6]), 0)


METHOD = '''    def test_copy(self):
        result = target(2)
        self.assertEqual(result, 4)
'''
BASE = 'import unittest\nfrom sample import target\nclass TestVerifiedTrace_target(unittest.TestCase):\n' + METHOD


class TraceDeduplicationTests(unittest.TestCase):
    def test_exact_copies_removed_but_baseline_and_distinct_cases_preserved(self):
        code = BASE + 'class Model(unittest.TestCase):\n' + METHOD + METHOD.replace('test_copy', 'test_other').replace('target(2)', 'target(3)')
        result = deduplicate(code, 'target')
        self.assertEqual(result['removed'], 1)
        tree = ast.parse(result['code'])
        self.assertEqual(sum(isinstance(n, ast.FunctionDef) for n in ast.walk(tree)), 2)
        self.assertEqual(deduplicate(result['code'], 'target')['removed'], 0)

    def test_fixture_helpers_decorators_and_other_assertions_are_preserved(self):
        for content in ["    def setUp(self):\n        self.flag = True\n" + METHOD,
                        '    @patch("sample.target")\n' + METHOD,
                        METHOD.replace('4)', '5)'),
                        METHOD.replace('result = target(2)', 'result = self.helper(2)')]:
            code = BASE + 'class Model(unittest.TestCase):\n' + content
            self.assertEqual(deduplicate(code, 'target')['code'], code)

    def test_empty_model_class_keeps_valid_python_and_runner_baseline(self):
        result = deduplicate(BASE + 'class Model(unittest.TestCase):\n' + METHOD, 'target')
        self.assertEqual(result['removed'], 1)
        ast.parse(result['code'])
        self.assertIn('class Model(unittest.TestCase):\n    pass', result['code'])
        self.assertIn('class TestVerifiedTrace_target', result['code'])


if __name__ == '__main__':
    unittest.main()
