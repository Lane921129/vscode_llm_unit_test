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

    def test_correct_exception_blocks_do_not_hide_later_wrong_expectations(self):
        prefix = ('with self.assertRaises(TypeError):\n    metric("a", "a")\n'
                  'with self.assertRaises(ZeroDivisionError):\n    metric(1, 0)\n')
        result = self.proposal(prefix + 'with self.assertRaises(TypeError):\n    metric(1.2, 1.2)')
        self.assertTrue(result['changed'])
        self.assertIn(suite(prefix).split('    def test_value(self):\n')[1], result['code'])
        self.assertEqual(len(result['corrections']), 1)
        self.assertEqual(result['corrections'][0]['calculated'], (8333.33, 'high'))

    def test_boolean_numeric_inputs_keep_their_type_in_verification_proposals(self):
        for value in (True, False):
            result = self.proposal(f'with self.assertRaises(TypeError):\n    metric({value}, 100)')
            self.assertTrue(result['changed'])
            call = restore_value(result['corrections'][0]['basis']['call'])
            self.assertIs(call['args'][0], value)
            self.assertEqual(result['corrections'][0]['calculated'], (float(value), 'low'))

    def test_mismatched_or_shadowed_exception_and_compound_scope_still_abort(self):
        for prefix in ('with self.assertRaises(TypeError):\n    metric(1, 0)\n',
                       'with self.assertRaises(ZeroDivisionError) as caught:\n    metric(1, 0)\n',
                       'with self.assertRaises(ZeroDivisionError):\n    metric(1, 0)\n    metric(2, 0)\n',
                       'TypeError = ValueError\nwith self.assertRaises(TypeError):\n    metric("a", "a")\n'):
            with self.subTest(prefix=prefix):
                self.assertFalse(self.proposal(prefix + 'self.assertEqual(metric(1, 1), (9, "low"))')['changed'])

    def test_type_assertions_are_preserved_while_later_expectation_is_corrected(self):
        checks = 'self.assertEqual(type(score), float)\nself.assertIs(type(label), str)\nself.assertIsInstance(score, float)'
        result = self.proposal('score, label = metric(50, 160)\n' + checks + '\nself.assertEqual(score, 22.22)')
        self.assertTrue(result['changed'])
        for line in checks.splitlines():
            self.assertIn(line, result['code'])
        self.assertIn('self.assertEqual(score, 19.53)', result['code'])
        for extra in ('type = lambda x: float\n', 'float = str\n'):
            self.assertFalse(self.proposal(extra + 'score, label = metric(50, 160)\n' + checks + '\nself.assertEqual(score, 22.22)')['changed'])
        self.assertFalse(self.proposal('score, label = metric(50, 160)\nself.assertEqual(type(score), int)\nself.assertEqual(score, 22.22)')['changed'])

    def test_error_outcomes_propose_exact_input_exceptions_and_preserve_setup(self):
        for inputs, exception in [('0, 0', 'ZeroDivisionError'), ('50, 0', 'ZeroDivisionError'), ('"50", "160"', 'TypeError')]:
            with self.subTest(inputs=inputs):
                code = suite('expected = 0\nself.assertEqual(expected, 0)\nscore, label = metric(' + inputs
                             + ')\nself.assertAlmostEqual(score, expected)\nself.assertEqual(label, "low")')
                result = repair({'code': code, 'source': SOURCE, 'target': 'metric', 'module': 'metrics',
                                 'numericSkill': True, 'failure': 'ERROR: test_value (generated.TestMetric.test_value)'})
                self.assertTrue(result['changed'])
                self.assertIn('self.assertEqual(expected, 0)', result['code'])
                self.assertIn('with self.assertRaises(' + exception + '):\n            metric(' + inputs + ')', result['code'])
                proof = result['corrections'][0]['basis']
                self.assertEqual(proof['exception'], {'module': 'builtins', 'qualname': exception})
                self.assertNotIn('result_snapshot', proof)
                ast.parse(result['code'])

    def test_exception_proposal_cannot_remove_independent_or_compound_work(self):
        for tail in ('self.assertEqual(1, 2)', 'self.assertEqual(score, 0)\nprint("hidden")',
                     'self.assertEqual(score, metric(1, 1))', 'self.assertEqual(score, 0, msg=print("hidden"))',
                     'self.assertEqual(score, 0)\nself.assertEqual(metric(1, 1), (1, "low"))'):
            self.assertFalse(self.proposal('score, label = metric(50, 0)\n' + tail)['changed'])
        self.assertFalse(self.proposal('self.assertEqual(metric(50, 0), 99)\nself.assertEqual(1, 2)')['changed'])
        self.assertFalse(self.proposal('ZeroDivisionError = Exception\nself.assertEqual(metric(50, 0), 99)')['changed'])
        self.assertFalse(self.proposal('self.assertEqual(metric(50, 0), 99)', 'def metric(weight, height):\n    return unknown + 1\n')['changed'])
        self.assertFalse(self.proposal('self.assertEqual(metric(50, 0), 99)', 'def metric(weight, height):\n    return weight / missing\n')['changed'])

    def test_direct_exception_and_fixture_error_scopes(self):
        result = self.proposal('self.assertEqual(metric(50, 0), 99)')
        self.assertIn('with self.assertRaises(ZeroDivisionError)', result['code'])
        code = suite('self.assertEqual(self.score, 99)').replace('    def test_value',
            '    def setUp(self):\n        self.score = metric(50, 0)\n    def test_value')
        self.assertFalse(self.proposal('', code=code)['changed'])

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
