import io
import sys
import types
import unittest
from unittest.mock import patch

from python_scripts.rescue_unittest import rescue_unittest


class RescueUnittestTests(unittest.TestCase):
    def execute_rescue(self, source, implementation="def add(a, b): return a + b"):
        module = types.ModuleType("rescue_fixture")
        exec(implementation, module.__dict__)
        code = rescue_unittest(source, "rescue_fixture")
        self.assertTrue(code)
        namespace = {}
        with patch.dict(sys.modules, {"rescue_fixture": module}):
            exec(compile(code, "<rescued>", "exec"), namespace)
            suite = unittest.defaultTestLoader.loadTestsFromTestCase(namespace["TestAuto"])
            return unittest.TextTestRunner(stream=io.StringIO()).run(suite)

    def test_commas_nested_values_and_literal_messages(self):
        result = self.execute_rescue('assert add(1, 2) == 3, "failed, please retry"\n'
                                     'assert [add(1, 2), {"a,b": 3}] == [3, {"a,b": 3}]')
        self.assertTrue(result.wasSuccessful())

    def test_boolean_conditions_and_chained_comparisons(self):
        result = self.execute_rescue('assert (add(1, 2) == 3 or add(2, 3) == 9)\n'
                                     'assert add(1, 1) == 2 == 2')
        self.assertTrue(result.wasSuccessful())

    def test_setup_remains_available_for_later_assertions(self):
        result = self.execute_rescue('result = add(1, 2)\nassert result == 3\nassert result > 0')
        self.assertTrue(result.wasSuccessful())

    def test_multiline_and_repl_continuations(self):
        result = self.execute_rescue('>>> assert (\n...     add(1, 2)\n...     == 3\n... )')
        self.assertTrue(result.wasSuccessful())

    def test_wrong_behavior_still_fails_with_original_message(self):
        result = self.execute_rescue('assert add(1, 2) == 3, "failed, please retry"',
                                     'def add(a, b): return a - b')
        self.assertFalse(result.wasSuccessful())
        self.assertIn('failed, please retry', result.failures[0][1])

    def test_unsupported_scopes_invalid_syntax_and_dynamic_messages_are_declined(self):
        for source in ('def add(a, b): return 3\nassert add(1, 2) == 3',
                       'if True:\n    assert add(1, 2) == 3',
                       'assert add(', 'value = 3',
                       'assert add(1, 2) == 3, add(9, 9)'):
            with self.subTest(source=source):
                self.assertEqual(rescue_unittest(source, 'rescue_fixture'), '')

    def test_source_is_parsed_without_executing_setup(self):
        self.assertTrue(rescue_unittest('value = missing_function()\nassert value == 1', 'fixture'))
        self.assertEqual(rescue_unittest('assert True', 'fixture\nimport os'), '')


if __name__ == '__main__':
    unittest.main()
