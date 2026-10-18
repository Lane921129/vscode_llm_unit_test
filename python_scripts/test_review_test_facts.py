import pathlib
import json
import os
import subprocess
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

    def test_bmi_tuple_of_expected_names_is_verified_without_rewriting_the_test(self):
        method = self.facts('weight_kg = 1\nheight_cm = 1\nexpected_bmi = 10000.0\nexpected_status = "肥胖"\nresult = score(weight_kg, height_cm)\nself.assertEqual(result, (expected_bmi, expected_status))',
                            [self.observed([1, 1], (10000.0, '肥胖'))])['methods'][0]
        fact = method['assertions'][0]
        self.assertTrue(fact['targetResult'])
        self.assertTrue(fact['observationVerified'])
        self.assertEqual(fact['observationStatus'], 'verified')
        self.assertEqual(fact['targetCallLine'], method['calls'][0]['line'])
        self.assertEqual(fact['expected'], snapshot_value((10000.0, '肥胖')))

    def test_nested_literal_containers_resolve_local_names_and_preserve_types(self):
        cases = [
            ('(number, [label, {key: amount}], {number, amount})', (2, ['same', {'x': 3.0}], {2, 3.0})),
            ('[number, (label, {key: amount})]', [2, ('same', {'x': 3.0})]),
            ('{key: [number, amount], label: (number,)}', {'x': [2, 3.0], 'same': (2,)}),
        ]
        for expected, observed in cases:
            with self.subTest(expected=expected):
                fact = self.facts('number = 2\namount = 3.0\nlabel = "same"\nkey = "x"\nresult = score(1)\nself.assertEqual(result, ' + expected + ')',
                                  [self.observed([1], observed)])['methods'][0]['assertions'][0]
                self.assertEqual(fact['expected'], snapshot_value(observed))
                self.assertEqual(fact['observationStatus'], 'verified')

    def test_nested_container_inputs_keep_typed_positional_and_keyword_identity(self):
        body = 'value = 1\nexpected = 2\nself.assertEqual(score((value, [value]), config={"n": value}), expected)'
        def observed(value):
            return {'call': snapshot_value({'args': ((value, [value]),), 'kwargs': {'config': {'n': value}}}),
                    'result_snapshot': snapshot_value(2)}
        good = self.facts(body, [observed(1)])['methods'][0]
        self.assertEqual(good['assertions'][0]['observationStatus'], 'verified')
        self.assertEqual(good['calls'][0]['call'], snapshot_value(
            {'args': [(1, [1])], 'kwargs': {'config': {'n': 1}}}))
        for mismatch in (1.0, True):
            with self.subTest(mismatch=repr(mismatch)):
                fact = self.facts(body, [observed(mismatch)])['methods'][0]['assertions'][0]
                self.assertEqual(fact['observationStatus'], 'unknown')
                self.assertNotIn('observationVerified', fact)

    def test_wrong_known_expected_is_contradicted_but_missing_or_conflicting_observation_is_unknown(self):
        fact = self.facts('self.assertEqual(score(1), (3, "wrong"))',
                          [self.observed([1], (2, 'same'))])['methods'][0]['assertions'][0]
        self.assertEqual(fact['observationStatus'], 'contradicted')
        self.assertTrue(fact['targetResult'])
        self.assertNotIn('observationVerified', fact)
        for observations in ([], [self.observed([True], 2)],
                             [self.observed([1], 2), self.observed([1], 3)]):
            with self.subTest(observations=observations):
                fact = self.facts('self.assertEqual(score(1), 3)', observations)['methods'][0]['assertions'][0]
                self.assertEqual(fact['observationStatus'], 'unknown')

    def test_unsupported_expected_stays_a_target_assertion_with_unknown_status(self):
        expressions = ['calculate_expected()', 'unknown', '(number, unknown)', '(number + 1,)',
                       '(value.attribute,)', '(*[number],)', '{**mapping}', '[item for item in values]']
        for expected in expressions:
            with self.subTest(expected=expected):
                method = self.facts('number = 2\nresult = score(1)\nself.assertEqual(result, ' + expected + ')',
                                    [self.observed([1], (2,))])['methods'][0]
                fact = method['assertions'][0]
                self.assertTrue(fact['targetResult'])
                self.assertEqual(fact['targetCallLine'], method['calls'][0]['line'])
                self.assertEqual(fact['observationStatus'], 'unknown')
                self.assertNotIn('observationVerified', fact)

    def test_literal_rebinding_uses_the_current_value_without_borrowing_an_older_expected(self):
        body = 'expected = 2\nresult = score(1)\nexpected = 3\nself.assertEqual(result, expected)'
        fact = self.facts(body, [self.observed([1], 2)])['methods'][0]['assertions'][0]
        self.assertEqual(fact['expected'], snapshot_value(3))
        self.assertEqual(fact['observationStatus'], 'contradicted')
        body = body.replace('expected = 3', 'expected = unknown_expected()')
        fact = self.facts(body, [self.observed([1], 2)])['methods'][0]['assertions'][0]
        self.assertTrue(fact['targetResult'])
        self.assertEqual(fact['observationStatus'], 'unknown')

    def test_mutation_deletion_and_aliases_never_reuse_a_pre_mutation_container(self):
        mutations = ['expected[0] = 3', 'del expected[0]', 'expected += [3]',
                     'expected.append(3)', 'alias = expected\nalias[0] = 3',
                     'alias = (expected,)\nalias[0][0] = 3', 'holder.value = expected']
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                body = 'expected = [2]\nresult = score(1)\n' + mutation + '\nself.assertEqual(result, expected)'
                assertions = self.facts(body, [self.observed([1], [2])])['methods'][0]['assertions']
                self.assertEqual(len(assertions), 1)
                self.assertEqual(assertions[0]['observationStatus'], 'unknown')
                self.assertNotIn('observationVerified', assertions[0])

    def test_mutated_target_result_alias_is_not_verified_from_its_original_return(self):
        body = 'result = score(1)\nalias = result\nalias[0] = 3\nself.assertEqual(result, [2])'
        fact = self.facts(body, [self.observed([1], [2])])['methods'][0]['assertions'][0]
        self.assertEqual(fact['observationStatus'], 'unknown')
        self.assertNotIn('observationVerified', fact)

    def test_target_can_mutate_named_input_and_its_expected_alias_in_either_argument_order(self):
        observation = self.observed([[2]], [2])
        for assertion in ('self.assertEqual(score(items), alias)', 'self.assertEqual(alias, score(items))',
                          'result = score(items)\nself.assertEqual(result, alias)'):
            with self.subTest(assertion=assertion):
                fact = self.facts('items = [2]\nalias = items\n' + assertion,
                                  [observation])['methods'][0]['assertions'][0]
                self.assertTrue(fact['targetResult'])
                self.assertEqual(fact['observationStatus'], 'unknown')
                self.assertNotIn('observationVerified', fact)

    def test_unknown_calls_and_assertion_arguments_cannot_mutate_a_later_verified_result(self):
        operations = ['side_effect = mutate(result)', 'self.assertTrue(mutate(result))',
                      'self.assertEqual(result, unknown)', 'self.assertEqual(result, [2], msg=mutate(result))']
        for operation in operations:
            with self.subTest(operation=operation):
                body = 'result = score(1)\n' + operation + '\nself.assertEqual(result, [2])'
                fact = self.facts(body, [self.observed([1], [2])])['methods'][0]['assertions'][-1]
                self.assertEqual(fact['observationStatus'], 'unknown')
                self.assertNotIn('observationVerified', fact)

    def test_unwalked_standard_assertions_have_explicit_unknown_status_but_decorators_stay_unbound(self):
        code = suite('if flag:\n    self.assertEqual(score(1), 2)\nself.assertEqual(score(2), 3)')
        assertions = self.facts('', [self.observed([1], 2)], code)['methods'][0]['assertions']
        self.assertEqual([item['observationStatus'] for item in assertions], ['unknown', 'unknown'])
        self.assertTrue(all('targetResult' not in item and 'observationVerified' not in item for item in assertions))
        code = suite('self.assertEqual(score(1), 2)').replace('    def test_value', '    @decorate\n    def test_value')
        self.assertEqual(self.facts('', [self.observed([1], 2)], code)['methods'][0]['assertions'], [])

    def test_unknown_setup_and_nonreplayable_or_mixed_return_observations_are_unknown(self):
        code = suite('self.assertEqual(score(1), 3)').replace('    def test_value',
                    '    def setUp(self):\n        self.value = object()\n    def test_value')
        fact = self.facts('', [self.observed([1], 2)], code)['methods'][0]['assertions'][0]
        self.assertEqual(fact['observationStatus'], 'unknown', 'unknown setup cannot prove even a contradiction')
        unavailable = {'call': self.observed([1], 2)['call'], 'result_snapshot': snapshot_value(object())}
        exception = {'call': self.observed([1], 2)['call'], 'exception': 'ValueError'}
        for observations in ([unavailable], [self.observed([1], 2), exception]):
            with self.subTest(observations=observations):
                method = self.facts('self.assertEqual(score(1), 2)', observations)['methods'][0]
                self.assertNotIn('observationReturned', method['calls'][0])
                self.assertEqual(method['assertions'][0]['observationStatus'], 'unknown')

    def test_supported_comparisons_distinguish_real_conflicts_from_unsupported_semantics(self):
        for assertion, result, status in [
            ('self.assertAlmostEqual(score(1), 2.0, delta=0.1)', 2.05, 'verified'),
            ('self.assertAlmostEqual(score(1), 2.0, delta=0.1)', 2.5, 'contradicted'),
            ('self.assertAlmostEqual(score(1), 2.0, places=2, delta=0.1)', 2.0, 'unknown'),
            ('self.assertTupleEqual(score(1), (2,))', (3,), 'contradicted'),
            ('self.assertTupleEqual(score(1), (2,))', [2], 'unknown'),
            ('self.assertSequenceEqual(score(1), [2])', (2,), 'verified'),
            ('self.assertListEqual(score(1), [2])', [3], 'contradicted'),
            ('self.assertDictEqual(score(1), {"n": 2})', {'n': 3}, 'contradicted'),
            ('self.assertEqual(score(1), 2, unexpected=True)', 2, 'unknown'),
        ]:
            with self.subTest(assertion=assertion, result=result):
                fact = self.facts(assertion, [self.observed([1], result)])['methods'][0]['assertions'][0]
                self.assertEqual(fact['observationStatus'], status)
                self.assertEqual(fact.get('observationVerified', False), status == 'verified')

    def test_literal_resolution_budget_rejects_deep_or_large_values_without_execution(self):
        for expected in ('[' * 10 + 'number' + ']' * 10, '[' + ','.join(['number'] * 101) + ']'):
            with self.subTest(expected=expected[:40]):
                fact = self.facts('number = 2\nresult = score(1)\nself.assertEqual(result, ' + expected + ')',
                                  [self.observed([1], 2)])['methods'][0]['assertions'][0]
                self.assertTrue(fact['targetResult'])
                self.assertEqual(fact['observationStatus'], 'unknown')

    def test_module_target_binding_survives_two_proven_assertions(self):
        code = suite('self.assertEqual(mod.score(1), 2)\nself.assertEqual(mod.score(2), 3)').replace(
            'from sample import score', 'import sample as mod')
        assertions = self.facts('', [self.observed([1], 2), self.observed([2], 3)], code)['methods'][0]['assertions']
        self.assertEqual([item['observationStatus'] for item in assertions], ['verified', 'verified'])

    def test_unreplayable_combined_call_and_duplicate_keywords_never_supply_return_evidence(self):
        value = '[' + ','.join(str(item) for item in range(80)) + ']'
        for call in ('score(' + ','.join([value] * 7) + ')', 'score(value=1, value=1)'):
            with self.subTest(call=call[:50]):
                method = self.facts('self.assertEqual(' + call + ', 2)')['methods'][0]
                self.assertEqual(method['calls'], [])
                self.assertTrue(method['assertions'][0]['targetResult'])
                self.assertEqual(method['assertions'][0]['observationStatus'], 'unknown')

    def test_typed_inputs_and_conflicting_results_do_not_promote_observation(self):
        for observations in ([self.observed([True], 2)], [self.observed([1], 2), self.observed([1], 3)]):
            result = self.facts('self.assertEqual(score(1), 2)', observations)
            self.assertNotIn('observationVerified', result['methods'][0]['assertions'][0])

    def test_return_observation_and_call_line_stay_bound_to_the_exact_literal_call(self):
        result = self.facts('value = 1\nnumber, label = score(value, 1)\nself.assertEqual(number, 10000.0)\nself.assertEqual(label, "high")\nother = score(1, 0)\nself.assertEqual(other, 0)',
                            [self.observed([1, 1], (10000.0, 'high'))])['methods'][0]
        self.assertEqual([item.get('observationReturned') for item in result['calls']], [True, None])
        self.assertEqual([item['targetCallLine'] for item in result['assertions']], [6, 6, 9])
        self.assertEqual(result['calls'][0]['spellings'], ['score(value, 1)', 'score(1, 1)'])

    def test_unknown_setup_and_conflicting_return_observations_never_protect_a_call(self):
        for observations in ([self.observed([True], 2)], [self.observed([1], 2), self.observed([1], 3)]):
            result = self.facts('self.assertEqual(score(1), 2)', observations)['methods'][0]
            self.assertNotIn('observationReturned', result['calls'][0])
        code = suite('self.assertEqual(score(1), 2)').replace('    def test_value', '    def setUp(self):\n        self.value = 1\n    def test_value')
        result = self.facts('', [self.observed([1], 2)], code)['methods'][0]
        self.assertNotIn('observationReturned', result['calls'][0])

    def test_default_setup_protects_both_the_exact_call_and_matching_tuple_assertion(self):
        method = self.facts('self.assertEqual(score(1), (2, "same"))',
                            [self.observed([1], (2, 'same'))])['methods'][0]
        self.assertTrue(method['calls'][0]['observationReturned'])
        self.assertTrue(method['assertions'][0]['observationVerified'])
        self.assertEqual(method['assertions'][0]['targetCallLine'], method['calls'][0]['line'])

    def test_set_up_override_preserves_syntax_but_never_certifies_an_observed_assertion(self):
        code = suite('self.assertEqual(score(1), 2)').replace(
            '    def test_value', '    def setUp(self):\n        self.resource = object()\n    def test_value')
        method = self.facts('', [self.observed([1], 2)], code)['methods'][0]
        self.assertTrue(method['assertions'][0]['targetResult'])
        self.assertNotIn('observationReturned', method['calls'][0])
        self.assertNotIn('observationVerified', method['assertions'][0])

    def test_set_up_class_override_does_not_inherit_a_default_setup_observation(self):
        code = suite('self.assertEqual(score(1), 2)').replace(
            '    def test_value', '    @classmethod\n    def setUpClass(cls):\n        cls.resource = object()\n    def test_value')
        method = self.facts('', [self.observed([1], 2)], code)['methods'][0]
        self.assertTrue(method['assertions'][0]['targetResult'])
        self.assertNotIn('observationReturned', method['calls'][0])
        self.assertNotIn('observationVerified', method['assertions'][0])

    def test_custom_run_or_dispatch_override_cannot_certify_matching_literal_assertions(self):
        overrides = [
            '    def run(self, result=None):\n        return super().run(result)\n',
            '    def __getattribute__(self, name):\n        return super().__getattribute__(name)\n',
            '    def __getattr__(self, name):\n        return None\n',
            '    setUp = prepare_fixture\n',
        ]
        for override in overrides:
            with self.subTest(override=override):
                code = suite('self.assertEqual(score(1), 2)').replace('    def test_value', override + '    def test_value')
                method = self.facts('', [self.observed([1], 2)], code)['methods'][0]
                self.assertTrue(method['assertions'][0]['targetResult'])
                self.assertNotIn('observationReturned', method['calls'][0])
                self.assertNotIn('observationVerified', method['assertions'][0])

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

    def test_unknown_target_inputs_keep_target_identity_without_a_dangling_call_reference(self):
        for call in ('score(self.value)', 'score(unknown)', 'score(*[1])', 'score(**{"value": 1})'):
            with self.subTest(call=call):
                method = self.facts('result = ' + call + '\nself.assertEqual(result, 2)',
                                    [self.observed([1], 2)])['methods'][0]
                self.assertEqual(method['calls'], [])
                fact = method['assertions'][0]
                self.assertTrue(fact['targetResult'])
                self.assertEqual(fact['observationStatus'], 'unknown')
                self.assertNotIn('targetCallLine', fact)
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

    def test_syntax_presence_survives_wildcard_without_inventing_export_bindings(self):
        code = 'import unittest\nfrom sample import *\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(score(1), 2)\n'
        result = self.facts('', code=code)
        self.assertEqual(result['importStatements'], [
            {'line': 1, 'module': 'unittest', 'wildcard': False},
            {'line': 2, 'module': 'sample', 'wildcard': True}])
        self.assertEqual(result['imports'], [])
        self.assertEqual(result['classes'], [])
        self.assertEqual(result['methods'], [])

    def test_harness_and_target_use_require_resolved_unshadowed_bindings(self):
        result = self.facts('self.assertEqual(score(self.value), 2)')
        self.assertEqual(result['imports'][0]['harnessUseLines'], [3])
        self.assertEqual(result['imports'][1]['targetUseLines'], [5])
        self.assertFalse(result['methods'][0]['calls'], 'nonliteral input is not a proven observation')
        for body in ('score = other\nself.assertEqual(score(1), 2)', 'if flag:\n    self.assertEqual(score(1), 2)'):
            result = self.facts(body)
            self.assertNotIn('targetUseLines', result['imports'][1])
        nested = 'if flag:\n    import missing\n'
        self.assertFalse(any(item['module'] == 'missing' for item in self.facts('', code=nested)['importStatements']))

    def test_standard_assertion_syntax_in_patch_context_has_no_result_or_execution_authority(self):
        code = ('import unittest\nfrom unittest.mock import patch\nfrom sample import score\n'
                'class Cases(unittest.TestCase):\n'
                '    def setUp(self):\n        self.patcher = patch("sample.channel")\n'
                '        self.channel = self.patcher.start()\n'
                '    def test_value(self):\n        with patch("sample.value", 2):\n'
                '            self.assertEqual(score(), 2)\n')
        method = self.facts('', code=code)['methods'][0]
        self.assertEqual(method['standardAssertions'], [{'line': 10, 'kind': 'assertEqual'}])
        self.assertEqual(method['assertions'], [{'line': 10, 'kind': 'assertEqual', 'observationStatus': 'unknown'}],
                         'syntax must remain explicitly unknown for a patched return value')
        conditional = self.facts('if flag:\n    self.assertIs(score(1), None)')['methods'][0]
        self.assertEqual(conditional['standardAssertions'], [{'line': 6, 'kind': 'assertIs'}])
        self.assertEqual(conditional['assertions'], [{'line': 6, 'kind': 'assertIs', 'observationStatus': 'unknown'}],
                         'syntax does not prove the branch ran')

    def test_rebound_receiver_or_custom_methods_do_not_gain_standard_assertion_authority(self):
        base = suite('self.assertEqual(score(1), 2)')
        cases = [
            suite('self = other\nself.assertEqual(score(1), 2)'),
            base.replace('    def test_value', '    def assertEqual(self, *args):\n        pass\n    def test_value'),
            base.replace('    def test_value', '    def setUp(self):\n        self.assertEqual = other\n    def test_value'),
            base.replace('    def test_value', '    def setUp(self):\n        mutate(self)\n    def test_value'),
            base.replace('    def test_value', '    def setUp(self):\n        self.prepare()\n    def test_value'),
            base.replace('    def test_value', '    @other\n    def test_value'),
            base + 'def load_tests(*args):\n    return unittest.TestSuite()\n',
            base.replace('from sample import score', 'from sample import score\nunittest.TestCase.assertEqual = other'),
            base.replace('    def test_value', '    unittest.TestCase.assertEqual = other\n    def test_value'),
            base.replace('    def test_value', '    def setUp(self):\n        import unittest\n        unittest.TestCase.assertEqual = other\n    def test_value'),
        ]
        for code in cases:
            with self.subTest(code=code):
                self.assertFalse(any(item['standardAssertions'] for item in self.facts('', code=code)['methods']))
        unknown = self.facts('self.assertNotAUnittestMethod(score(1), 2)')['methods'][0]
        self.assertFalse(unknown['standardAssertions'])

    def test_patch_of_unittest_harness_leaves_method_binding_unknown(self):
        for patch_code in ('patch("unittest.TestCase.assertEqual")', 'patch.object(unittest.TestCase, "assertEqual")'):
            code = suite('with ' + patch_code + ':\n    self.assertEqual(score(1), 2)', 'from unittest.mock import patch\n')
            self.assertFalse(self.facts('', code=code)['methods'][0]['standardAssertions'])

    def test_complete_assertion_and_patch_syntax_does_not_certify_patched_results(self):
        code = ('import unittest\nfrom unittest.mock import patch\nfrom sample import score\n'
                'class Cases(unittest.TestCase):\n    def test_value(self):\n'
                '        with patch("sample.clock") as clock:\n'
                '            clock.now.return_value = "肥胖"\n'
                '            self.assertEqual(score(), "肥胖")\n')
        result = self.facts('', code=code)['methods'][0]
        self.assertEqual(result['standardAssertionCalls'][0]['line'], 8)
        self.assertIn('self.assertEqual(score(), "肥胖")', result['standardAssertionCalls'][0]['spellings'])
        self.assertEqual(result['dependencyPatchSyntax'][0]['origin'], 'unittest.mock.patch')
        self.assertEqual(result['dependencyPatchSyntax'][0]['binding'], 'clock')
        self.assertTrue(result['assertions'][0]['targetResult'])
        self.assertEqual(result['assertions'][0]['observationStatus'], 'unknown',
                         'target binding cannot verify the patched expected return value')
        self.assertNotIn('observationVerified', result['assertions'][0])
        self.assertNotIn('observationReturned', result['calls'][0])
        rebound = code.replace('        with patch', '        patch = other\n        with patch')
        self.assertFalse(self.facts('', code=rebound)['methods'][0]['dependencyPatchSyntax'])

    def test_json_stdin_is_utf8_under_a_non_utf8_console_code_page(self):
        code = suite('self.assertEqual(score(1), "肥胖")')
        payload = {'code': code, 'module': 'sample', 'target': 'score', 'runId': 'run', 'sourceHash': 'a' * 64}
        run = subprocess.run([sys.executable, '-B', str(pathlib.Path(__file__).with_name('review_test_facts.py'))],
                             input=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={**os.environ, 'PYTHONIOENCODING': 'cp1252'}, check=False)
        self.assertEqual(run.returncode, 0, run.stderr.decode('ascii', errors='replace'))
        facts = json.loads(run.stdout.decode('ascii'))
        self.assertEqual(facts['methods'][0]['assertions'][0]['expected']['value']['value'], '肥胖')

    def test_nested_argument_calls_are_not_mislabelled_as_standard_assertions(self):
        method = self.facts('self.assertEqual(score(service.value()), "same")')['methods'][0]
        self.assertEqual([item['kind'] for item in method['standardAssertionCalls']], ['assertEqual'])
        self.assertFalse(any(item.get('observationVerified') for item in method['assertions']))


