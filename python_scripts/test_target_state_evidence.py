"""Source-bound state observations never manufacture expected values."""
import ast
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from target_result_evidence import has_target_result_assertion
from validate_test_bindings import validate_bindings


SOURCE = 'def reset(obj):\n    obj.items = []'
CONTEXT = {'module': 'subject', 'target': 'reset', 'source': SOURCE, 'dependencies': {}, 'requireTargetBehavior': True}


def candidate(body, imports='from types import SimpleNamespace', extra=''):
    return ('import unittest\nfrom subject import reset\n' + imports + '\n' + extra
            + '\nclass Cases(unittest.TestCase):\n    def test_reset(self):\n'
            + '\n'.join('        ' + line for line in body.splitlines()) + '\n')


class TargetStateEvidenceTests(unittest.TestCase):
    def proven(self, code, context=None):
        return has_target_result_assertion(ast.parse(code), context or CONTEXT)

    def test_fresh_namespace_state_after_real_target_is_observable(self):
        code = candidate('obj = SimpleNamespace(items=[1])\nreset(obj)\nself.assertEqual(obj.items, [])')
        self.assertTrue(self.proven(code))
        self.assertTrue(validate_bindings(code, CONTEXT)['valid'])

    def test_explicit_qualified_and_local_factory_import_aliases_are_supported(self):
        for imports, construction in [('import types as objects', 'objects.SimpleNamespace'),
                                      ('from types import SimpleNamespace as State', 'State'),
                                      ('', 'SimpleNamespace')]:
            local = 'from types import SimpleNamespace\n' if not imports else ''
            code = candidate(local + f'obj = {construction}(items=[1])\nreset(obj)\nself.assertEqual(obj.items, [])', imports)
            with self.subTest(imports=imports):
                self.assertTrue(self.proven(code))

    def test_keyword_and_positional_only_bindings_use_the_exact_parameter(self):
        for source, call in [('def reset(*, obj):\n    obj.items = []', 'reset(obj=obj)'),
                             ('def reset(obj, /):\n    obj.items = []', 'reset(obj)')]:
            with self.subTest(source=source):
                self.assertTrue(self.proven(candidate('obj = SimpleNamespace(items=[1])\n' + call
                                                     + '\nself.assertEqual(obj.items, [])'), {**CONTEXT, 'source': source}))

    def test_scalar_return_does_not_authorize_unwritten_input_state(self):
        code = candidate('obj = SimpleNamespace(items=[])\nreset(obj)\nself.assertEqual(obj.items, [])')
        self.assertFalse(self.proven(code, {**CONTEXT, 'source': 'def reset(obj):\n    return None'}))

    def test_no_call_before_call_wrong_object_and_wrong_attribute_are_rejected(self):
        bodies = [
            'obj = SimpleNamespace(items=[])\nself.assertEqual(obj.items, [])',
            'obj = SimpleNamespace(items=[])\nself.assertEqual(obj.items, [])\nreset(obj)',
            'obj = SimpleNamespace(items=[])\nother = SimpleNamespace(items=[1])\nreset(other)\nself.assertEqual(obj.items, [])',
            'obj = SimpleNamespace(items=[1], other=[])\nreset(obj)\nself.assertEqual(obj.other, [])',
        ]
        for body in bodies:
            with self.subTest(body=body):
                self.assertFalse(self.proven(candidate(body)))

    def test_rebinding_overwrite_delete_augmented_write_and_item_write_revoke_state(self):
        changes = ['obj = SimpleNamespace(items=[])', 'obj.items = []', 'del obj.items', 'obj.items += []',
                   'obj.items[0] = 1']
        for change in changes:
            with self.subTest(change=change):
                self.assertFalse(self.proven(candidate('obj = SimpleNamespace(items=[1])\nreset(obj)\n'
                                                      + change + '\nself.assertEqual(obj.items, [])')))

    def test_mock_ellipsis_custom_factory_and_shared_alias_are_not_fresh_namespace_inputs(self):
        for setup, imports in [('obj = Mock(items=[])', 'from unittest.mock import Mock'),
                               ('obj = ...', ''), ('obj = object()', ''),
                               ('obj = Factory(items=[])', 'from other import SimpleNamespace as Factory'),
                               ('obj = SimpleNamespace(items=[1])\nother = obj', 'from types import SimpleNamespace')]:
            with self.subTest(setup=setup):
                self.assertFalse(self.proven(candidate(setup + '\nreset(obj)\nself.assertEqual(obj.items, [])', imports)))

    def test_manual_mutator_and_unknown_helper_calls_revoke_state(self):
        for mutation in ('obj.items.clear()', 'tamper(obj)', 'unknown()', 'type(obj).items = []'):
            with self.subTest(mutation=mutation):
                self.assertFalse(self.proven(candidate('obj = SimpleNamespace(items=[1])\nreset(obj)\n'
                                                      + mutation + '\nself.assertEqual(obj.items, [])')))

    def test_rebound_or_patched_factory_and_shadowed_builtin_never_authorize_namespace(self):
        for extra, body in [
            ('SimpleNamespace = object\n', 'obj = SimpleNamespace(items=[1])'),
            ('import types\ntypes.SimpleNamespace = object\n', 'obj = types.SimpleNamespace(items=[1])'),
            ('def list(value):\n    return value\n', 'obj = SimpleNamespace(items=[1])\nlist([])'),
            ('from unittest.mock import patch\n', "patch('types.SimpleNamespace', object).start()\nobj = SimpleNamespace(items=[1])"),
        ]:
            with self.subTest(extra=extra):
                self.assertFalse(self.proven(candidate(body + '\nreset(obj)\nself.assertEqual(obj.items, [])', extra=extra)))

    def test_conditional_source_or_conditional_test_call_never_grants_outer_state(self):
        code = candidate('obj = SimpleNamespace(items=[1])\nreset(obj)\nself.assertEqual(obj.items, [])')
        source = 'def reset(obj):\n    if obj.items:\n        obj.items = []'
        self.assertFalse(self.proven(code, {**CONTEXT, 'source': source}))
        branch = candidate('obj = SimpleNamespace(items=[1])\nif flag:\n    reset(obj)\nself.assertEqual(obj.items, [])')
        self.assertFalse(self.proven(branch))

    def test_source_rebinding_unreachable_write_duplicate_definition_and_owner_are_unknown(self):
        code = candidate('obj = SimpleNamespace(items=[1])\nreset(obj)\nself.assertEqual(obj.items, [])')
        for source in ['def reset(obj):\n    obj = None\n    obj.items = []',
                       'def reset(obj):\n    return\n    obj.items = []',
                       SOURCE + '\n' + SOURCE,
                       '@decorator\n' + SOURCE]:
            with self.subTest(source=source):
                self.assertFalse(self.proven(code, {**CONTEXT, 'source': source}))
        self.assertFalse(self.proven(code, {**CONTEXT, 'className': 'Owner'}))

    def test_state_captured_before_a_later_mutation_is_still_a_real_observation(self):
        code = candidate('obj = SimpleNamespace(items=[1])\nreset(obj)\nobserved = obj.items\n'
                         'obj.items = [9]\nself.assertEqual(observed, [])')
        self.assertTrue(self.proven(code))

    def test_target_patch_still_fails_the_existing_binding_gate(self):
        code = candidate("obj = SimpleNamespace(items=[1])\nwith patch('subject.reset'):\n    reset(obj)\nself.assertEqual(obj.items, [])",
                         'from types import SimpleNamespace\nfrom unittest.mock import patch')
        self.assertFalse(validate_bindings(code, CONTEXT)['valid'])

    def test_static_relevance_is_not_an_expected_answer_or_execution_success(self):
        valid = candidate('obj = SimpleNamespace(items=[1])\nreset(obj)\nself.assertEqual(obj.items, [])')
        wrong = valid.replace('self.assertEqual(obj.items, [])', 'self.assertEqual(obj.items, [9])')
        self.assertTrue(self.proven(valid))
        self.assertTrue(self.proven(wrong), 'The AST proves relevant state, not the expected value.')
        with tempfile.TemporaryDirectory(prefix='target-state-evidence-') as directory:
            Path(directory, 'subject.py').write_text(SOURCE, encoding='utf-8')
            for name, code, status in [('valid_case', valid, 0), ('wrong_case', wrong, 1)]:
                Path(directory, name + '.py').write_text(code, encoding='utf-8')
                result = subprocess.run([sys.executable, '-B', '-m', 'unittest', name], cwd=directory,
                                        capture_output=True, text=True, timeout=10, env={**os.environ, 'PYTHONPATH': ''})
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertIn('Ran 1 test', result.stderr)


if __name__ == '__main__':
    unittest.main()
