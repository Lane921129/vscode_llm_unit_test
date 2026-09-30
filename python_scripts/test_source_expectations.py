import ast
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from repair_source_expectations import repair
from validate_test_bindings import validate_bindings

SOURCE = '''def metric(weight, height):
    meters = height / 100
    score = round(weight / meters ** 2, 2)
    if score < 18.5:
        label = "low"
    elif score < 24:
        label = "normal"
    else:
        label = "high"
    return score, label
'''


def suite(body):
    return 'import unittest\nfrom metrics import metric\nclass TestMetric(unittest.TestCase):\n    def test_value(self):\n' + '\n'.join('        ' + line for line in body.splitlines()) + '\n'


class StructureEvidenceTests(unittest.TestCase):
    def validate(self, code):
        return validate_bindings(code, {'module': 'metrics', 'target': 'metric', 'source': SOURCE,
                                       'dependencies': {}, 'requireTargetBehavior': True})['valid']

    def test_unpack_multiline_nested_and_alias(self):
        for left in ('score, label', '(score, label)', '[score, label]', '(score,\n label)'):
            with self.subTest(left=left):
                self.assertTrue(self.validate(suite(left + ' = metric(50, 160)\nself.assertAlmostEqual(score, 19.53)')))
        self.assertTrue(self.validate(suite('score, (label, tail) = metric(50, 160)\nself.assertEqual(label, "normal")')))
        self.assertTrue(self.validate(suite('score, label = subject(50, 160)\nself.assertEqual(label, "normal")').replace('import metric', 'import metric as subject')))
        self.assertTrue(self.validate(suite('result = metric(50, 160)\nscore, label = result\nself.assertEqual(label, "normal")')))

    def test_reject_false_evidence(self):
        for body in (
            'score, label = metric(50, 160)\nscore = 19.53\nself.assertEqual(score, 19.53)',
            'score, label = metric(50, 160)\nself.assertTrue(True)',
            'score, label = metric(50, 160)\nself.assertEqual(score, score)',
            'result = metric(50, 160)\nself.assertEqual(result, metric(50, 160))',
            'score, label = metric(50, 160)\nself.assertEqual(1, 1, msg=score)',
            'score, label = metric(50, 160)\nscore += 1\nself.assertEqual(score, 20)',
            'result = metric(50, 160)\nresult[0] = 19.53\nself.assertEqual(result[0], 19.53)',
        ):
            with self.subTest(body=body):
                self.assertFalse(self.validate(suite(body)))

    def test_mock_target_still_rejected(self):
        code = suite('score, label = metric(50, 160)\nself.assertEqual(score, 19.53)')
        code = code.replace('import unittest', 'import unittest\nfrom unittest.mock import patch').replace('    def test_', '    @patch("metrics.metric")\n    def test_')
        self.assertFalse(self.validate(code))

    def test_result_shape_transforms_subtests_and_module_alias(self):
        for body in ('result = metric(50, 160)\nself.assertEqual(len(result), 2)',
                     'result = metric(50, 160)\nself.assertEqual(result.score, 19.53)',
                     'for value in [50, 60]:\n    with self.subTest(value=value):\n        score, label = metric(value, 160)\n        self.assertGreater(score, 0)'):
            self.assertTrue(self.validate(suite(body)), body)
        code = suite('score, label = calc.metric(50, 160)\nself.assertEqual(score, 19.53)').replace('from metrics import metric', 'import metrics as calc')
        self.assertTrue(self.validate(code))
        self.assertFalse(self.validate(suite('result = metric(50, 160)\nresult.score = 1\nself.assertEqual(result.score, 1)')))
        self.assertFalse(self.validate(suite('result = metric(50, 160)\nassert result == result')))


