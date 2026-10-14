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
        self.assertFalse(method['assertions'], 'syntax cannot certify a patched return value')
        conditional = self.facts('if flag:\n    self.assertIs(score(1), None)')['methods'][0]
        self.assertEqual(conditional['standardAssertions'], [{'line': 6, 'kind': 'assertIs'}])
        self.assertFalse(conditional['assertions'], 'syntax does not prove the branch ran')

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
        self.assertEqual(result['assertions'], [], 'presence cannot verify the expected return value')
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


if __name__ == '__main__':
    unittest.main()
