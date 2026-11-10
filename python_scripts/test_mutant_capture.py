import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from basic_mutation_runner import get_mutant_source, dual_capture_mutant


class TestMutantCapture(unittest.TestCase):
    def setUp(self):
        self.source_path = str(ROOT / 'examples' / 'bmi' / 'src' / 'bmi.py')
        self.runner_path = str(ROOT / 'python_scripts' / 'basic_mutation_runner.py')

    def test_get_mutant_source_by_line_and_operators(self):
        source, record = get_mutant_source(
            self.source_path,
            target_function='calculate_bmi',
            line=21,
            from_val='Div',
            to_val='Add'
        )
        self.assertIn('def calculate_bmi', source)
        self.assertEqual(record['line'], 21)
        self.assertEqual(record['from'], 'Div')
        self.assertEqual(record['to'], 'Add')
        self.assertTrue(bool(record['id']))

    def test_get_mutant_source_by_id(self):
        source1, record1 = get_mutant_source(
            self.source_path,
            target_function='calculate_bmi',
            line=21,
            from_val='Div',
            to_val='Add'
        )
        source2, record2 = get_mutant_source(
            self.source_path,
            target_function='calculate_bmi',
            mutant_id=record1['id']
        )
        self.assertEqual(record1['id'], record2['id'])
        self.assertEqual(source1, source2)

    def test_dual_capture_distinguishable(self):
        request = {
            'version': 'case-mutant-capture-request-v1',
            'file': self.source_path,
            'target': 'calculate_bmi',
            'row': {'id': 'C1', 'args': '(70, 175)', 'kwargs': '{}', 'mocks': []},
            'dependencies': [],
            'importPaths': [str(Path(self.source_path).parent)],
            'mutant': {'line': 21, 'from': 'Div', 'to': 'Add'},
            'operatorVersion': 'builtin-ast-v3'
        }
        result = dual_capture_mutant(request)
        self.assertEqual(result['version'], 'case-mutant-capture-v1')
        self.assertEqual(result['status'], 'distinguishable')
        self.assertTrue(result['distinguishable'])
        self.assertEqual(result['clean']['status'], 'captured')
        self.assertEqual(result['mutant']['status'], 'captured')
        self.assertNotEqual(result['clean']['actual'], result['mutant']['actual'])

    def test_dual_capture_indistinguishable(self):
        request = {
            'version': 'case-mutant-capture-request-v1',
            'file': self.source_path,
            'target': 'calculate_bmi',
            'row': {'id': 'C2', 'args': '(70, 0)', 'kwargs': '{}', 'mocks': []},
            'dependencies': [],
            'importPaths': [str(Path(self.source_path).parent)],
            'mutant': {'line': 21, 'from': 'Div', 'to': 'Add'},
            'operatorVersion': 'builtin-ast-v3'
        }
        result = dual_capture_mutant(request)
        self.assertEqual(result['version'], 'case-mutant-capture-v1')
        self.assertEqual(result['status'], 'indistinguishable')
        self.assertFalse(result['distinguishable'])
        self.assertEqual(result['reason'], 'survivor-row-indistinguishable')
        self.assertEqual(result['clean']['actual'], result['mutant']['actual'])

    def test_cli_capture_mutant_flag(self):
        request = {
            'version': 'case-mutant-capture-request-v1',
            'file': self.source_path,
            'target': 'calculate_bmi',
            'row': {'id': 'C3', 'args': '(70, 175)', 'kwargs': '{}', 'mocks': []},
            'dependencies': [],
            'importPaths': [str(Path(self.source_path).parent)],
            'mutant': {'line': 21, 'from': 'Div', 'to': 'Add'},
            'operatorVersion': 'builtin-ast-v3'
        }
        proc = subprocess.run(
            [sys.executable, '-B', '-X', 'utf8', self.runner_path, '--capture-mutant'],
            input=json.dumps(request),
            capture_output=True,
            text=True
        )
        self.assertEqual(proc.returncode, 0)
        output = json.loads(proc.stdout)
        self.assertEqual(output['status'], 'distinguishable')
        self.assertTrue(output['distinguishable'])


if __name__ == '__main__':
    unittest.main()
