"""Explicit namespace members retain Mock identity; unknown objects do not."""
import ast
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from mock_behavior import has_mock_behavior
from validate_test_bindings import validate_bindings


SOURCE = 'def target(page):\n    page.update()\n'
IMPORTS = 'import unittest\nfrom unittest.mock import MagicMock\nfrom types import SimpleNamespace\nfrom sample import target\n'


class MockNamespaceBehaviorTests(unittest.TestCase):
    def check(self, body, *, imports=IMPORTS, setup='', source=SOURCE):
        code = imports + 'class Cases(unittest.TestCase):\n' + setup
        code += '    def test_case(self):\n' + ''.join('        ' + line + '\n' for line in body.splitlines())
        context = {'module': 'sample', 'target': 'target', 'source': source,
                   'dependencies': {}, 'requireMockBehavior': True, 'requireTargetBehavior': True}
        actual = has_mock_behavior(ast.parse(code), context)
        self.assertEqual(validate_bindings(code, context)['valid'], actual)
        return actual

    def test_direct_namespace_mock_is_injected_and_asserted_after_real_target_call(self):
        self.assertTrue(self.check('page = SimpleNamespace(update=MagicMock())\ntarget(page)\npage.update.assert_called_once_with()'))

    def test_nested_namespace_constructor_preserves_exact_member_mock_identity(self):
        source = 'def target(page):\n    page.overlay.append("controlled")\n    page.update()\n'
        self.assertTrue(self.check('page = SimpleNamespace(overlay=SimpleNamespace(append=MagicMock()), update=MagicMock())\n'
                                  'target(page)\npage.overlay.append.assert_called_once_with("controlled")', source=source))

    def test_module_and_import_aliases_resolve_only_the_real_namespace_constructor(self):
        imports = 'import unittest\nimport types as records\nfrom unittest.mock import MagicMock as stub\nfrom sample import target\n'
        self.assertTrue(self.check('page = records.SimpleNamespace(update=stub())\ntarget(page)\npage.update.assert_called_once()', imports=imports))

    def test_prebuilt_mock_keeps_identity_when_referenced_from_namespace(self):
        self.assertTrue(self.check('update = MagicMock()\npage = SimpleNamespace(update=update)\ntarget(page)\nupdate.assert_called_once()'))

    def test_namespace_alias_and_member_assignment_share_the_same_object(self):
        self.assertTrue(self.check('page = SimpleNamespace()\nalias = page\nalias.update = MagicMock()\ntarget(page)\npage.update.assert_called_once()'))

    def test_nested_namespace_alias_member_replacement_updates_every_owner(self):
        self.assertTrue(self.check('nested = SimpleNamespace(update=MagicMock())\npage = SimpleNamespace(inner=nested)\n'
                                  'alias = page.inner\nalias.update = MagicMock()\ntarget(nested)\npage.inner.update.assert_called_once()'))

    def test_old_member_does_not_borrow_new_member_observation_after_alias_replacement(self):
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\nold = page.update\nalias = page\n'
                                   'alias.update = MagicMock()\ntarget(page)\nold.assert_called_once()'))

    def test_unknown_member_write_through_alias_revokes_every_namespace_owner(self):
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\nalias = page\nalias.update = object()\n'
                                   'target(page)\npage.update.assert_called_once()'))

    def test_root_rebinding_does_not_observe_the_old_namespace(self):
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\nold = page\npage = SimpleNamespace(update=MagicMock())\n'
                                   'target(page)\nold.update.assert_called_once()'))
        self.assertTrue(self.check('page = SimpleNamespace(update=MagicMock())\nold = page\npage = object()\n'
                                  'target(old)\nold.update.assert_called_once()'))

    def test_uninjected_namespace_and_unexecuted_target_cannot_supply_evidence(self):
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\nother = SimpleNamespace(update=MagicMock())\n'
                                   'target(other)\npage.update.assert_called_once()'))
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\npage.update.assert_not_called()'))

    def test_manual_member_call_cannot_be_credited_to_target(self):
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\npage.update()\ntarget(page)\npage.update.assert_called()'))

    def test_namespaces_and_unknown_members_are_never_auto_created_mocks(self):
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\ntarget(page)\npage.assert_called_once()'))
        self.assertFalse(self.check('page = SimpleNamespace(update=object())\ntarget(page)\npage.update.assert_called_once()'))
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\ntarget(page)\npage.unlisted.assert_called_once()'))

    def test_fake_and_rebound_namespace_factories_do_not_gain_provenance(self):
        self.assertFalse(self.check('SimpleNamespace = object\npage = SimpleNamespace(update=MagicMock())\n'
                                   'target(page)\npage.update.assert_called_once()'))
        imports = IMPORTS.replace('from types import SimpleNamespace', 'from arbitrary import SimpleNamespace')
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\ntarget(page)\npage.update.assert_called_once()', imports=imports))

    def test_dynamic_constructor_kwargs_and_fake_mock_assertion_methods_are_rejected(self):
        self.assertFalse(self.check('fields = {"update": MagicMock()}\npage = SimpleNamespace(**fields)\n'
                                   'target(page)\npage.update.assert_called_once()'))
        self.assertFalse(self.check('fields = {}\npage = SimpleNamespace(update=MagicMock(**fields))\n'
                                   'target(page)\npage.update.assert_called_once()'))
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock(assert_called_once=lambda: None))\n'
                                   'target(page)\npage.update.assert_called_once()'))

    def test_overwriting_mock_assertion_after_namespace_construction_remains_rejected(self):
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\npage.update.assert_called_once = MagicMock()\n'
                                   'target(page)\npage.update.assert_called_once()'))

    def test_reflective_mutation_cannot_borrow_namespace_member_proof(self):
        for mutation in ('setattr(page, "update", MagicMock())', 'page.__dict__["update"] = MagicMock()',
                         'vars(page)["update"] = MagicMock()', 'globals()["page"] = page'):
            with self.subTest(mutation=mutation):
                self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\n' + mutation
                                            + '\ntarget(page)\npage.update.assert_called_once()'))

    def test_branch_and_positional_namespace_constructor_are_not_proven(self):
        self.assertFalse(self.check('page = SimpleNamespace(update=MagicMock())\nif True:\n    target(page)\npage.update.assert_called_once()'))
        self.assertFalse(self.check('page = SimpleNamespace({"update": MagicMock()})\ntarget(page)\npage.update.assert_called_once()'))

    def test_standard_setup_namespace_is_transferred_only_through_the_instance(self):
        setup = '    def setUp(self):\n        self.page = SimpleNamespace(update=MagicMock())\n'
        self.assertTrue(self.check('target(self.page)\nself.page.update.assert_called_once()', setup=setup))
        setup = '    def setUp(self):\n        page = SimpleNamespace(update=MagicMock())\n'
        self.assertFalse(self.check('target(page)\npage.update.assert_called_once()', setup=setup))

    def test_namespace_cycles_do_not_loop_or_fabricate_mock_members(self):
        self.assertTrue(self.check('page = SimpleNamespace(update=MagicMock())\npage.self = page\ntarget(page)\npage.update.assert_called_once()'))
        self.assertFalse(self.check('page = SimpleNamespace()\npage.self = page\ntarget(page)\npage.update.assert_called_once()'))


if __name__ == '__main__':
    unittest.main()