class SourceExpectationTests(unittest.TestCase):
    def repair(self, code, source=SOURCE, failure='FAIL: test_value (candidate.TestMetric.test_value)\nAssertionError: deliberately untrusted observed output 999'):
        return repair({'code': code, 'source': source, 'failure': failure, 'module': 'metrics', 'target': 'metric'})

    def test_corrects_both_fields_from_source_not_error_text(self):
        code = suite('score, label = metric(50, 160)\nself.assertAlmostEqual(score, 25.62, delta=0.01)\nself.assertEqual(label, "high")')
        result = self.repair(code)
        self.assertTrue(result['changed'])
        self.assertEqual([item['calculated'] for item in result['corrections']], [19.53, 'normal'])
        self.assertIn('delta=0.01', result['code'])
        self.assertIn('metric(50, 160)', result['code'])
        self.assertIn('meters ** 2', str(result['corrections']))
        self.assertFalse(self.repair(result['code'])['changed'])

    def test_fixture_inputs_keywords_and_unicode_positions(self):
        code = suite('score, label = metric(height=self.height, weight=45)\nself.assertEqual(label, "錯誤"); self.assertEqual(score, 22)')
        code = code.replace('    def test_value', '    def setUp(self):\n        self.height = 160\n    def test_value')
        result = self.repair(code)
        self.assertTrue(result['changed'])
        self.assertIn("self.assertEqual(label, 'low'); self.assertEqual(score, 17.58)", result['code'])
        ast.parse(result['code'])

    def test_module_alias_and_unrelated_function_name(self):
        code = suite('score, label = calc.metric(50, 160)\nself.assertEqual(score, 25.62)').replace('from metrics import metric', 'import metrics as calc')
        self.assertTrue(self.repair(code)['changed'])

    def test_multiple_failed_methods_preserve_passing_method_and_fixture(self):
        code = suite('result = metric(50, 160)\nself.assertEqual(result[0], 25.62)')
        code += '    def test_next(self):\n        score, label = metric(60, 160)\n        self.assertEqual(score, 1)\n        self.assertEqual(label, "high")\n'
        keep = '    def test_keep(self):\n        self.assertEqual(metric(50, 160), (19.53, "normal"))\n'
        result = self.repair(code + keep, failure='FAIL: test_value (a.TestMetric.test_value)\nFAIL: test_next (a.TestMetric.test_next)')
        self.assertEqual(len(result['corrections']), 3)
        self.assertTrue(result['code'].endswith(keep))

    def test_no_failed_case_no_repair(self):
        code = suite('score, label = metric(50, 160)\nself.assertEqual(score, 25.62)')
        for failure in ('', 'ERROR: test_value (a.TestMetric.test_value)', 'FAIL: test_other (a.TestMetric.test_other)'):
            self.assertFalse(self.repair(code, failure=failure)['changed'])

    def test_unsupported_source_stays_for_model_repair(self):
        code = suite('score, label = metric(50, 160)\nself.assertEqual(score, 25.62)')
        for source in (SOURCE.replace('height / 100', 'float(height) / 100'),
                       SOURCE.replace('meters = height / 100', 'meters = unknown / 100'),
                       SOURCE.replace('score = round', 'score = external'),
                       'round = lambda *args: 999\n' + SOURCE,
                       SOURCE.replace('height / 100', 'height ** 10000000'),
                       SOURCE.replace('height / 100', 'height / 0'),
                       'import arbitrary_external_module\n' + SOURCE):
            with self.subTest(source=source):
                self.assertFalse(self.repair(code, source)['changed'])

    def test_no_self_oracle_mock_skip_external_operations_or_changed_inputs(self):
        for body in (
            'result = metric(50, 160)\nexpected = metric(50, 160)\nself.assertEqual(result, expected)',
            'score, label = metric(50, 160)\nself.assertEqual(score, 1)\nopen("data", "w")',
            'score, label = metric(50, 160)\nself.skipTest("skip")\nself.assertEqual(score, 1)',
            'score, label = metric(other, 160)\nself.assertEqual(score, 1)',
            'score, label = metric(50, 160)\nself.assertEqual(score, 1, msg=helper())',
        ):
            with self.subTest(body=body):
                self.assertFalse(self.repair(suite(body))['changed'])


if __name__ == '__main__':
    unittest.main()
