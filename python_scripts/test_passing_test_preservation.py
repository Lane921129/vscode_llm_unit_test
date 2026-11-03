import unittest

from python_scripts.passing_test_preservation import validate


BASELINE = '''import unittest
from sample import calculate

class Cases(unittest.TestCase):
    def test_normal(self):
        value, status = calculate(48, 160)
        self.assertAlmostEqual(value, 18.75, places=2)
        self.assertEqual(status, 'normal')

    def test_exception(self):
        with self.assertRaises(ZeroDivisionError):
            calculate(48, 0)
'''


class PassingTestPreservationTests(unittest.TestCase):
    def reject(self, candidate, code, previous=BASELINE, methods='all'):
        result = validate(previous, candidate, methods)
        self.assertFalse(result['valid'], result)
        self.assertEqual(result['reasonCode'], code, result)

    def test_exact_string_comparison_cannot_become_ordering_or_membership(self):
        for assertion in ["self.assertGreaterEqual(status, 'normal')", "self.assertIn(status, ('normal', 'other'))",
                          "self.assertTrue(status)", "self.assertEqual(status, 'other')"]:
            with self.subTest(assertion=assertion):
                self.reject(BASELINE.replace("self.assertEqual(status, 'normal')", assertion), 'assertion-weakened')

    def test_numeric_tolerance_only_tightens_without_changing_expected(self):
        self.assertTrue(validate(BASELINE, BASELINE.replace('places=2', 'places=4'))['valid'])
        self.reject(BASELINE.replace('places=2', 'places=1'), 'assertion-weakened')
        self.reject(BASELINE.replace('18.75', '18.8'), 'assertion-weakened')
        delta = BASELINE.replace('places=2', 'delta=0.01')
        self.assertTrue(validate(delta, delta.replace('delta=0.01', 'delta=0.001'))['valid'])
        self.reject(delta.replace('delta=0.01', 'delta=1.0'), 'assertion-weakened', delta)
        self.reject(delta.replace('delta=0.01', 'delta=True'), 'assertion-weakened', delta)
        self.reject(BASELINE.replace('places=2', 'places=4, msg=change_state()'), 'assertion-weakened')

    def test_exception_type_and_call_inputs_remain_exact(self):
        self.reject(BASELINE.replace('assertRaises(ZeroDivisionError)', 'assertRaises(Exception)'), 'assertion-weakened')
        self.reject(BASELINE.replace('calculate(48, 0)', 'calculate(48, 1)'), 'passing-scenario-changed')
        self.reject(BASELINE.replace('calculate(48, 160)', 'calculate(50, 160)'), 'passing-scenario-changed')

    def test_standard_assertion_strengthening_preserves_all_arguments(self):
        for expected, method in [('(1, "normal")', 'assertTupleEqual'), ('[1, "normal"]', 'assertListEqual'),
                                 ('{"label": "normal"}', 'assertDictEqual'), ('{"normal"}', 'assertSetEqual'),
                                 ('"normal"', 'assertMultiLineEqual')]:
            previous = BASELINE.replace("self.assertEqual(status, 'normal')", f'self.assertEqual(status, {expected}, msg="check")')
            self.assertTrue(validate(previous, previous.replace('self.assertEqual(status', f'self.{method}(status'))['valid'])
            self.reject(previous.replace('self.assertEqual(status', f'self.{method}(status').replace('msg="check"', 'msg=mutate()'),
                        'assertion-weakened', previous)
        for before, constant in [('assertFalse', 'False'), ('assertTrue', 'True')]:
            previous = BASELINE.replace("self.assertEqual(status, 'normal')", f'self.{before}(status, "message")')
            candidate = previous.replace(f'{before}(status, "message")', f'assertIs(status, {constant}, "message")')
            self.assertTrue(validate(previous, candidate)['valid'])
            self.reject(candidate.replace(', "message")', ', changed())'), 'assertion-weakened', previous)
        self.reject(BASELINE.replace("self.assertEqual(status, 'normal')", "self.assertSequenceEqual(status, 'normal')"), 'assertion-weakened')

    def test_custom_or_overridden_assertion_dispatch_is_not_assumed_standard(self):
        previous = BASELINE.replace("self.assertEqual(status, 'normal')", 'self.assertFalse(status)')
        candidate = previous.replace('self.assertFalse(status)', 'self.assertIs(status, False)')
        for old, new in [(previous.replace('unittest.TestCase', 'ExternalCase'), candidate.replace('unittest.TestCase', 'ExternalCase')),
                         (previous + '\n    def assertFalse(self, value):\n        pass\n', candidate + '\n    def assertFalse(self, value):\n        pass\n'),
                         (previous.replace('    def test_normal', '    def setUp(self):\n        self.assertFalse = lambda value: None\n    def test_normal'),
                          candidate.replace('    def test_normal', '    def setUp(self):\n        self.assertFalse = lambda value: None\n    def test_normal'))]:
            self.reject(new, 'assertion-weakened', old)
            self.assertTrue(validate(old, old)['valid'])
        inherited = 'class Custom(unittest.TestCase):\n    def assertFalse(self, value):\n        pass\n'
        old = previous.replace('class Cases(unittest.TestCase):', inherited + 'class Cases(Custom):')
        new = candidate.replace('class Cases(unittest.TestCase):', inherited + 'class Cases(Custom):')
        self.reject(new, 'assertion-weakened', old)
        self.reject(candidate.replace('self.assertFalse', 'helper.assertFalse').replace('self.assertIs', 'helper.assertIs'),
                    'assertion-weakened', previous.replace('self.assertFalse', 'helper.assertFalse'))
        old = previous.replace('        value, status', '        self = helper\n        value, status')
        new = candidate.replace('        value, status', '        self = helper\n        value, status')
        self.reject(new, 'assertion-weakened', old)

    def test_removal_and_rename_cannot_escape_preservation(self):
        self.reject(BASELINE.replace('test_normal', 'test_better'), 'removed-passing-method')
        self.reject(BASELINE.replace('class Cases', 'class BetterCases'), 'removed-passing-method')
        self.reject(BASELINE[:BASELINE.index('    def test_exception')], 'removed-passing-method')

    def test_skip_and_signature_changes_are_rejected(self):
        self.reject(BASELINE.replace('    def test_normal', "    @unittest.skip('later')\n    def test_normal"), 'passing-signature-changed')
        self.reject(BASELINE.replace('def test_normal(self):', 'async def test_normal(self):'), 'passing-signature-changed')

    def test_appended_scenarios_and_assertions_remain_ai_owned(self):
        expanded = BASELINE.replace("        self.assertEqual(status, 'normal')", "        self.assertEqual(status, 'normal')\n        self.assertIsInstance(status, str)")
        expanded += '''
    def test_other(self):
        self.assertEqual(calculate(80, 160)[1], 'other')
'''
        self.assertTrue(validate(BASELINE, expanded)['valid'])
        # Ordinary small-model formatting differences are not code changes.
        formatted = BASELINE.replace("'normal'", '"normal"').replace('value, status =', '(value, status) =')
        formatted = formatted.replace('        value,', '        # Explain the calculation\n        value,')
        self.assertTrue(validate(BASELINE, formatted)['valid'])

    def test_failing_method_is_editable_and_passed_method_is_not(self):
        changed = BASELINE.replace('assertRaises(ZeroDivisionError)', 'assertRaises(TypeError)')
        result = validate(BASELINE, changed, ['Cases.test_normal'])
        self.assertTrue(result['valid'], result)
        self.assertEqual(result['protectedMethods'], ['Cases.test_normal'])
        self.assertTrue(validate(BASELINE, BASELINE.replace('18.75', '42'), [])['valid'])
        self.reject(changed.replace('18.75', '42'), 'assertion-weakened', methods=['Cases.test_normal'])

    def test_passed_id_must_be_exact_and_come_from_baseline(self):
        self.reject(BASELINE, 'invalid-protected-methods', methods=['test_normal'])
        self.reject(BASELINE, 'invalid-protected-methods', methods=['Other.test_normal'])

    def test_shared_fixture_and_helper_changes_remain_explicitly_unsupported(self):
        previous = BASELINE.replace('    def test_normal', '    def setUp(self):\n        self.label = "normal"\n\n    def test_normal')
        self.reject(previous.replace('self.label = "normal"', 'self.label = "other"'), 'fixture-context-changed', previous)
        previous = BASELINE.replace('    def test_normal', '    def label(self):\n        return "normal"\n\n    def test_normal')
        self.reject(previous.replace('return "normal"', 'return "other"'), 'fixture-context-changed', previous)
        self.reject(BASELINE + '\n    def assertEqual(self, *args):\n        pass\n', 'fixture-context-changed')
        self.reject(BASELINE + '\n    def setUp(self):\n        pass\n', 'fixture-context-changed')

    def test_setup_in_unprotected_class_can_be_repaired(self):
        previous = BASELINE + '''
class FailingCases(unittest.TestCase):
    def setUp(self):
        self.fixture = 'wrong'
    def test_other(self):
        self.assertEqual(self.fixture, 'correct')
'''
        candidate = previous.replace("self.fixture = 'wrong'", "self.fixture = 'correct'")
        self.assertTrue(validate(previous, candidate, ['Cases.test_normal', 'Cases.test_exception'])['valid'])

    def test_inherited_shared_fixture_cannot_be_changed_via_unprotected_base(self):
        previous = '''import unittest
class Base(unittest.TestCase):
    def setUp(self):
        self.input = 1
    def test_extra(self):
        self.assertEqual(self.input, 1)
class Derived(Base):
    def test_passed(self):
        self.assertEqual(self.input, 1)
'''
        self.reject(previous.replace('self.input = 1', 'self.input = 2'), 'fixture-context-changed',
                    previous, ['Derived.test_passed'])

    def test_new_import_and_helper_allowed_but_existing_binding_cannot_change(self):
        candidate = 'import math\n' + BASELINE + '\n    def helper(self):\n        return 1\n'
        self.assertTrue(validate(BASELINE, candidate)['valid'])
        self.assertTrue(validate(BASELINE, 'import unittest.mock\n' + BASELINE)['valid'])
        repeated_package = 'import unittest.mock\n' + BASELINE
        self.assertTrue(validate(repeated_package, repeated_package + '\n    def extra(self):\n        return 1\n')['valid'])
        previous = BASELINE.replace('    def test_normal', '    def setUp(self):\n        self.fixture = 1\n    def test_normal')
        candidate = previous.replace('    def setUp', '    def extra_helper(self):\n        return 2\n    def setUp')
        self.assertTrue(validate(previous, candidate)['valid'])
        self.reject(BASELINE.replace('from sample import calculate', 'from other import calculate'), 'import-binding-changed')
        self.reject('from other import str\n' + BASELINE.replace("self.assertEqual(status, 'normal')", "self.assertEqual(status, str('normal'))"), 'assertion-weakened')
        typed = BASELINE + '\n    def test_type(self):\n        self.assertIsInstance(calculate(48, 160)[1], str)\n'
        self.reject('from other import str\n' + typed, 'import-binding-changed', typed)

    def test_helper_fixture_class_is_preserved(self):
        previous = 'class Fixture:\n    value = 1\n\n' + BASELINE
        self.reject(previous.replace('value = 1', 'value = 2'), 'fixture-context-changed', previous)

    def test_injected_control_flow_and_reordered_scenarios_are_not_equivalent(self):
        self.reject(BASELINE.replace('        value, status', '        return\n        value, status'), 'passing-scenario-changed')
        self.reject(BASELINE.replace("        self.assertEqual(status, 'normal')", "        if False:\n            self.assertEqual(status, 'normal')"), 'assertion-weakened')

    def test_duplicate_method_is_not_a_preserved_execution(self):
        self.reject(BASELINE + '\n    def test_normal(self):\n        pass\n', 'duplicate-binding')


if __name__ == '__main__':
    unittest.main()
