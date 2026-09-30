import ast
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import basic_mutation_runner as runner


def changes_for(source, target='calculate'):
    tree = ast.parse(source)
    normalized = ast.unparse(tree)
    candidates = runner.mutation_candidates(tree, runner.find_target_scope(tree, target))
    return [(candidate, runner.mutation_code_change(
        normalized, ast.unparse(ast.fix_missing_locations(runner.apply_mutation(tree, index, target)))))
        for index, candidate in enumerate(candidates)]


class MutationCodeChangeTests(unittest.TestCase):
    def test_bmi_division_and_constant_snapshots_use_actual_changed_expressions(self):
        changes = changes_for('def calculate(weight, height):\n    bmi = weight / (height / 100) ** 2\n    return bmi\n')
        divisions = [change for candidate, change in changes if candidate['from'] == 'Div']
        self.assertEqual([change['before'] for change in divisions],
                         ['    bmi = weight / (height / 100) ** 2'] * 2)
        self.assertEqual([change['after'] for change in divisions], [
            '    bmi = weight // (height / 100) ** 2',
            '    bmi = weight / (height // 100) ** 2',
        ])
        constant = next(change for candidate, change in changes if candidate['from'] == '100')
        self.assertEqual(constant, {
            'schemaVersion': 'mutation-code-v1',
            'before': '    bmi = weight / (height / 100) ** 2',
            'after': '    bmi = weight / (height / 0) ** 2',
        })

    def test_identical_constants_are_changed_at_their_own_position(self):
        changes = changes_for('def calculate(value):\n    return (value / 100, 100 / value)\n')
        constants = [(candidate, change) for candidate, change in changes if candidate['from'] == '100']
        self.assertEqual(len(constants), 2)
        self.assertNotEqual(constants[0][0]['column'], constants[1][0]['column'])
        self.assertEqual([change['after'] for _, change in constants], [
            '    return (value / 0, 100 / value)',
            '    return (value / 100, 0 / value)',
        ])

    def test_if_and_return_capture_code_not_operator_labels_or_unrelated_lines(self):
        changes = changes_for('EXCLUDED = "not part of the mutation"\ndef calculate(value):\n'
                              '    if value > 0:\n        return value\n    return 0\n')
        conditional = next(change for candidate, change in changes if candidate['kind'] == 'conditional_negation')
        self.assertEqual(conditional['before'], '    if value > 0:')
        self.assertEqual(conditional['after'], '    if not value > 0:')
        returned = next(change for candidate, change in changes if candidate['kind'] == 'return_value')
        self.assertEqual(returned['before'], '        return value')
        self.assertEqual(returned['after'], '        return None')
        self.assertNotIn('EXCLUDED', json.dumps(changes))

    def test_unicode_quotes_and_display_metacharacters_are_preserved_as_code(self):
        literal = '測試 | <tag> & `tick` "double" \'single\'\nnext'
        source = f'def calculate():\n    return {literal!r}\n'
        change = changes_for(source)[0][1]
        self.assertEqual(change['before'], '    return ' + ast.unparse(ast.Constant(value=literal)))
        self.assertEqual(change['after'], '    return None')
        self.assertEqual(json.loads(json.dumps(change, ensure_ascii=True)), change)

    def test_multiline_input_is_normalized_and_complete_changed_blocks_are_preserved(self):
        change = next(change for candidate, change in changes_for(
            'def calculate(weight, height):\n    result = (weight /\n              (height / 100) ** 2)\n    return result\n')
            if candidate['from'] == '100')
        self.assertEqual(change['before'], '    result = weight / (height / 100) ** 2')
        self.assertEqual(change['after'], '    result = weight / (height / 0) ** 2')
        self.assertEqual(runner.mutation_code_change('unchanged\na\nb\ntail', 'unchanged\nx\ny\ntail'), {
            'schemaVersion': 'mutation-code-v1', 'before': 'a\nb', 'after': 'x\ny',
        })

    def test_oversized_empty_and_disconnected_changes_are_omitted_without_truncation(self):
        limit = runner.CODE_CHANGE_MAX_CHARS
        self.assertIsNotNone(runner.mutation_code_change('a' * limit, 'b' * limit))
        self.assertIsNone(runner.mutation_code_change('a' * (limit + 1), 'b'))
        self.assertIsNone(runner.mutation_code_change('a', 'b' * (limit + 1)))
        self.assertIsNone(runner.mutation_code_change('same', 'same'))
        self.assertIsNone(runner.mutation_code_change('same', 'same\nadded'))
        self.assertIsNone(runner.mutation_code_change('a\nunchanged\nb', 'x\nunchanged\ny'))
        large_context = 'unchanged\n' * 10000
        self.assertEqual(runner.mutation_code_change(large_context + 'a', large_context + 'b')['before'], 'a')

    def test_cli_trial_persists_code_for_actual_mutants_without_changing_identity_or_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'display_target.py'
            test = root / 'test_display_target.py'
            original = 'def calculate(value):\n    return value / 100\n'
            source.write_text(original, encoding='utf-8')
            test.write_text('import unittest\nfrom display_target import calculate\n'
                            'class TestTarget(unittest.TestCase):\n'
                            '    def test_value(self):\n        self.assertEqual(calculate(150), 1.5)\n', encoding='utf-8')
            completed = subprocess.run([sys.executable, str(Path(runner.__file__)), str(source), str(test),
                                        '0', '10', 'calculate'], capture_output=True, text=True,
                                       encoding='utf-8', check=True, timeout=30)
            output = root / 'mutations.json'
            output.write_text(completed.stdout, encoding='utf-8')
            result = json.loads(output.read_text(encoding='utf-8'))
            self.assertTrue(result['baseline_passed'])
            self.assertEqual(result['counts']['executed'], 3)
            self.assertEqual(result['counts']['killed'], 3)
            self.assertTrue(all(m['status'] == 'KILLED' and 'codeChange' in m for m in result['mutants']))
            self.assertEqual(source.read_text(encoding='utf-8'), original)
            self.assertEqual([m['codeChange']['after'] for m in result['mutants']], [
                '    return None', '    return value // 100', '    return value / 0',
            ])
            # Optional display metadata cannot participate in candidate identity
            # or affect trial outcomes, even when no snippet can be captured.
            with patch.object(runner, 'mutation_code_change', return_value=None):
                without_display = runner.run_mutation_trials(source, test, max_mutations=0, target_function='calculate')
            for key in ['counts', 'status', 'candidateSetId', 'candidateIds', 'sourceHash', 'testHash']:
                self.assertEqual(result[key], without_display[key])
            self.assertTrue(all('codeChange' not in m for m in without_display['mutants']))

    def test_not_run_record_keeps_snapshot_without_claiming_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, test = root / 'sample.py', root / 'test_sample.py'
            source.write_text('def calculate():\n    return True\n', encoding='utf-8')
            test.write_text('import unittest\n', encoding='utf-8')
            with patch.object(runner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')), \
                    patch.object(runner.time, 'monotonic', side_effect=[0, 0, 0, 0, 0, 2]):
                result = runner.run_mutation_trials(source, test, target_function='calculate', stage_timeout_seconds=1)
        self.assertEqual(result['counts']['executed'], 0)
        self.assertFalse(result['scoreAvailable'])
        self.assertTrue(all(m['status'] == 'NOT_RUN' and m['codeChange']['before'] == '    return True'
                            for m in result['mutants']))


if __name__ == '__main__':
    unittest.main()
