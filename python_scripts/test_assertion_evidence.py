import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from validate_assertion_evidence import check
from trace_value_codec import snapshot_call


class LiteralKeywordEvidenceTests(unittest.TestCase):
    def check_statement(self, expression, kwargs, expected="'wrong'", result="'observed'", typed=None):
        example = {'args': [], 'kwargs': kwargs, 'result': result}
        if typed is not None:
            example['input_before'] = typed
        return check({'target': 'target', 'module': 'sample', 'trace': {'examples': [example]}, 'code':
                      'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
                      f'    def test_value(self):\n        self.assertEqual({expression}, {expected})\n'})

    def test_literal_expansion_checks_matching_oracle_without_reordering_keys(self):
        kwargs = {'second': '2', 'first': '1'}
        contradicted = self.check_statement("target(**{'second': 2, 'first': 1})", kwargs)
        self.assertFalse(contradicted['valid'])
        self.assertEqual(contradicted['checked'], 1)
        unobserved = self.check_statement("target(**{'first': 1, 'second': 2})", kwargs)
        self.assertEqual(unobserved, {'valid': True, 'checked': 0})

    def test_one_dict_duplicate_uses_last_value_and_first_insertion_position(self):
        result = self.check_statement("target(**{'a': 1, 'b': 2, 'a': 3})", {'a': '3', 'b': '2'})
        self.assertFalse(result['valid'])
        self.assertEqual(result['checked'], 1)

    def test_explicit_and_multiple_literal_expansions_preserve_call_order(self):
        result = self.check_statement("target(first=1, **{'second': 2}, **{'third': 3})",
                                      {'first': '1', 'second': '2', 'third': '3'})
        self.assertFalse(result['valid'])
        self.assertEqual(result['checked'], 1)

    def test_duplicate_across_call_arguments_cannot_borrow_a_success_oracle(self):
        for expression in ("target(a=1, **{'a': 1})", "target(**{'a': 1}, **{'a': 1})"):
            with self.subTest(expression=expression):
                self.assertEqual(self.check_statement(expression, {'a': '1'}), {'valid': True, 'checked': 0})

    def test_nonliteral_nonstring_and_nested_expansions_remain_unknown(self):
        for expression in ('target(**values)', "target(**dict(a=1))", "target(**{1: 1})",
                           "target(**{b'a': 1})", "target(**{'a': unknown})",
                           "target(**{'a': unknown, 'a': 1})", "target(**{**{'a': 1}})"):
            with self.subTest(expression=expression):
                self.assertEqual(self.check_statement(expression, {'a': '1'}), {'valid': True, 'checked': 0})

    def test_typed_snapshot_overrides_json_object_key_order_without_type_loss(self):
        before = snapshot_call([], {'第二': '你好😀\n', '2': 1.0, '1': -0.0}, [], {})
        reordered_legacy = {'1': '-0.0', '2': '1.0', '第二': repr('你好😀\n')}
        expression = "target(**{'第二': '你好😀\\n', '2': 1.0, '1': -0.0})"
        self.assertFalse(self.check_statement(expression, reordered_legacy, typed=before)['valid'])
        result = self.check_statement(expression, reordered_legacy, expected="'observed'", typed=before)
        self.assertEqual(result, {'valid': True, 'checked': 1})

    def test_invalid_typed_snapshot_never_falls_back_to_legacy_keyword_facts(self):
        before = snapshot_call([], {'a': 1}, [], {})
        before['kwargs'] = snapshot_call([], {'a': 2}, [], {})['kwargs']
        result = self.check_statement('target(a=1)', {'a': '1'}, typed=before)
        self.assertEqual(result, {'valid': True, 'checked': 0})


if __name__ == '__main__':
    unittest.main()
