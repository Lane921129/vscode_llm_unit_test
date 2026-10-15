"""Import counting is based on AST bindings, never raw model response lines."""
import unittest

from validate_repair_scope import validate_detailed


PREVIOUS = '''import unittest
from unittest.mock import MagicMock, patch
import math as numbers

class Cases(unittest.TestCase):
    def setUp(self):
        self.value = 2
    def test_value(self):
        self.assertEqual(self.value, 999)
    def test_keep(self):
        self.assertEqual(self.value, 2)
'''
FAILURE = 'FAIL: test_value (Cases.test_value)\nAssertionError: 2 != 999'
REPAIRED = PREVIOUS.replace('self.value, 999', 'self.value, 2')


class RepairImportScopeTests(unittest.TestCase):
    def check(self, added='', previous=PREVIOUS, candidate=REPAIRED):
        return validate_detailed(previous, added + candidate, FAILURE)

    def test_existing_and_repeated_statements_count_as_zero_new(self):
        imports = 'import unittest\n' * 4
        self.assertEqual(self.check(imports), (True, '', None))

    def test_equivalent_split_aliases_and_whitespace_count_as_zero_new(self):
        imports = ('from unittest.mock import patch\n'
                   'from unittest.mock import MagicMock\n'
                   'import math   as   numbers\n'
                   'from unittest.mock import MagicMock, patch\n')
        self.assertEqual(self.check(imports), (True, '', None))

    def test_repeated_new_statements_count_only_once(self):
        self.assertEqual(self.check('import datetime\n' * 4), (True, '', None))

    def test_four_truly_missing_import_statements_are_rejected(self):
        self.assertEqual(self.check('import os\nimport sys\nimport decimal\nimport fractions\n')[2], 'import-limit')

    def test_three_new_statements_plus_many_existing_are_allowed(self):
        imports = 'import unittest\n' * 4 + 'import os\nimport sys\nimport decimal\n'
        self.assertEqual(self.check(imports), (True, '', None))

    def test_same_import_with_a_new_alias_is_new_and_safe(self):
        self.assertEqual(self.check('import math as calculations\n'), (True, '', None))

    def test_conflicting_existing_alias_is_rejected(self):
        self.assertEqual(self.check('import decimal as numbers\n')[2], 'import-conflict')

    def test_conflicting_new_aliases_are_rejected(self):
        self.assertEqual(self.check('import decimal as extra\nimport fractions as extra\n')[2], 'import-conflict')

    def test_reordered_from_import_can_include_one_missing_binding(self):
        self.assertEqual(self.check('from unittest.mock import patch, MagicMock, call\n'), (True, '', None))

    def test_equivalent_import_must_not_rebind_existing_assignment(self):
        previous = PREVIOUS.replace('class Cases', 'patch = 7\n\nclass Cases')
        candidate = previous.replace('self.value, 999', 'self.value, 2')
        self.assertEqual(self.check('from unittest.mock import patch\n', previous, candidate)[2], 'import-conflict')

    def test_wildcards_and_non_import_bindings_are_rejected(self):
        self.assertEqual(self.check('from unittest.mock import *\n')[2], 'import-star')
        self.assertEqual(self.check('import math as Cases\n')[2], 'import-conflict')

    def test_ast_scope_never_imports_the_candidate_dependency(self):
        self.assertEqual(self.check('import nonexistent_repair_dependency_987654\n'), (True, '', None))

    def test_fixture_passing_method_signature_and_method_change_are_still_protected(self):
        self.assertEqual(self.check(candidate=REPAIRED.replace('self.value = 2', 'self.value = 3'))[2], 'unrelated-method-change')
        self.assertEqual(self.check(candidate=REPAIRED.replace('self.value, 2', 'self.value, 3'))[2], 'unrelated-method-change')
        self.assertEqual(self.check(candidate=REPAIRED.replace('test_value(self)', 'test_value(self, extra)'))[2], 'outside-method-change')
        self.assertEqual(self.check('import os\n', candidate=PREVIOUS)[2], 'no-method-change')


if __name__ == '__main__':
    unittest.main()