def patch_facts(body, observations=None, imports='from sample import score\n'):
    code = ('import unittest\nfrom unittest.mock import patch\n' + imports
            + 'class Cases(unittest.TestCase):\n    def test_value(self):\n'
            + ''.join('        ' + line + '\n' for line in body.splitlines()))
    return build_review_facts({'code': code, 'module': 'sample', 'target': 'score',
                               'runId': 'neutral', 'sourceHash': 'a' * 64,
                               'executionVerified': True, 'observations': observations or []})['methods'][0]


class PatchReturnBindingTests(unittest.TestCase):
    def test_direct_patch_setup_binds_real_return_without_borrowing_any_observation(self):
        body = ('with patch("sample.channel") as channel:\n'
                '    controlled = object()\n'
                '    channel.reader.return_value = controlled\n'
                '    result = score(1)\n'
                '    self.assertEqual(result, 9)\n')
        for returned in (9, 7):
            observation = {'call': snapshot_value({'args': (1,), 'kwargs': {}}),
                           'result_snapshot': snapshot_value(returned)}
            method = patch_facts(body, [observation])
            assertion = method['assertions'][0]
            self.assertTrue(assertion.get('targetResult'))
            self.assertEqual(assertion['targetCallLine'], method['calls'][0]['line'])
            self.assertEqual(assertion['observationStatus'], 'unknown')
            self.assertNotIn('observationReturned', method['calls'][0])
            self.assertNotIn('observationVerified', assertion)

    def test_module_alias_and_local_result_are_bound_inside_patch(self):
        method = patch_facts('with patch("sample.channel") as channel:\n'
                       '    channel.return_value = 9\n'
                       '    result = mod.score(1)\n'
                       '    self.assertEqual(result, 9)', imports='import sample as mod\n')
        self.assertTrue(method['assertions'][0].get('targetResult'))
        self.assertEqual(method['assertions'][0]['observationStatus'], 'unknown')

    def test_unknown_or_overlapping_patch_cannot_bind_target_returns(self):
        contexts = ['other()', 'patch("sample.score")', 'patch("sample")',
                    'patch("sample.score.__code__")', 'patch("unittest.TestCase")',
                    'patch("sample.channel", new=object())', 'patch.object(mod, "channel")']
        for context in contexts:
            with self.subTest(context=context):
                method = patch_facts(f'with {context} as channel:\n'
                               '    result = score(1)\n    self.assertEqual(result, 9)')
                self.assertTrue(all(not item.get('targetResult', False) for item in method['assertions']))
                self.assertTrue(all(item['observationStatus'] == 'unknown' for item in method['assertions']))

    def test_rebound_mock_unknown_writes_and_changed_results_stop_binding(self):
        bodies = ['channel = other\nchannel.return_value = 9\nresult = score(1)',
                  'channel: object = other\nchannel.return_value = 9\nresult = score(1)',
                  'ignored = (channel := other)\nchannel.return_value = 9\nresult = score(1)',
                  'channel.return_value = (channel := other)\nresult = score(1)',
                  'channel.return_value = other\nchannel.return_value.reader.return_value = 9\nresult = score(1)',
                  'channel.other = 9\nresult = score(1)',
                  'result = score(1)\nchannel.return_value = result']
        for setup in bodies:
            with self.subTest(setup=setup):
                body = 'with patch("sample.channel") as channel:\n' + ''.join(
                    '    ' + line + '\n' for line in (setup + '\nself.assertEqual(result, 9)').splitlines())
                method = patch_facts(body)
                self.assertFalse(method['assertions'][0].get('targetResult', False))

    def test_context_exit_does_not_propagate_a_return_binding(self):
        method = patch_facts('with patch("sample.channel") as channel:\n'
                       '    result = score(1)\nself.assertEqual(result, 9)')
        self.assertFalse(method['assertions'][0].get('targetResult', False))
        self.assertEqual(method['assertions'][0]['observationStatus'], 'unknown')

    def test_unknown_branch_inside_patch_remains_unknown(self):
        method = patch_facts('with patch("sample.channel") as channel:\n'
                       '    if flag:\n        result = score(1)\n'
                       '    self.assertEqual(result, 9)')
        self.assertFalse(method['assertions'][0].get('targetResult', False))
        self.assertEqual(method['assertions'][0]['observationStatus'], 'unknown')


if __name__ == '__main__':
    unittest.main()
