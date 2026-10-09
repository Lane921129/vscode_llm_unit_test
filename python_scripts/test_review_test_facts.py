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

    def interaction_suite(self, body, decorator='@patch("sample.channel")', parameters='self, channel'):
        return ('import unittest\nfrom unittest.mock import patch\nfrom sample import score\n'
                'class Cases(unittest.TestCase):\n    ' + decorator + '\n'
                '    def test_value(' + parameters + '):\n'
                + ''.join('        ' + line + '\n' for line in body.splitlines()))

    def test_patch_decorator_tracks_default_mock_return_chains_after_target_call(self):
        code = self.interaction_suite('connection = channel.return_value\nworker = connection.worker.return_value\nscore("value", 2)\nchannel.assert_called_once()\nworker.send.assert_called_once_with("value")\nconnection.finish.assert_called_once()')
        result = self.facts('', code=code)['methods'][0]
        self.assertEqual([item['kind'] for item in result['mockAssertions']],
                         ['assert_called_once', 'assert_called_once_with', 'assert_called_once'])
        self.assertEqual([item['patchTarget'] for item in result['mockAssertions']], ['sample.channel'] * 3)
        self.assertEqual(result['mockAssertions'][1]['mockPath'], '.return_value.worker.return_value.send')
        self.assertTrue(all(item['targetCallLine'] == 9 for item in result['mockAssertions']))
        self.assertEqual(result['assertions'], [], 'mock facts do not manufacture return observations')

    def test_patch_context_alias_and_module_target_call(self):
        code = ('import unittest as ut\nimport sample as mod\nfrom unittest.mock import patch as replace\n'
                'class Cases(ut.TestCase):\n    def test_value(self):\n'
                '        with replace("sample.channel") as dependency:\n'
                '            mod.score(2)\n            dependency.assert_called_once()\n')
        self.assertEqual(self.facts('', code=code)['methods'][0]['mockAssertions'][0]['patchTarget'], 'sample.channel')

    def test_unknown_or_mutated_mock_and_target_bindings_never_become_interaction_facts(self):
        cases = [
            self.interaction_suite('score(2)\nchannel.assert_called_once()', decorator='@other("sample.channel")'),
            self.interaction_suite('score(2)\nchannel.assert_called_once()', decorator='@patch("sample.score")'),
            self.interaction_suite('score(2)\nchannel.assert_called_once()', decorator='@patch("sample.channel", new=object())'),
            self.interaction_suite('channel.assert_called_once()\nscore(2)'),
            self.interaction_suite('other(2)\nchannel.assert_called_once()'),
            self.interaction_suite('score = other\nscore(2)\nchannel.assert_called_once()'),
            self.interaction_suite('score(2)\nchannel.assert_called_once = lambda: None\nchannel.assert_called_once()'),
            self.interaction_suite('score(2)\nchannel.reset_mock()\nchannel.assert_called_once()'),
            self.interaction_suite('score(2)\nhelper()\nchannel.assert_called_once()'),
            self.interaction_suite('if True:\n    score(2)\nchannel.assert_called_once()'),
            self.interaction_suite('score(helper())\nchannel.assert_called_once()'),
            self.interaction_suite('score(2)\nchannel.assert_called_once_with(helper())'),
            self.interaction_suite('channel = 2\nscore(2)\nchannel.assert_called_once()'),
            self.interaction_suite('score(2)\nchannel.assert_called_once()').replace('    @patch', '    def setUp(self):\n        self.skipTest("unavailable")\n    @patch'),
            self.interaction_suite('score(2)\nchannel.assert_called_once()') + 'def load_tests(*args):\n    return unittest.TestSuite()\n',
        ]
        for code in cases:
            with self.subTest(code=code):
                self.assertFalse(any(item['mockAssertions'] for item in self.facts('', code=code)['methods']))

    def test_rebound_module_imports_do_not_supply_import_facts(self):
        for prefix in ('score = other\n', 'del score\n', 'if flag:\n    from other import score\n', 'from other import *\n'):
            code = suite('self.assertEqual(score(1), 2)', prefix)
            self.assertFalse(any(item['origin'] == 'sample.score' for item in self.facts('', code=code)['imports']))


if __name__ == '__main__':
    unittest.main()
