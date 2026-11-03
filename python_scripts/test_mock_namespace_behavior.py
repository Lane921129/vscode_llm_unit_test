"""Explicit namespace members retain Mock identity; unknown objects do not."""
import ast
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from mock_behavior import has_mock_behavior, source_namespace_use_points
from validate_test_bindings import validate_bindings


SOURCE = 'def target(page):\n    page.update()\n'
IMPORTS = 'import unittest\nfrom unittest.mock import MagicMock\nfrom types import SimpleNamespace\nfrom sample import target\n'


class MockNamespaceBehaviorTests(unittest.TestCase):
    def check(self, body, *, imports=IMPORTS, setup='', source=SOURCE, module_source=None):
        code = imports + 'class Cases(unittest.TestCase):\n' + setup
        code += '    def test_case(self):\n' + ''.join('        ' + line + '\n' for line in body.splitlines())
        context = {'module': 'sample', 'target': 'target', 'source': source,
                   'dependencies': {}, 'requireMockBehavior': True, 'requireTargetBehavior': True}
        if module_source is not None:
            context['moduleSource'] = module_source
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

    def test_source_module_namespace_patch_observes_only_source_used_members(self):
        source = 'def target(width):\n    return ui.Panel(width)\n'
        module_source = 'import widgets as ui\n' + source
        imports = 'import unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
        body = 'with patch("sample.ui") as controlled:\n    target(5)\n    controlled.Panel.assert_called_once_with(5)'
        self.assertTrue(self.check(body, imports=imports, source=source, module_source=module_source))
        unrelated = body.replace('controlled.Panel.assert_called_once_with(5)', 'controlled.unrelated.assert_not_called()')
        self.assertFalse(self.check(unrelated, imports=imports, source=source, module_source=module_source))
        configured = body.replace('    target(5)', '    controlled.unrelated = unittest.mock.MagicMock()\n    target(5)')
        configured = configured.replace('controlled.Panel.assert_called_once_with(5)', 'controlled.unrelated.assert_not_called()')
        self.assertFalse(self.check(configured, imports=imports, source=source, module_source=module_source))

    def test_source_namespace_patch_cannot_borrow_missing_rebound_or_self_module_identity(self):
        source = 'def target(width):\n    return ui.Panel(width)\n'
        imports = 'import unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
        body = 'with patch("sample.ui") as controlled:\n    target(5)\n    controlled.Panel.assert_called_once_with(5)'
        for module_source in (None, 'import widgets as ui\n' + source + '\nui = object()\n', 'import sample as ui\n' + source):
            with self.subTest(module_source=module_source):
                self.assertFalse(self.check(body, imports=imports, source=source, module_source=module_source))

    def test_package_alias_cannot_patch_the_target_class_or_its_members(self):
        for member in ('target', 'other'):
            source = f'def target(self):\n    return package.sample.Worker.{member}()\n'
            module_source = 'import package\nclass Worker:\n' + ''.join('    ' + line + '\n' for line in source.splitlines())
            for target in ('target', 'Worker.target'):
                with self.subTest(member=member, target=target):
                    self.assertEqual(source_namespace_use_points({'module': 'package.sample', 'target': target,
                        'className': 'Worker', 'source': source, 'moduleSource': module_source}), {})

    def test_from_import_member_binding_is_controlled_at_the_application_not_the_provider(self):
        source = 'def target():\n    return clock.now()\n'
        module_source = 'from datetime import datetime as clock\n' + source
        imports = 'import unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
        body = 'with patch("sample.clock") as controlled:\n    target()\n    controlled.now.assert_called_once_with()'
        self.assertTrue(self.check(body, imports=imports, source=source, module_source=module_source))
        self.assertFalse(self.check(body.replace('sample.clock', 'datetime.datetime'), imports=imports,
                                    source=source, module_source=module_source))
        self.assertFalse(self.check(body.replace('controlled.now.assert_called_once_with()', 'controlled.unused.assert_not_called()'),
                                    imports=imports, source=source, module_source=module_source))
        for invalid in (module_source + '\nclock = object()\n', 'from somewhere import *\n' + module_source):
            self.assertFalse(self.check(body, imports=imports, source=source, module_source=invalid))

    def test_from_import_package_alias_cannot_patch_the_selected_owner(self):
        source = 'def target(self):\n    return dep.other()\n'
        module_source = 'from package.sample import Worker as dep\nclass Worker:\n' + ''.join('    ' + line + '\n' for line in source.splitlines())
        self.assertEqual(source_namespace_use_points({'module': 'package.sample', 'target': 'target',
            'className': 'Worker', 'source': source, 'moduleSource': module_source}), {})


if __name__ == '__main__':
    unittest.main()
