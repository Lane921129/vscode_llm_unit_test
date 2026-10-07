import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from review_test_facts import build_review_facts
from trace_value_codec import snapshot_value


def suite(body, prefix=''):
    return 'import unittest\nfrom sample import score\n' + prefix + 'class Cases(unittest.TestCase):\n    def test_value(self):\n' + ''.join('        ' + line + '\n' for line in body.splitlines())


class ReviewFactsTests(unittest.TestCase):
    def facts(self, body, observations=None, code=None):
        return build_review_facts({'code': code or suite(body), 'module': 'sample', 'target': 'score',
                                   'runId': 'run', 'sourceHash': 'a' * 64, 'executionVerified': True,
                                   'observations': observations or []})

    def observed(self, args, result):
        return {'call': snapshot_value({'args': tuple(args), 'kwargs': {}}), 'result_snapshot': snapshot_value(result)}

    def test_literal_call_tuple_unpack_and_expected_names_match_exact_observation(self):
        facts = self.facts('value = 100\nexpected_number = 30.86\nexpected_label = "high"\nnumber, label = score(value, 180)\nself.assertEqual(number, expected_number)\nself.assertEqual(label, expected_label)', [self.observed([100, 180], (30.86, 'high'))])
        assertions = facts['methods'][0]['assertions']
        self.assertEqual([item.get('observationVerified') for item in assertions], [True, True])
        self.assertEqual(facts['classes'][0]['kind'], 'unittest-harness')

    def test_typed_inputs_and_conflicting_results_do_not_promote_observation(self):
        for observations in ([self.observed([True], 2)], [self.observed([1], 2), self.observed([1], 3)]):
            result = self.facts('self.assertEqual(score(1), 2)', observations)
            self.assertNotIn('observationVerified', result['methods'][0]['assertions'][0])

    def test_conditional_and_rebound_imports_stay_unknown(self):
        for body in ('if True:\n    self.assertEqual(score(1), 2)', 'score = lambda value: 2\nself.assertEqual(score(1), 2)'):
            result = self.facts(body, [self.observed([1], 2)])
            self.assertFalse(any(item.get('observationVerified') for item in result['methods'][0]['assertions']))

    def test_nonliteral_inputs_can_identify_assertion_but_never_observe_value(self):
        result = self.facts('number, label = score(self.value)\nself.assertEqual(label, "high")', [self.observed([1], (2, 'high'))])
        fact = result['methods'][0]['assertions'][0]
        self.assertTrue(fact['targetResult'])
        self.assertEqual(fact['expectedType'], 'str')
        self.assertNotIn('observationVerified', fact)

    def test_expected_exception_is_an_explicit_guard_not_an_execution_claim(self):
        result = self.facts('with self.assertRaises(ZeroDivisionError):\n    score(1, 0)')
        self.assertEqual(result['methods'][0]['exceptionGuards'], [{'line': 5, 'exception': 'ZeroDivisionError', 'callLines': [6]}])

    def test_aliases_and_custom_assertion_override(self):
        code = 'import unittest as ut\nimport sample as mod\nclass Cases(ut.TestCase):\n    def assertEqual(self, a, b):\n        pass\n    def test_value(self):\n        self.assertEqual(mod.score(1), 2)\n'
        result = self.facts('', [self.observed([1], 2)], code)
        self.assertEqual(result['methods'][0]['assertions'], [])
        code = code.replace('    def assertEqual(self, a, b):\n        pass\n', '    assertEqual = lambda *args: None\n')
        self.assertEqual(self.facts('', [self.observed([1], 2)], code)['methods'][0]['assertions'], [])

    def test_shadowed_exception_is_not_a_builtin_runtime_fact(self):
        result = self.facts('ZeroDivisionError = ValueError\nwith self.assertRaises(ZeroDivisionError):\n    score(1, 0)')
        self.assertEqual(result['methods'][0]['exceptionGuards'][0]['exception'], 'unknown')

    def test_comments_strings_and_fake_harness_are_not_facts(self):
        code = 'class TestCase: pass\nclass Cases(TestCase):\n    def test_value(self):\n        "self.assertEqual(score(1), 2)"\n'
        self.assertEqual(self.facts('', code=code)['classes'], [])

    def test_ast_tool_never_executes_input(self):
        code = suite('self.assertEqual(score(1), 2)', 'raise RuntimeError("must not run")\n')
        self.assertTrue(self.facts('', code=code)['methods'])


if __name__ == '__main__':
    unittest.main()
