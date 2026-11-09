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
    return compare({'before': before, 'after': after, 'method': method, 'callees': CALLEES, 'module': 'store', 'target': 'find'})


PLAIN = '''    def test_c1(self):
        """C1 normal: typical values"""
        result = target_module.bmi(*(70, 1.75), **{})
        self.assertEqual(result, (22.9, 'normal'))
'''
CALL = "        result = target_module.bmi(*(70, 1.75), **{})\n"


def check_plain(after):
    return compare({'before': PLAIN, 'after': after, 'method': 'test_c1', 'callees': ['target_module.bmi'], 'module': 'health', 'target': 'bmi'})


def before_call(lines):
    return PLAIN.replace(CALL, ''.join('        ' + line + '\n' for line in lines) + CALL)


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



class TargetIntegrityTests(unittest.TestCase):
    def test_reassigning_the_result_after_the_call_is_rejected(self):
        report = check_plain(PLAIN.replace(CALL, CALL + "        result = (22.9, 'normal')\n"))
        self.assertIn('post-call-changed', report['violations'])
        self.assertFalse(report['accepted'])

    def test_replacing_the_target_before_the_call_is_rejected(self):
        report = check_plain(before_call(["target_module.bmi = lambda *a, **k: (22.9, 'normal')"]))
        self.assertEqual(report['violations'], ['target-rebound'])

    def test_any_added_statement_after_the_call_is_rejected_but_comments_are_not_statements(self):
        self.assertIn('post-call-changed', check_plain(PLAIN.replace(CALL, CALL + '        print(result)\n'))['violations'])
        self.assertIn('post-call-changed', check_plain(PLAIN + '        pass\n')['violations'])
        self.assertTrue(check_plain(PLAIN.replace(CALL, CALL + '        # checked by hand\n'))['accepted'])

    def test_setattr_delete_augmented_assignment_and_patching_the_target_are_rejected(self):
        for lines in (["setattr(target_module, 'bmi', lambda *a, **k: (22.9, 'normal'))"],
                      ['del target_module.bmi'],
                      ['target_module.bmi += 0'],
                      ["patcher = mock.patch.object(target_module, 'bmi', return_value=(22.9, 'normal'))", 'patcher.start()'],
                      ["mock.patch('health.bmi').start()"],
                      ['import health as again', "again.bmi = lambda *a: (22.9, 'normal')"],
                      ['from health import bmi', "vars(target_module)['bmi'] = bmi"],
                      ['target_module = object()'],
                      ['bmi = None']):
            with self.subTest(lines=lines):
                self.assertIn('target-rebound', check_plain(before_call(lines))['violations'])
        wrapped = PLAIN.replace(CALL, "        with mock.patch.object(target_module, 'bmi', return_value=(22.9, 'normal')):\n    " + CALL)
        self.assertIn('post-call-changed', check_plain(wrapped)['violations'])

    def test_aliasing_protected_objects_before_the_call_is_rejected(self):
        supervisor_example = ['t = target_module', 'orig = t.bmi',
                              "t.bmi = lambda *a, **k: (orig(*a, **k), (22.9, 'normal'))[1]"]
        for lines in (supervisor_example,
                      ['t = target_module'],
                      ["f = getattr(target_module, 'bmi')"],
                      ['(t,) = (target_module,)'],
                      ['t, n = target_module, 1'],
                      ['f = target_module.bmi'],
                      ['import health as alias', 'g = alias'],
                      ['from health import bmi as real', 'g = real'],
                      ['(t := target_module)'],
                      ['for t in (target_module,):', '    pass'],
                      ['ts = [m for m in [target_module]]'],
                      ['with contextlib.nullcontext() as c, open(__file__) as t:', '    pass', 'h: object = target_module'],
                      ['def helper(m=target_module):', '    return m'],
                      ["d = vars(target_module)"],
                      ["f = target_module.__dict__['bmi']"],
                      ['t = target_module if True else None']):
            with self.subTest(lines=lines):
                self.assertIn('target-rebound', check_plain(before_call(lines))['violations'])

    def test_setup_only_changes_before_the_call_are_accepted(self):
        report = check_plain(before_call(['import math', 'height = math.sqrt(3.0625)', 'helper = target_module.Helper(scale=2)',
                                          'limit = target_module.LIMIT', 'items = [target_module.Item(n) for n in range(2)]']))
        self.assertEqual(report, {'parsed': True, 'sameName': True, 'accepted': True, 'violations': []})
        self.assertTrue(check_plain(PLAIN.replace('typical values', 'typical adult values'))['accepted'], 'docstring is setup')


if __name__ == '__main__':
    unittest.main()
