import ast
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from merge_test_snippets import merge
from passing_test_preservation import validate


BASE = '''import unittest
from neutral_source import target

# This executed fixture must stay verbatim.
class Cases(unittest.TestCase):
    def setUp(self):
        self.value = 'alpha'
    def test_alpha(self):
        self.assertEqual(target(self.value), 'alpha')
'''
MAIN = "\nif __name__ == '__main__':\n    unittest.main()\n"
OTHER = BASE.replace("'alpha'", "'empty'").replace('test_alpha', 'test_empty')


class BaselineMergeTests(unittest.TestCase):
    def accepted(self, snippets, baseline=BASE):
        result = merge(baseline, snippets, 'NeutralCases')
        self.assertTrue(result['ok'], result)
        preserved = validate(baseline, result['mergedCode'], 'all')
        self.assertTrue(preserved['valid'], preserved)
        return result

    def test_preserves_exact_baseline_and_separate_caller_fixture(self):
        baseline = (BASE + MAIN).replace('\n', '\r\n')
        result = self.accepted([BASE, OTHER], baseline)
        code = result['mergedCode']
        self.assertTrue(code.startswith(BASE.replace('\n', '\r\n')))
        self.assertTrue(code.endswith(MAIN.lstrip('\n').replace('\n', '\r\n')))
        self.assertEqual(result['totalMethodsCount'], 2)
        self.assertIn('class Cases(unittest.TestCase):', code)
        self.assertIn('class NeutralCases_Site1(unittest.TestCase):', code)
        self.assertLess(code.index('class NeutralCases_Site1'), code.index("if __name__ == '__main__'"))
        classes = [node for node in ast.parse(code).body if isinstance(node, ast.ClassDef)]
        self.assertEqual([node.name for node in classes], ['Cases', 'NeutralCases_Site1'])
        self.assertIn("self.value = 'empty'", ast.unparse(classes[1]))

    def test_full_expansion_files_deduplicate_baseline_without_dropping_other_classes(self):
        extra = "\nclass Extra(unittest.TestCase):\n    def test_extra(self): self.assertEqual(target('x'), 'x')\n"
        last = "\nclass Last(unittest.TestCase):\n    def test_last(self): self.assertEqual(target('y'), 'y')\n"
        result = self.accepted([BASE + extra + MAIN, BASE + extra + last + MAIN])
        self.assertEqual(result['totalMethodsCount'], 3)
        self.assertEqual(result['mergedCode'].count('def test_alpha('), 1)
        self.assertEqual(result['mergedCode'].count('class Extra('), 1)
        self.assertIn('class Last(', result['mergedCode'])

    def test_repeated_baseline_alone_is_exactly_unchanged(self):
        baseline = BASE + MAIN
        result = self.accepted([baseline, baseline], baseline)
        self.assertEqual(result['mergedCode'], baseline)
        self.assertEqual(result['totalMethodsCount'], 1)

    def test_changed_same_named_method_is_retained_as_an_independent_candidate(self):
        changed = BASE.replace("target(self.value), 'alpha'", "target(self.value), 'changed'")
        result = self.accepted([changed])
        self.assertEqual(result['totalMethodsCount'], 2)
        self.assertTrue(result['mergedCode'].startswith(BASE))
        self.assertIn("target(self.value), 'changed'", result['mergedCode'])
        self.assertEqual(result['mergedCode'].count('def test_alpha('), 2)

    def test_same_class_expansion_prunes_only_identical_baseline_methods(self):
        expanded = BASE + "    def test_extra(self): self.assertEqual(target('x'), 'x')\n"
        result = self.accepted([expanded, expanded])
        self.assertEqual(result['totalMethodsCount'], 2)
        self.assertEqual(result['mergedCode'].count('def test_alpha('), 1)
        self.assertEqual(result['mergedCode'].count('def test_extra('), 1)
        self.assertEqual(result['mergedCode'].count('def setUp('), 2, 'each independent class retains its fixture')

    def test_copied_method_used_as_a_helper_cannot_be_silently_removed(self):
        expanded = BASE + '    def test_extra(self): self.test_alpha()\n'
        result = merge(BASE, [expanded])
        self.assertFalse(result['ok'])
        self.assertEqual(result['reasonCode'], 'duplicate-test-reference')

    def test_unique_decorated_and_async_classes_keep_their_headers_and_methods(self):
        extra = '''from unittest import IsolatedAsyncioTestCase as AsyncCase
@unittest.skip('neutral')
class AsyncCases(AsyncCase):
    async def test_async(self):
        self.assertEqual(target('async'), 'async')
'''
        result = self.accepted([BASE + '\n' + extra])
        self.assertIn('from unittest import IsolatedAsyncioTestCase as AsyncCase', result['mergedCode'])
        self.assertIn(extra[extra.index('@unittest.skip'):].strip(), result['mergedCode'])
        self.assertEqual(result['totalMethodsCount'], 2)

    def test_conflicting_import_or_fixture_is_rejected_without_partial_output(self):
        helper = '\ndef helper(): return 1\n'
        cases = [
            (BASE.replace('from neutral_source import target', 'from unrelated import target'), BASE, 'import-binding-conflict'),
            (BASE + helper.replace('return 1', 'return 2'), BASE + helper, 'fixture-definition-conflict'),
            (BASE + '\nshared = 3\n', BASE, 'unsupported-module-context'),
            (BASE + '\nfrom __future__ import annotations\n', BASE, 'conflicting-future-import'),
        ]
        for snippet, baseline, reason in cases:
            with self.subTest(reason=reason):
                result = merge(baseline, [snippet])
                self.assertFalse(result['ok'])
                self.assertEqual(result['reasonCode'], reason)
                self.assertNotIn('mergedCode', result)

    def test_rename_rejects_self_references_decorators_and_cross_class_references(self):
        cases = [
            OTHER.replace("self.value = 'empty'", 'self.value = Cases'),
            OTHER.replace("self.value = 'empty'", 'self.value = self.__class__.__name__'),
            OTHER + '\nclass Derived(Cases):\n    pass\n',
            OTHER.replace('class Cases(', "@unittest.skip('neutral')\nclass Cases("),
        ]
        for snippet in cases:
            with self.subTest(snippet=snippet):
                result = merge(BASE, [snippet])
                self.assertFalse(result['ok'])
                self.assertEqual(result['reasonCode'], 'class-rename-reference')

    def test_duplicate_definitions_unknown_module_context_and_syntax_are_not_dropped(self):
        cases = [BASE + '\n' + OTHER, BASE + '\nif True:\n    shared = 1\n',
                 BASE + '\nfrom unknown import *\n', BASE + '\nsyntax error !']
        for snippet in cases:
            result = merge(BASE, [snippet])
            self.assertFalse(result['ok'])
            self.assertNotIn('mergedCode', result)

    def test_generated_class_name_cannot_shadow_an_existing_candidate_name(self):
        unique = OTHER.replace('Cases(', 'NeutralCases_Site1(')
        result = self.accepted([OTHER, unique])
        self.assertIn('class NeutralCases_Site2(', result['mergedCode'])
        self.assertIn('class NeutralCases_Site1(', result['mergedCode'])
        self.assertEqual(result['totalMethodsCount'], 3)

    def test_only_ast_is_inspected_and_no_candidate_import_or_side_effect_executes(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'must-not-exist.txt'
            dangerous = BASE + '\nopen(' + repr(str(marker)) + ", 'w').write('changed')\n"
            self.assertFalse(merge(BASE, [dangerous])['ok'])
            self.assertFalse(marker.exists())
            # This module is intentionally unavailable. Parsing must never import it.
            result = self.accepted([BASE + '\nimport nonexistent_neutral_fixture_987\n'])
            self.assertIn('import nonexistent_neutral_fixture_987', result['mergedCode'])

    def test_new_import_cannot_rebind_a_prior_partition_global_reference(self):
        first = BASE + '\nclass Extra(unittest.TestCase):\n    def test_extra(self): self.assertEqual(len([]), 0)\n'
        second = BASE + '\nfrom unrelated import len\n'
        result = merge(BASE, [first, second])
        self.assertFalse(result['ok'])
        self.assertEqual(result['reasonCode'], 'import-binding-conflict')


if __name__ == '__main__':
    unittest.main()
