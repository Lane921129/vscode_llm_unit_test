"""Method-local imports preserve exact target identity without borrowing scopes."""
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


CONTEXT = {'module': 'subject', 'target': 'compute', 'source': 'def compute():\n    return 7',
           'dependencies': {}, 'requireTargetBehavior': True}


def candidate(body, extra='', parameters='self'):
    return ('import unittest\n' + extra + '\nclass Cases(unittest.TestCase):\n'
            + f'    def test_compute({parameters}):\n'
            + '\n'.join('        ' + line for line in body.splitlines()) + '\n')


class LocalTargetImportTests(unittest.TestCase):
    def proven(self, code):
        return has_target_result_assertion(ast.parse(code), CONTEXT)

    def test_direct_local_import_alias_and_qualified_module_are_observed(self):
        bodies = [
            'from subject import compute\nactual = compute()\nself.assertEqual(actual, 7)',
            'from subject import compute as operation\nself.assertEqual(operation(), 7)',
            'import subject as application\nself.assertEqual(application.compute(), 7)',
        ]
        for body in bodies:
            with self.subTest(body=body):
                code = candidate(body)
                self.assertTrue(self.proven(code))
                self.assertTrue(validate_bindings(code, CONTEXT)['valid'])

    def test_wrong_namespace_is_not_selected_target(self):
        code = candidate('from other import compute\nself.assertEqual(compute(), 7)')
        self.assertFalse(self.proven(code))
        self.assertFalse(validate_bindings(code, CONTEXT)['valid'])

    def test_local_rebinding_argument_and_definition_revoke_import_identity(self):
        for body, extra, parameters in [
            ('from subject import compute\ncompute = lambda: 7\nself.assertEqual(compute(), 7)', '', 'self'),
            ('self.assertEqual(compute(), 7)', 'from subject import compute\n', 'self, compute'),
            ('def compute():\n    return 7\nself.assertEqual(compute(), 7)', 'from subject import compute\n', 'self'),
        ]:
            with self.subTest(body=body):
                self.assertFalse(self.proven(candidate(body, extra, parameters)))

    def test_later_import_does_not_make_earlier_call_a_global_target(self):
        code = candidate('self.assertEqual(compute(), 7)\nfrom subject import compute', 'from subject import compute\n')
        self.assertFalse(self.proven(code))
        self.assertFalse(validate_bindings(code, CONTEXT)['valid'])

    def test_conditional_or_loop_import_does_not_escape_its_unknown_branch(self):
        for branch in ('if flag:\n    from subject import compute', 'for item in []:\n    from subject import compute'):
            with self.subTest(branch=branch):
                self.assertFalse(self.proven(candidate(branch + '\nself.assertEqual(compute(), 7)')))

    def test_import_is_not_borrowed_from_another_test_or_setup(self):
        first = candidate('from subject import compute\ncompute()')
        code = first + '    def test_other(self):\n        self.assertEqual(compute(), 7)\n'
        self.assertFalse(self.proven(code))
        setup = ('import unittest\nclass Cases(unittest.TestCase):\n'
                 '    def setUp(self):\n        from subject import compute\n'
                 '    def test_compute(self):\n        self.assertEqual(compute(), 7)\n')
        self.assertFalse(self.proven(setup))

    def test_relative_and_wildcard_imports_do_not_invent_canonical_identity(self):
        for statement in ('from .subject import compute', 'from subject import *'):
            with self.subTest(statement=statement):
                self.assertFalse(self.proven(candidate(statement + '\nself.assertEqual(compute(), 7)')))

    def test_locally_imported_target_runs_as_a_real_unittest(self):
        code = candidate('from subject import compute\nactual = compute()\nself.assertEqual(actual, 7)')
        self.assertTrue(validate_bindings(code, CONTEXT)['valid'])
        with tempfile.TemporaryDirectory(prefix='local-target-import-') as directory:
            Path(directory, 'subject.py').write_text(CONTEXT['source'], encoding='utf-8')
            Path(directory, 'candidate_test.py').write_text(code, encoding='utf-8')
            result = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'candidate_test'], cwd=directory,
                                    capture_output=True, text=True, timeout=10, env={**os.environ, 'PYTHONPATH': ''})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Ran 1 test', result.stderr)


if __name__ == '__main__':
    unittest.main()
