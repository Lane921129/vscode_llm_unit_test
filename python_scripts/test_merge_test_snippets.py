import ast
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from merge_test_snippets import merge, merge_addition, project_addition_context
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


class WriterAdditionMergeTests(unittest.TestCase):
    def accepted(self, addition, baseline=BASE):
        result = merge_addition(baseline, addition)
        self.assertTrue(result['ok'], result)
        self.assertTrue(validate(baseline, result['mergedCode'], 'all')['valid'])
        return result

    def rejected(self, addition, reason, baseline=BASE):
        result = merge_addition(baseline, addition)
        self.assertEqual(result, {'schemaVersion': 'writer-test-addition-v1', 'ok': False, 'reasonCode': reason})

    def test_bare_method_uses_existing_fixture_and_keeps_original_bytes(self):
        addition = "def test_beta(self):\n    self.assertEqual(target(self.value), 'alpha')\n"
        baseline = BASE + MAIN
        result = self.accepted(addition, baseline)
        self.assertTrue(result['mergedCode'].startswith(BASE))
        self.assertTrue(result['mergedCode'].endswith(MAIN))
        self.assertEqual(result['totalMethodsCount'], 2)
        self.assertEqual(result['addedMethods'], [{'className': 'Cases', 'name': 'test_beta'}])
        self.assertEqual(result['mergedCode'].count('def setUp('), 1)
        self.assertEqual(result['mergedCode'].count('class Cases('), 1)

    def test_same_class_addition_needs_no_fixture_copy(self):
        result = self.accepted("class Cases(unittest.TestCase):\n    def test_beta(self): self.assertEqual(target('b'), 'b')\n")
        self.assertEqual(result['addedMethodsCount'], 1)
        self.assertEqual(result['mergedCode'].count('def setUp('), 1)

    def test_complete_file_compatibility_ignores_only_identical_baseline(self):
        result = self.accepted(BASE + "    def test_beta(self): self.assertEqual(target('b'), 'b')\n" + MAIN)
        self.assertEqual(result['addedMethodsCount'], 1)
        self.assertEqual(result['mergedCode'].count('def test_alpha('), 1)
        self.assertEqual(result['mergedCode'].count('def test_beta('), 1)
        unchanged = self.accepted(BASE)
        self.assertEqual(unchanged['mergedCode'], BASE)
        self.assertEqual(unchanged['addedMethodsCount'], 0)

    def test_changed_existing_method_or_fixture_is_rejected_without_renaming(self):
        self.rejected(BASE.replace("target(self.value), 'alpha'", "target(self.value), 'wrong'"), 'existing-test-method-changed')
        self.rejected(BASE.replace("self.value = 'alpha'", "self.value = 'wrong'"), 'fixture-definition-conflict')
        self.rejected(BASE.replace('class Cases(', "@unittest.skip('changed')\nclass Cases("), 'class-header-conflict')

    def test_new_unique_class_retains_own_fixture_and_is_before_main(self):
        addition = OTHER.replace('class Cases(', 'class Added(')
        result = self.accepted(addition, BASE + MAIN)
        self.assertEqual(result['addedMethods'], [{'className': 'Added', 'name': 'test_empty'}])
        self.assertIn("self.value = 'empty'", result['mergedCode'])
        self.assertLess(result['mergedCode'].index('class Added('), result['mergedCode'].index("if __name__"))

    def test_imports_precede_new_decorators_without_rebinding_baseline(self):
        addition = 'from unittest.mock import patch\n@patch("neutral_source.external")\ndef test_beta(self, controlled):\n    self.assertEqual(target("b"), "b")\n'
        result = self.accepted(addition)
        self.assertLess(result['mergedCode'].index('from unittest.mock'), result['mergedCode'].index('@patch'))
        self.rejected(addition.replace('from unittest.mock import patch', 'from unrelated import target'), 'import-binding-conflict')
        self.rejected('from unrelated import len\ndef test_beta(self): self.assertEqual(target("b"), "b")\n',
                      'import-binding-conflict', BASE.replace('target(self.value)', 'target(len(self.value))'))

    def test_docstring_future_import_order_remains_valid(self):
        prefix = '"""Module contract."""\nfrom __future__ import annotations\n'
        result = self.accepted('from unittest.mock import patch\ndef test_beta(self): self.assertTrue(target("b"))\n', prefix + BASE)
        self.assertTrue(result['mergedCode'].startswith(prefix))
        compile(result['mergedCode'], '<controlled-test>', 'exec')
        self.rejected('from __future__ import division\ndef test_beta(self): pass\n', 'conflicting-future-import')

    def test_ambiguous_bare_method_requires_explicit_class(self):
        baseline = BASE + OTHER.replace('class Cases(', 'class Added(')
        self.rejected('def test_beta(self): self.assertTrue(target("b"))\n', 'ambiguous-addition-target', baseline)
        result = self.accepted('class Cases(unittest.TestCase):\n    def test_beta(self): self.assertTrue(target("b"))\n', baseline)
        self.assertEqual(result['totalMethodsCount'], 3)

    def test_duplicate_methods_and_class_assignments_cannot_shadow_tests(self):
        duplicate = 'class Added(unittest.TestCase):\n    def test_beta(self): pass\n    def test_beta(self): pass\n'
        self.rejected(duplicate, 'duplicate-test-method')
        self.rejected(duplicate.replace('    def test_beta(self): pass\n', '    test_beta = 1\n', 1), 'duplicate-test-method')
        baseline = BASE + '    test_beta = 1\n'
        self.rejected('def test_beta(self): pass\n', 'fixture-binding-conflict', baseline)
        self.rejected('def test_beta(self): pass\ndef test_beta(self): pass\n', 'duplicate-addition-definition')

    def test_same_addition_can_be_replaced_against_immutable_baseline(self):
        wrong = self.accepted('def test_beta(self): self.assertEqual(target("b"), "wrong")\n')
        fixed = self.accepted('def test_beta(self): self.assertEqual(target("b"), "b")\n')
        self.assertEqual(fixed['addedMethodsCount'], 1)
        self.assertNotIn('"wrong"', fixed['mergedCode'])
        self.assertNotEqual(wrong['mergedCode'], fixed['mergedCode'])
        self.rejected('def test_beta(self): self.assertEqual(target("b"), "b")\n', 'existing-test-method-changed', wrong['mergedCode'])

    def test_new_class_binding_cannot_shadow_a_baseline_global(self):
        self.rejected('class target(unittest.TestCase):\n    def test_beta(self): pass\n', 'fixture-binding-conflict')
        self.rejected('class Arbitrary(object):\n    def test_beta(self): pass\n', 'unsupported-test-class')

    def test_complete_indented_block_preserves_multiline_string_values(self):
        addition = '    def test_beta(self):\n        value = """start\n        middle\n        end"""\n        self.assertEqual(value, "start\\n        middle\\n        end")\n'
        result = self.accepted(addition)
        original = ast.parse('if True:\n' + addition).body[0].body[0]
        added = ast.parse(result['mergedCode']).body[-1].body[-1]
        self.assertEqual(ast.dump(original, include_attributes=False), ast.dump(added, include_attributes=False))

    def test_indented_prefix_does_not_hide_trailing_module_side_effects(self):
        self.rejected('    def test_beta(self): pass\nopen("must-not-run", "w")\n', 'unsupported-addition-context')
        self.rejected('    def test_beta(self): pass\nelse:\n    open("must-not-run", "w")\n', 'unsupported-addition-context')

    def test_ast_composition_never_executes_candidate_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'must-not-exist.txt'
            self.rejected("open(" + repr(str(marker)) + ", 'w').write('bad')\n", 'unsupported-addition-context')
            result = self.accepted('import nonexistent_addition_module_986\ndef test_beta(self): pass\n')
            self.assertIn('nonexistent_addition_module_986', result['mergedCode'])
            self.assertFalse(marker.exists())

    def test_method_limit_accepts_32_and_rejects_33_without_partial_output(self):
        methods = lambda count: ''.join('def test_case_' + str(index) + '(self): pass\n' for index in range(count))
        self.assertEqual(self.accepted(methods(32))['addedMethodsCount'], 32)
        self.rejected(methods(33), 'too-many-additional-methods')

    def test_crlf_and_missing_final_newline_preserve_baseline_text(self):
        for baseline in (BASE.replace('\n', '\r\n'), BASE.rstrip('\n')):
            result = self.accepted('def test_beta(self): self.assertTrue(target("b"))\n', baseline)
            self.assertTrue(result['mergedCode'].startswith(baseline))

    def test_cli_accepts_utf8_under_a_non_utf8_console(self):
        import os
        value = {'mode': 'writer-addition-v1', 'baseline': BASE, 'addition': 'def test_邊界(self): self.assertEqual(target("測試"), "測試")\n'}
        run = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('merge_test_snippets.py'))],
                             input=json.dumps(value, ensure_ascii=False).encode('utf-8'), capture_output=True,
                             env={**os.environ, 'PYTHONIOENCODING': 'cp1252'}, timeout=5, check=True)
        result = json.loads(run.stdout)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['addedMethods'][0]['name'], 'test_邊界')

    def test_merged_baseline_and_addition_actually_execute(self):
        result = self.accepted('def test_beta(self): self.assertEqual(target(self.value), "alpha")\n', BASE + MAIN)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'neutral_source.py').write_text('def target(value): return value\n', encoding='utf-8')
            (root / 'test_candidate.py').write_text(result['mergedCode'], encoding='utf-8')
            run = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'test_candidate'], cwd=root,
                                 capture_output=True, text=True, timeout=5)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn('Ran 2 tests', run.stderr)


