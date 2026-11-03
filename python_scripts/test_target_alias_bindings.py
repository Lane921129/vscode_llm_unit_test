import ast
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from target_result_evidence import has_target_result_assertion
from review_test_facts import build_review_facts
from validate_target_calls import validate_target_calls
from validate_test_bindings import validate_bindings


CONTEXT = {'module': 'cleaner', 'className': 'DataCleaner', 'target': 'parse_address_line'}


def candidate(body):
    return ('import unittest\nfrom cleaner import DataCleaner\nclass Cases(unittest.TestCase):\n'
            '    def test_value(self):\n' + ''.join('        ' + line + '\n' for line in body.splitlines()))


class TargetAliasBindingsTests(unittest.TestCase):
    def facts(self, code):
        return build_review_facts({'code': code, 'module': 'cleaner', 'target': 'DataCleaner.parse_address_line',
                                  'runId': 'alias', 'sourceHash': 'a' * 64, 'executionVerified': False})['methods'][0]

    def test_saved_address_alias_has_assertion_seed_and_signature_evidence(self):
        code = candidate('target = DataCleaner.parse_address_line\naddress_line = ""\n'
                         'result = target(address_line)\nself.assertEqual(result, ("", "", ""))')
        self.assertTrue(has_target_result_assertion(ast.parse(code), CONTEXT))
        self.assertEqual(len(self.facts(code)['targetCallSyntax']), 1)
        self.assertEqual(len(self.facts(code)['calls']), 1)
        self.assertTrue(self.facts(code)['assertions'][0]['targetResult'])
        signature = [{'name': 'address_line', 'kind': 'positional_or_keyword'}]
        self.assertTrue(validate_target_calls(code, CONTEXT['target'], signature, CONTEXT)['valid'])
        self.assertFalse(validate_target_calls(code.replace('target(address_line)', 'target(address_line, 1)'),
                                              CONTEXT['target'], signature, CONTEXT)['valid'])

    def test_rebindings_unknown_control_flow_and_shadowing_are_not_proof(self):
        for body in [
            'target = DataCleaner.parse_address_line\ntarget = lambda x: ("", "", "")\nresult = target("")',
            'target = DataCleaner.parse_address_line\ndel target\nresult = target("")',
            'if flag:\n    target = DataCleaner.parse_address_line\nresult = target("")',
            'DataCleaner.parse_address_line = lambda x: ("", "", "")\ntarget = DataCleaner.parse_address_line\nresult = target("")',
            'for target in callbacks:\n    pass\nresult = target("")',
        ]:
            with self.subTest(body=body):
                code = candidate(body + '\nself.assertEqual(result, ("", "", ""))')
                self.assertFalse(has_target_result_assertion(ast.parse(code), CONTEXT))
                self.assertEqual(self.facts(code)['targetCallSyntax'], [])

    def test_unresolved_alias_reports_its_exact_call_location_and_repair(self):
        code = candidate('target = DataCleaner.parse_address_line\ntarget = lambda x: ("", "", "")\n'
                         'result = target("")\nself.assertEqual(result, ("", "", ""))')
        result = validate_bindings(code, {**CONTEXT, 'requireTargetBehavior': True})
        self.assertEqual(result['reasonCode'], 'target-alias-unresolved')
        self.assertIn('target:7', result['reason'])
        self.assertIn('canonical import', result['reason'])

    def test_alias_chains_are_proven_before_use_and_never_across_methods(self):
        code = candidate('first = DataCleaner.parse_address_line\nsecond = first\n'
                         'self.assertEqual(second(""), ("", "", ""))')
        self.assertTrue(has_target_result_assertion(ast.parse(code), CONTEXT))
        self.assertEqual(len(self.facts(code)['targetCallSyntax']), 1)
        self.assertFalse(has_target_result_assertion(ast.parse(candidate('self.assertEqual(target(""), ("", "", ""))')), CONTEXT))


if __name__ == '__main__':
    unittest.main()
