"""A row fix may change setup lines only; calls, assertions, mocks and control flow stay identical."""
import unittest

from case_row_assertions import compare

BEFORE = '''    def test_c1(self):
        item = make(1)
        with mock.patch.object(target_module, '_connect') as mock_0:
            mock_0.return_value.cursor.return_value.fetchone.return_value = None
            result = target_module.find(*(item, 2), **{})
        self.assertEqual(result, (2, 'ok'))
'''
RAISES = '''    def test_c2(self):
        with self.assertRaises(ValueError):
            target_module.find(*(0,), **{})
'''
CALLEES = ['target_module.find']


def check(after, before=BEFORE, method='test_c1'):
    return compare({'before': before, 'after': after, 'method': method, 'callees': CALLEES})


class FixContractTests(unittest.TestCase):
    def test_setup_only_fix_is_accepted(self):
        report = check(BEFORE.replace('item = make(1)', 'import helpers\n        item = helpers.make(1, strict=False)'))
        self.assertEqual(report, {'parsed': True, 'sameName': True, 'accepted': True, 'violations': []})

    def test_changed_call_arguments_are_rejected(self):
        self.assertIn('target-call-changed', check(BEFORE.replace('*(item, 2)', '*(item, 3)'))['violations'])
        self.assertIn('target-call-changed', check(BEFORE.replace('**{}', "**{'strict': True}"))['violations'])

    def test_replacing_the_result_with_a_constant_is_rejected(self):
        report = check(BEFORE.replace("result = target_module.find(*(item, 2), **{})", "result = (2, 'ok')"))
        self.assertIn('target-call-changed', report['violations'])
        self.assertFalse(report['accepted'])

    def test_changed_or_removed_assertion_is_rejected(self):
        self.assertIn('assertion-changed', check(BEFORE.replace('self.assertEqual(result,', 'self.assertEqual(result[0], 2) or self.assertEqual(result,'))['violations'])
        self.assertIn('assertion-changed', check(BEFORE.replace("(2, 'ok')", "(3, 'ok')"))['violations'])
        self.assertIn('assertion-changed', check(BEFORE.replace("self.assertEqual(result, (2, 'ok'))", 'self.assertTrue(result)'))['violations'])
        self.assertIn('assertion-changed', check(RAISES.replace('ValueError', 'Exception'), before=RAISES, method='test_c2')['violations'])

    def test_deleted_or_changed_mock_is_rejected(self):
        without_mock = BEFORE.replace("            mock_0.return_value.cursor.return_value.fetchone.return_value = None\n", '')
        self.assertIn('mock-changed', check(without_mock)['violations'])
        self.assertIn('mock-changed', check(BEFORE.replace("'_connect'", "'connect'"))['violations'])
        self.assertIn('mock-changed', check(BEFORE.replace('return_value = None', "return_value = ('x',)"))['violations'])

    def test_try_except_if_or_return_around_the_call_or_assertion_is_rejected(self):
        wrapped = BEFORE.replace("            result = target_module.find(*(item, 2), **{})",
                                 "            try:\n                result = target_module.find(*(item, 2), **{})\n            except Exception:\n                result = (2, 'ok')")
        self.assertIn('control-flow-added', check(wrapped)['violations'])
        guarded = BEFORE.replace("        self.assertEqual(result, (2, 'ok'))", "        if result:\n            self.assertEqual(result, (2, 'ok'))")
        self.assertIn('control-flow-added', check(guarded)['violations'])
        early = BEFORE.replace("        self.assertEqual(result, (2, 'ok'))", "        return\n        self.assertEqual(result, (2, 'ok'))")
        self.assertIn('control-flow-added', check(early)['violations'])

    def test_renamed_or_broken_methods_are_rejected(self):
        self.assertEqual(check(BEFORE.replace('test_c1', 'test_other'))['violations'], ['method-renamed'])
        self.assertEqual(check('    def test_c1(self):\n        self.assertEqual(1,\n')['violations'], ['unparseable'])
        self.assertFalse(compare({'before': '    def test_c1(self):\n        pass\n', 'after': '    def test_c1(self):\n        pass\n',
                                  'method': 'test_c1', 'callees': CALLEES})['accepted'], 'nothing to protect means nothing to accept')


if __name__ == '__main__':
    unittest.main()
