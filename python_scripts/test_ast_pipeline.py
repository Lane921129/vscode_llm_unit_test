import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).parent
sys.path.insert(0, str(SCRIPTS_DIR))
from mock_scaffold_generator import generate_scaffold
from dynamic_tracer import trace_function
from basic_mutation_runner import run_mutation_trials


class AstPipelineTests(unittest.TestCase):
    def run_script(self, script_name, *args):
        completed = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / script_name), *map(str, args)],
            check=True,
            capture_output=True,
            encoding='utf-8'
        )
        return json.loads(completed.stdout)

    def test_extractor_includes_context_needed_for_a_class_method(self):
        source = '''import os as operating_system
from helpers import normalize as normalize_value

MAXIMUM = 10

class Worker:
    DEFAULT = "ready"

    def __init__(self, config, client=None):
        self.config = config
        self.client = client

    def process(self, value):
        if value > MAXIMUM:
            return operating_system.path.exists(self.config) and normalize_value(value)
        return self.DEFAULT
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'process')

        self.assertEqual(data['class_name'], 'Worker')
        self.assertIn('operating_system.path.exists', data['calls'])
        self.assertIn('normalize_value', data['calls'])
        self.assertEqual(data['referenced_globals'], [{'name': 'MAXIMUM', 'code': 'MAXIMUM = 10'}])
        self.assertEqual(data['class_context']['init']['params'], ['config', 'client'])
        self.assertEqual(data['class_context']['init']['required_params'], ['config'])
        self.assertEqual(data['class_context']['init']['optional_params'], ['client'])
        self.assertEqual([item['name'] for item in data['class_context']['init']['assigns']], ['config', 'client'])
        self.assertEqual({item['bound_name'] for item in data['file_imports']}, {'operating_system', 'normalize_value'})

    def test_caller_finder_ignores_a_same_named_local_function(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'core.py'
            target.write_text('def validate(value):\n    return value\n', encoding='utf-8')
            (root / 'consumer.py').write_text(
                'from core import validate as core_validate\n\ndef invoke():\n    return core_validate(1)\n',
                encoding='utf-8'
            )
            (root / 'collision.py').write_text(
                'def validate(value):\n    return value + 1\n\ndef invoke():\n    return validate(2)\n',
                encoding='utf-8'
            )
            (root / 'variable_consumer.py').write_text(
                'from core import validate\n\ndef invoke(value):\n    return validate(value)\n',
                encoding='utf-8'
            )
            calls = self.run_script('ast_caller_finder.py', 'validate', root, target)

        by_file = {call['caller_file']: call for call in calls}
        self.assertEqual(set(by_file), {'consumer.py', 'variable_consumer.py'})
        self.assertEqual(by_file['consumer.py']['call_expr'], 'core_validate(1)')
        self.assertEqual(by_file['consumer.py']['trace_args'], [1])
        self.assertEqual(by_file['consumer.py']['trace_kwargs'], {})
        self.assertIsNone(by_file['variable_consumer.py']['trace_args'])
        self.assertIsNone(by_file['variable_consumer.py']['trace_kwargs'])

    def test_extractor_preserves_required_defaults_and_keyword_only_parameters(self):
        source = '''def combine(left, /, middle, right=3, *, flag=True, required_option, **extras):
    return left + middle + right
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'sample.py'
            target.write_text(source, encoding='utf-8')
            data = self.run_script('ast_extractor.py', target, 'combine')

        self.assertEqual(data['required_args'], ['left', 'middle', 'required_option'])
        self.assertEqual(
            [(item['name'], item['kind'], item['default'], item['required']) for item in data['signature']],
            [
                ('left', 'positional_only', None, True),
                ('middle', 'positional_or_keyword', None, True),
                ('right', 'positional_or_keyword', '3', False),
                ('flag', 'keyword_only', 'True', False),
                ('required_option', 'keyword_only', None, True),
                ('extras', 'var_keyword', None, False),
            ]
        )

    def test_mock_scaffold_patches_the_target_module_usage_point_and_supports_async_methods(self):
        source = '''import transport_lib as transport
from helpers import normalize as normalize_value

class Worker:
    def __init__(self, config):
        self.config = config

    async def process(self, value):
        response = transport.send(value)
        return await normalize_value(response)
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            result = generate_scaffold(str(target), 'process')

        self.assertEqual(result['patches'], ['worker.transport.send', 'worker.normalize_value'])
        self.assertEqual(result['mock_names'], ['mock_send', 'mock_normalize_value'])
        self.assertTrue(result['is_async'])
        self.assertEqual(result['class_name'], 'Worker')
        self.assertIn("@patch('worker.normalize_value')\n@patch('worker.transport.send')", result['scaffold'])
        self.assertIn('async def test_process(self, mock_send, mock_normalize_value):', result['scaffold'])
        self.assertIn('instance = Worker(...)', result['scaffold'])
        self.assertIn('result = await instance.process(value)', result['scaffold'])

    def test_dynamic_tracer_awaits_async_target_before_recording_the_result(self):
        source = '''async def double(value):
    return value * 2
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'async_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'double', [{'args': [3], 'kwargs': {}}])

        self.assertIsNone(result['load_error'])
        self.assertEqual(result['examples'], [
            {'args': ['3'], 'result': '6', 'result_type': 'int'}
        ])

    def test_dynamic_tracer_does_not_treat_an_uninitialized_class_as_a_real_trace(self):
        source = '''class Worker:
    def __init__(self, prefix):
        self.prefix = prefix

    def render(self, value):
        return self.prefix + value
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'worker.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'render', [{'args': ['x'], 'kwargs': {}}])

        self.assertIn('Cannot safely instantiate class', result['load_error'])
        self.assertEqual(result['examples'], [])
        self.assertEqual(result['errors'], [])

    def test_dynamic_tracer_preserves_required_keyword_only_arguments(self):
        source = '''def multiply(value: int, *, factor: int):
    return value * factor
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'keyword_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'multiply', [{'args': [3], 'kwargs': {'factor': 2}}])

        self.assertIsNone(result['load_error'])
        self.assertEqual(result['examples'], [{
            'args': ['3'], 'kwargs': {'factor': '2'}, 'result': '6', 'result_type': 'int'
        }])

    def test_dynamic_tracer_reaches_scalar_branches_from_source_conditions(self):
        source = '''def route(value: str, mode: str):
    if not value or len(value) < 4:
        raise ValueError("value is too short")
    if mode == "first":
        return "first-route"
    if mode == "second":
        return "second-route"
    return "default-route"
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            target = pathlib.Path(temp_dir) / 'route_target.py'
            target.write_text(source, encoding='utf-8')
            result = trace_function(str(target), 'route')

        self.assertIsNone(result['load_error'])
        self.assertIn(
            {'args': ["'test_value'", "'first'"], 'result': "'first-route'", 'result_type': 'str'},
            result['examples']
        )
        self.assertIn(
            {'args': ["'test_value'", "'second'"], 'result': "'second-route'", 'result_type': 'str'},
            result['examples']
        )
        self.assertTrue(any(error['exception'] == 'ValueError' for error in result['errors']))

    def test_builtin_mutation_runner_kills_a_boundary_mutation_without_changing_source(self):
        source = '''def classify(value):
    return "positive" if value > 0 else "not-positive"
