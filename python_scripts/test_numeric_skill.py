import ast
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from repair_source_expectations import repair
from trace_value_codec import restore_value
from test_source_expectations import SOURCE, suite


class NumericSkillTests(unittest.TestCase):
    def proposal(self, body, source=SOURCE, code=None):
        return repair({'code': code or suite(body), 'source': source, 'numericSkill': True,
                       'target': 'metric', 'module': 'metrics',
                       'failure': 'FAIL: test_value (generated.TestMetric.test_value)\nAssertionError'})

    def test_arithmetic_and_hidden_label_bind_to_exact_inputs(self):
        result = self.proposal('weight = 70\nheight = 170\nscore, label = metric(weight, height)\n'
                               'self.assertEqual(score, 24.9)\nself.assertEqual(label, "normal")')
        self.assertTrue(result['changed'])
        self.assertEqual([c['calculated'] for c in result['corrections']], [24.22, 'high'])
        proof = result['corrections'][0]['basis']
        self.assertEqual(restore_value(proof['call']), {'args': (70, 170), 'kwargs': {}})
        self.assertEqual(restore_value(proof['result_snapshot']), (24.22, 'high'))
        ast.parse(result['code'])

    def test_zero_numerator_exception_becomes_explicit_return_proposal(self):
        result = self.proposal('with self.assertRaises(ZeroDivisionError):\n    metric(0, 1)')
        self.assertTrue(result['changed'])
        self.assertIn("self.assertEqual(metric(0, 1), (0.0, 'low'))", result['code'])
        self.assertEqual(result['corrections'][0]['kind'], 'exception-to-return')

    def test_zero_denominator_exception_is_preserved(self):
        self.assertFalse(self.proposal('with self.assertRaises(ZeroDivisionError):\n    metric(10, 0)')['changed'])

    def test_typed_keywords_and_signed_zero_preserved(self):
        result = self.proposal('self.assertEqual(metric(height=100.0, weight=-0.0), (9, "high"))')
        call = result['corrections'][0]['basis']['call']
        restored = restore_value(call)
        self.assertEqual(list(restored['kwargs']), ['height', 'weight'])
        self.assertIs(type(restored['kwargs']['height']), float)
        self.assertEqual(repr(restored['kwargs']['weight']), '-0.0')

    def test_fixture_unpack_and_passing_method_remain_intact(self):
        code = suite('self.assertEqual(self.score, 99)')
        fixture = '    def setUp(self):\n        self.score, self.label = metric(70, 170)\n'
        passing = '    def test_keep(self):\n        self.assertEqual(self.label, "high")\n'
        code = code.replace('    def test_value', fixture + '    def test_value') + passing
        result = self.proposal('', code=code)
        self.assertTrue(result['changed'])
        self.assertIn(fixture, result['code'])
        self.assertTrue(result['code'].endswith(passing))

    def test_compound_exception_context_and_mock_are_not_rewritten(self):
        for body in ('with self.assertRaises(ValueError) as caught:\n    metric(0, 1)',
                     'with self.assertRaises(ValueError):\n    metric(0, 1)\n    metric(1, 0)',
                     'with patch("metrics.metric"):\n    self.assertEqual(metric(0, 1), (9, "high"))',
                     'self.assertEqual(metric(0, 1), metric(1, 1))',
                     'self.assertEqual(metric(0, 1), (9, "high"), msg=print("hidden"))'):
            with self.subTest(body=body):
                self.assertFalse(self.proposal(body)['changed'])

    def test_shared_fixture_assertion_cannot_be_repaired_through_failed_method(self):
        code = suite('self.assertEqual(self.value, 99)')
        code = code.replace('    def test_value', '    def setUp(self):\n'
            '        self.value = metric(70, 170)\n        self.assertEqual(self.value, (9, "low"))\n    def test_value')
        self.assertFalse(self.proposal('', code=code)['changed'])

    def test_unsafe_or_large_source_is_not_executed(self):
        for expression in ('open("sentinel", "w")', '__import__("os").system("whoami")',
                           'eval("1")', '10 ** 100', 'abs(10 ** 100)', '1e100'):
            with self.subTest(expression=expression):
                self.assertFalse(self.proposal('self.assertEqual(metric(1, 2), 3)',
                    'def metric(weight, height):\n    return ' + expression + '\n')['changed'])

    def test_ambiguous_class_and_assertion_rebinding_rejected(self):
        code = suite('self.assertEqual(metric(70, 170), (9, "low"))')
        self.assertFalse(self.proposal('', code=code + code[code.index('class '):])['changed'])
        self.assertFalse(self.proposal('self.assertEqual = 1\nself.assertEqual(metric(70, 170), (9, "low"))')['changed'])

    def test_non_arithmetic_local_and_generalized_formula(self):
        result = self.proposal('self.assertEqual(metric(5, 3), 88)',
                              'def metric(weight, height):\n    return round((weight + height) * 2 - 1, 2)\n')
        self.assertEqual(result['corrections'][0]['calculated'], 15)

    def test_execution_mode_does_not_gain_exception_conversion(self):
        result = repair({'code': suite('with self.assertRaises(ZeroDivisionError):\n    metric(0, 1)'),
                         'source': SOURCE, 'target': 'metric', 'module': 'metrics',
                         'failure': 'FAIL: test_value (generated.TestMetric.test_value)'})
        self.assertFalse(result['changed'])


if __name__ == '__main__':
    unittest.main()
