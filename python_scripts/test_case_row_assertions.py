"""A row fix may change setup lines but never an asserted expectation."""
import unittest

from case_row_assertions import compare

BEFORE = '''    def test_c1(self):
        item = make(1)
        result = target_module.f(*(1,), **{})
        self.assertEqual(result, (2, 'ok'))
        with self.assertRaises(ValueError):
            target_module.f(*(0,), **{})
'''


class AssertionExpectationTests(unittest.TestCase):
    def check(self, after, method='test_c1'):
        return compare({'before': BEFORE, 'after': after, 'method': method})

    def test_setup_changes_keep_expectations(self):
        report = self.check(BEFORE.replace('make(1)', 'make(2)'))
        self.assertEqual(report, {'parsed': True, 'sameName': True, 'expectationsEqual': True})

    def test_changed_expected_value_or_exception_is_rejected(self):
        self.assertFalse(self.check(BEFORE.replace("(2, 'ok')", "(3, 'ok')"))['expectationsEqual'])
        self.assertFalse(self.check(BEFORE.replace('ValueError', 'Exception'))['expectationsEqual'])
        self.assertFalse(self.check(BEFORE.replace("        self.assertEqual(result, (2, 'ok'))\n", ''))['expectationsEqual'])

    def test_renamed_method_or_broken_code_is_rejected(self):
        self.assertFalse(self.check(BEFORE.replace('test_c1', 'test_other'))['sameName'])
        self.assertFalse(self.check('    def test_c1(self):\n        self.assertEqual(1,\n')['parsed'])
        self.assertFalse(compare({'before': '    def test_c1(self):\n        pass\n', 'after': '    def test_c1(self):\n        pass\n',
                                  'method': 'test_c1'})['expectationsEqual'], 'a method without assertions never qualifies')


if __name__ == '__main__':
    unittest.main()