'''
        test_source = '''import unittest
from target import classify

class TestClassify(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(classify(1), "positive")

    def test_boundary(self):
        self.assertEqual(classify(0), "not-positive")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'target.py'
            test_file = root / 'test_target.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(target, test_file)
            original_source = target.read_text(encoding='utf-8')

        self.assertEqual(original_source, source)
        self.assertGreaterEqual(result['total'], 1)
        self.assertGreaterEqual(result['killed'], 1)
        self.assertEqual(result['survived'], 0)

    def test_builtin_mutation_runner_mutates_boolean_operators(self):
        source = '''def both_enabled(left, right):
    return "enabled" if left and right else "disabled"
'''
        test_source = '''import unittest
from target import both_enabled

class TestBothEnabled(unittest.TestCase):
    def test_both_enabled(self):
        self.assertEqual(both_enabled(True, True), "enabled")

    def test_one_disabled(self):
        self.assertEqual(both_enabled(True, False), "disabled")
'''
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            target = root / 'target.py'
            test_file = root / 'test_target.py'
            target.write_text(source, encoding='utf-8')
            test_file.write_text(test_source, encoding='utf-8')
            result = run_mutation_trials(target, test_file)

        boolean_mutants = [mutant for mutant in result['mutants'] if mutant['kind'] == 'boolean_operator']
        self.assertEqual(len(boolean_mutants), 1)
        self.assertEqual(boolean_mutants[0]['status'], 'KILLED')


if __name__ == '__main__':
    unittest.main()
