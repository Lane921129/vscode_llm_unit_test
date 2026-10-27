"""AST composition contracts; submitted fixtures are never imported."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from edit_test_methods import apply, plan, LIMIT


BASE = '''# 原始模組註解
import unittest

class First(unittest.TestCase):
    def setUp(self):
        self.value = "fixture stays exact"

    def test_same(self):
        # this complete method stays untouched
        self.assertEqual(self.value, "fixture stays exact")

class Second(unittest.TestCase):
    def setUp(self):
        self.value = "另一個 fixture"

    def test_same(self):
        self.assertEqual((1, "值"), (1, "值"))

    def test_other(self):
        self.assertTrue(True)

# 原始結尾註解
'''


class MethodEdits(unittest.TestCase):
    def line(self, code=BASE, text='self.assertEqual((1, "值")'):
        return next(index for index, line in enumerate(code.splitlines(), 1) if text in line)

    def apply(self, response, code=BASE, lines=None, **overrides):
        lines = lines or [self.line(code)]
        current = plan(code, lines)
        self.assertTrue(current['ok'], current)
        return apply(overrides.get('baseline', code), lines, overrides.get('baseline_hash', current['baselineHash']),
                     overrides.get('plan_hash', current['planHash']), response)

    def replacement(self, name='test_same', owner='Second'):
        return f'class {owner}:\n    def {name}(self):\n        self.assertTupleEqual((1, "值"), (1, "值"))\n'

    def test_plan_binds_exact_utf8_source_and_class_identity(self):
        current = plan(BASE, [self.line()])
        self.assertTrue(current['ok'], current)
        self.assertEqual(current['baselineHash'], hashlib.sha256(BASE.encode()).hexdigest())
        method = current['methods'][0]
        self.assertEqual(method['id'], 'Second.test_same')
        self.assertEqual(BASE.encode()[method['startByte']:method['endByte']].decode(), method['code'])
        self.assertEqual(current, plan(BASE, [self.line(), self.line()]))

    def test_multiple_classes_keep_fixtures_and_every_outside_byte(self):
        result = self.apply(self.replacement())
        self.assertTrue(result['ok'], result)
        selected = plan(BASE, [self.line()])['methods'][0]
        self.assertTrue(result['mergedCode'].encode().startswith(BASE.encode()[:selected['startByte']]))
        self.assertTrue(result['mergedCode'].encode().endswith(BASE.encode()[selected['endByte']:]))
        self.assertIn('# this complete method stays untouched', result['mergedCode'])
        self.assertEqual(result['changedMethodIds'], ['Second.test_same'])
        self.assertEqual(result['mergedHash'], hashlib.sha256(result['mergedCode'].encode()).hexdigest())

    def test_crlf_unicode_and_multiline_literal_values_survive(self):
        code = BASE.replace('\n', '\r\n')
        response = 'def test_same(self):\n    value = """起點\n    keep indentation\n終點"""\n    self.assertEqual(value, "起點\\n    keep indentation\\n終點")'
        result = self.apply(response, code)
        self.assertTrue(result['ok'], result)
        self.assertIn('# 原始模組註解\r\n', result['mergedCode'])
        self.assertIn('# 原始結尾註解\r\n', result['mergedCode'])
        literal = next(node.value for node in ast.walk(ast.parse(result['mergedCode']))
                       if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'value')
        self.assertEqual(literal.value, '起點\n    keep indentation\n終點')

    def test_multiple_selected_methods_require_complete_response(self):
        lines = [self.line(), self.line(text='self.assertTrue(True)')]
        missing = self.apply(self.replacement(), lines=lines)
        self.assertEqual(missing['reasonCode'], 'edit-method-missing')
        response = self.replacement() + '\n    def test_other(self):\n        self.assertIs(True, True)\n'
        result = self.apply(response, lines=lines)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['changedMethodIds'], ['Second.test_same', 'Second.test_other'])

    def test_same_names_across_classes_need_explicit_owners(self):
        lines = [self.line(text='# this complete method'), self.line()]
        result = self.apply('def test_same(self):\n    self.assertTrue(True)', lines=lines)
        self.assertEqual(result['reasonCode'], 'unsupported-edit-response')
        result = self.apply(self.replacement(owner='First') + '\n' + self.replacement(), lines=lines)
        self.assertTrue(result['ok'], result)

    def test_indented_bare_method_preserves_string_contents(self):
        result = self.apply('    def test_same(self):\n        self.assertTupleEqual((1, "值"), (1, "值"))\n')
        self.assertTrue(result['ok'], result)

    def test_signature_and_decorator_changes_are_rejected(self):
        for response in [self.replacement().replace('(self)', '(self, value=1)'),
                         self.replacement().replace('def test_same', 'async def test_same'),
                         self.replacement().replace('    def test_same', '    @unittest.skip("unsafe")\n    def test_same')]:
            with self.subTest(response=response):
                self.assertEqual(self.apply(response)['reasonCode'], 'edit-signature-changed')

    def test_existing_decorator_is_preserved_not_reinterpreted(self):
        code = BASE.replace('    def test_other(self):', '    @some_existing_decorator\n    def test_other(self):')
        response = '@some_existing_decorator\ndef test_other(self):\n    self.assertIs(True, True)'
        result = self.apply(response, code, [self.line(code, 'def test_other')])
        self.assertTrue(result['ok'], result)
        self.assertIn('@some_existing_decorator', result['mergedCode'])

    def test_async_signature_and_annotations_remain_locked(self):
        code = BASE.replace('    def test_same(self):\n        self.assertEqual((1, "值")',
                            '    async def test_same(self) -> None:\n        self.assertEqual((1, "值")')
        response = 'async def test_same(self) -> None:\n    self.assertTupleEqual((1, "值"), (1, "值"))'
        self.assertTrue(self.apply(response, code)['ok'])
        self.assertEqual(self.apply(response.replace(' -> None', ''), code)['reasonCode'], 'edit-signature-changed')

    def test_module_imports_fixtures_helpers_and_new_methods_cannot_escape_scope(self):
        for response in [BASE, 'import unittest\n' + self.replacement(),
                         self.replacement() + '\n    def setUp(self):\n        self.value = 999',
                         self.replacement() + '\n    def test_new(self):\n        self.assertTrue(True)',
                         self.replacement() + '\nraise RuntimeError("not executed")',
                         self.replacement().replace('class Second:', 'class Other:'),
                         self.replacement().replace('class Second:', 'class Second(evil()):')]:
            with self.subTest(response=response):
                self.assertFalse(self.apply(response)['ok'])

    def test_duplicate_methods_are_not_silently_overwritten(self):
        result = self.apply(self.replacement() + '\n' + self.replacement())
        self.assertEqual(result['reasonCode'], 'duplicate-edit-method')
        for code in [BASE + '\n' + BASE, BASE.replace('    def test_other(self):', '    def test_same(self):'),
                     BASE.replace('class Second(unittest.TestCase):', 'class Second(unittest.TestCase):\n    test_same = None')]:
            self.assertEqual(plan(code, [self.line(code)])['reasonCode'], 'ambiguous-edit-baseline')

    def test_stale_baseline_or_plan_hash_never_applies(self):
        for arguments in [{'baseline': BASE + '# drift'}, {'baseline_hash': '0' * 64}, {'plan_hash': '0' * 64}]:
            self.assertEqual(self.apply(self.replacement(), **arguments)['reasonCode'], 'stale-edit-plan')

    def test_noop_is_not_counted_as_a_method_change(self):
        response = 'def test_same(self):\n    self.assertEqual((1, "值"), (1, "值"))'
        self.assertEqual(self.apply(response)['reasonCode'], 'edit-no-method-change')

    def test_only_actual_test_method_lines_are_plannable(self):
        for lines in [[], [True], [0], [-1], [1], [999], [self.line(text='class Second')],
                      [self.line(text='self.value = "另一個 fixture"')], [self.line()] * 33]:
            with self.subTest(lines=lines):
                self.assertFalse(plan(BASE, lines)['ok'])

    def test_parser_limits_and_failures_have_source_free_reasons(self):
        for code in ['def broken(:\n PRIVATE_SOURCE', BASE + '#' * LIMIT, None]:
            result = plan(code, [1])
            self.assertFalse(result['ok'])
            self.assertNotIn('PRIVATE_SOURCE', json.dumps(result))

    def test_submitted_module_expressions_are_never_executed(self):
        with tempfile.TemporaryDirectory() as root:
            marker = Path(root) / 'must-not-exist.txt'
            code = BASE + '\n__import__("pathlib").Path(' + repr(str(marker)) + ').write_text("executed")\n'
            result = self.apply(self.replacement(), code)
            self.assertTrue(result['ok'], result)
            self.assertFalse(marker.exists())

    def test_cli_rejects_unknown_fields_and_invalid_encoding_without_echo(self):
        script = Path(__file__).with_name('edit_test_methods.py')
        for payload in [b'\xffPRIVATE_SOURCE', b'[]', b'{"mode":"plan","baseline":"PRIVATE_SOURCE","lineRefs":[1],"oracle":1}']:
            run = subprocess.run([sys.executable, '-B', str(script)], input=payload, capture_output=True, check=True)
            result = json.loads(run.stdout)
            self.assertFalse(result['ok'])
            self.assertNotIn('PRIVATE_SOURCE', run.stdout.decode())


if __name__ == '__main__':
    unittest.main()