class WriterAdditionContextTests(unittest.TestCase):
    SIMPLE = '''import unittest
from nonexistent_projection_target_987 import target
class Cases(unittest.TestCase):
    def test_original(self):
        """An old example with a unique old answer."""
        self.assertEqual(target(987.654, 123.456), 'old-answer-987')
    def test_例外(self):
        with self.assertRaises(ZeroDivisionError):
            target(789, 0)
'''

    def rejected(self, code, reason='addition-context-unsupported'):
        result = project_addition_context(code)
        self.assertEqual(result, {'schemaVersion': 'writer-addition-context-v1', 'ok': False, 'reasonCode': reason})

    def test_simple_projection_removes_every_body_without_importing_or_generating_tests(self):
        import hashlib
        result = project_addition_context(self.SIMPLE)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['methodIds'], ['Cases.test_original', 'Cases.test_例外'])
        self.assertEqual(result['baselineHash'], hashlib.sha256(self.SIMPLE.encode('utf-8')).hexdigest())
        self.assertEqual(result['contextCode'], 'import unittest\nfrom nonexistent_projection_target_987 import target\n\nclass Cases(unittest.TestCase):\n    pass\n')
        tree = ast.parse(result['contextCode'])
        self.assertEqual(len(tree.body), 3)
        self.assertIsInstance(tree.body[-1].body[0], ast.Pass)
        self.assertFalse(any(isinstance(node, (ast.Call, ast.FunctionDef, ast.Assert, ast.Constant)) for node in ast.walk(tree)))

    def test_standard_import_aliases_and_exact_main_guard_are_supported(self):
        cases = [self.SIMPLE.replace('import unittest', 'import unittest as standard').replace('unittest.TestCase', 'standard.TestCase')
                 + "\nif __name__ == '__main__':\n    standard.main()\n",
                 self.SIMPLE.replace('import unittest', 'from unittest import TestCase as Standard').replace('unittest.TestCase', 'Standard')]
        for baseline in cases:
            with self.subTest(baseline=baseline):
                result = project_addition_context(baseline)
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['methodIds'], ['Cases.test_original', 'Cases.test_例外'])
                self.assertNotIn('__main__', result['contextCode'])
                self.assertNotIn('old-answer-987', result['contextCode'])

    def test_classmethod_decorator_annotation_async_or_unknown_base_falls_back(self):
        cases = [self.SIMPLE.replace('    def test_original', '    @classmethod\n    def test_original'),
                 self.SIMPLE.replace('class Cases(', "@unittest.skip('skip')\nclass Cases("),
                 self.SIMPLE.replace('test_original(self)', 'test_original(self, value=1)'),
                 self.SIMPLE.replace('test_original(self)', 'test_original(self: object)'),
                 self.SIMPLE.replace('def test_original', 'async def test_original'),
                 self.SIMPLE.replace('unittest.TestCase', 'unittest.IsolatedAsyncioTestCase'),
                 self.SIMPLE.replace('import unittest', 'from unrelated import unittest'),
                 self.SIMPLE.replace('class Cases(unittest.TestCase)', 'class Cases(unittest.TestCase, metaclass=Custom)')]
        for code in cases:
            with self.subTest(code=code):
                self.rejected(code)

    def test_fixtures_helpers_and_global_context_are_not_silently_removed(self):
        cases = [BASE,
                 self.SIMPLE.replace('    def test_original', '    def helper(self): pass\n    def test_original'),
                 self.SIMPLE.replace('    def test_original', '    state = 42\n    def test_original'),
                 'shared = 123\n' + self.SIMPLE,
                 'def helper(): return 1\n' + self.SIMPLE,
                 '"""Unknown module context."""\n' + self.SIMPLE,
                 self.SIMPLE + '\nimport another_target\n',
                 self.SIMPLE.replace('    def test_original', "    def test_original")
                 .replace('        self.assertEqual', '        global shared\n        self.assertEqual'),
                 self.SIMPLE.replace('        self.assertEqual', '        unittest.TestCase = object\n        self.assertEqual'),
                 self.SIMPLE.replace('        self.assertEqual', '        def nested(): pass\n        self.assertEqual')]
        for code in cases:
            with self.subTest(code=code):
                self.rejected(code)

    def test_reflection_method_dependencies_and_mock_fixtures_fall_back(self):
        bodies = ["getattr(self, 'test_original')()", "self.__dict__.clear()", 'self.test_例外()',
                  'Cases.test_original(self)', 'locals()', 'unittest.mock.patch("neutral.source")',
                  'retrieve(self, "test_original")', 'ControlledMock()']
        for body in bodies:
            code = 'from builtins import getattr as retrieve\nfrom unittest.mock import Mock as ControlledMock\n' + self.SIMPLE
            code = code.replace("self.assertEqual(target(987.654, 123.456), 'old-answer-987')", body)
            with self.subTest(body=body):
                self.rejected(code)

    def test_ambiguous_import_class_method_or_nonexact_main_falls_back(self):
        cases = [self.SIMPLE + '\n' + self.SIMPLE,
                 self.SIMPLE.replace('    def test_例外', '    def test_original'),
                 self.SIMPLE.replace('import unittest', 'import unittest\nfrom other import unittest'),
                 self.SIMPLE.replace('import unittest', 'import unittest as standard, other as standard'),
                 self.SIMPLE.replace('class Cases(', 'class target('),
                 self.SIMPLE + "\nif __name__ == '__main__':\n    unittest.main(exit=False)\n",
                 self.SIMPLE + "\nif __name__ == '__main__':\n    unittest.main()\nelse:\n    pass\n",
                 self.SIMPLE + "\nif __name__ == '__main__':\n    unittest.main()\n    helper()\n"]
        for code in cases:
            with self.subTest(code=code):
                self.rejected(code)

    def test_invalid_input_and_ast_are_typed_and_return_no_partial_context(self):
        for value in [None, '', ' ']:
            self.rejected(value, 'invalid-baseline-input')
        self.rejected('class invalid !', 'invalid-python-structure')

    def test_store_through_imported_object_subscript_retains_complete_context(self):
        for operation in ['state.options["mode"] = "changed"', 'state.options["groups"][0].options["mode"] = "changed"',
                          'flags["mode"] = "changed"']:
            baseline = 'import neutral_state as state\nfrom neutral_state import flags\n' + self.SIMPLE
            baseline = baseline.replace('        self.assertEqual', '        ' + operation + '\n        self.assertEqual')
            self.rejected(baseline)

    def test_delete_through_imported_object_subscript_retains_complete_context(self):
        for operation in ['del state.options["mode"]', 'del state.options["groups"][0].options["mode"]', 'del flags["mode"]']:
            baseline = 'import neutral_state as state\nfrom neutral_state import flags\n' + self.SIMPLE
            baseline = baseline.replace('        self.assertEqual', '        ' + operation + '\n        self.assertEqual')
            self.rejected(baseline)

    def test_projection_never_replaces_original_bytes_in_host_composition(self):
        baseline = (self.SIMPLE + MAIN).replace('\n', '\r\n')
        view = project_addition_context(baseline)
        self.assertTrue(view['ok'], view)
        merged = merge_addition(baseline, "def test_added(self): self.assertEqual(target(321, 654), 'new-answer')\n")
        self.assertTrue(merged['ok'], merged)
        self.assertTrue(merged['mergedCode'].startswith(self.SIMPLE.replace('\n', '\r\n')))
        self.assertTrue(merged['mergedCode'].endswith(MAIN.replace('\n', '\r\n')))
        self.assertTrue(validate(baseline, merged['mergedCode'], 'all')['valid'])
        self.assertIn('old-answer-987', merged['mergedCode'])
        self.assertNotIn('old-answer-987', view['contextCode'])
        changed = merge_addition(baseline, self.SIMPLE.replace('old-answer-987', 'wrong-answer'))
        self.assertFalse(changed['ok'])
        self.assertEqual(changed['reasonCode'], 'existing-test-method-changed')

    def test_cli_mode_and_utf8_hash_do_not_depend_on_output_encoding(self):
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('merge_test_snippets.py'))],
                                input=json.dumps({'mode': 'writer-addition-context-v1', 'baseline': self.SIMPLE}, ensure_ascii=False).encode('utf-8'),
                                capture_output=True, timeout=5, check=True)
        self.assertEqual(json.loads(result.stdout), project_addition_context(self.SIMPLE))


if __name__ == '__main__':
    unittest.main()
