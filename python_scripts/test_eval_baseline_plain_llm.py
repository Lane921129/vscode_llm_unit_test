"""The plain-LLM control group counts every outcome and writes a batch eval_aggregate can read."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from eval_aggregate import evaluate_batch_manifest  # noqa: E402
from eval_baseline_plain_llm import PROMPT_HEADER, build_prompt, extract_test_code, function_source, run_baseline  # noqa: E402

MODULE = '''def add(a, b):
    """Return a + b."""
    return a + b


def sub(a, b):
    return a - b


def mul(a, b):
    return a * b


def div(a, b):
    return a / b
'''
EXECUTABLE = '''Here is a test:
```python
import unittest
from calc import add


class TestAdd(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(1, 2), 3)

    def test_negative(self):
        self.assertEqual(add(-1, -2), -3)
```
'''
SYNTAX_ERROR = '```python\nimport unittest\nclass T(unittest.TestCase):\n    def test_x(self)\n        self.assertTrue(True)\n```\n'
NO_METHODS = '```python\nimport unittest\nfrom calc import mul\n\nclass T(unittest.TestCase):\n    pass\n```\n'


class FakeModel:
    def __init__(self):
        self.prompts = []

    def __call__(self, prompt, settings):
        self.prompts.append((prompt, settings))
        if 'def div' in prompt:
            raise ConnectionError('model endpoint unreachable')
        reply = EXECUTABLE if 'def add' in prompt else SYNTAX_ERROR if 'def sub' in prompt else NO_METHODS
        return {'response': reply, 'promptEvalCount': 50, 'evalCount': 30, 'completionReason': 'stop'}


class PlainBaselineTests(unittest.TestCase):
    def test_prompt_is_the_architecture_sentence_plus_the_complete_function(self):
        source = function_source(MODULE, 'add')
        self.assertEqual(source, 'def add(a, b):\n    """Return a + b."""\n    return a + b')
        expected_prompt = f'{PROMPT_HEADER}\n檔案：calc.py\n\n{source}'
        self.assertEqual(build_prompt('calc.py', source), expected_prompt)
        self.assertEqual(build_prompt('/some/path/calc.py', source), expected_prompt)
        self.assertEqual(PROMPT_HEADER, '以下是一個 Python 函式，請為它寫 unittest')
        self.assertIsNone(extract_test_code('I cannot help with that.'))

    def test_mutation_unmeasured_results_in_failed_terminal_status(self):
        """When tests pass and target is called, but mutation score cannot be measured, terminalStatus must be failed."""
        from unittest.mock import patch
        import eval_baseline_plain_llm
        with tempfile.TemporaryDirectory() as directory:
            project = os.path.join(directory, 'project')
            os.mkdir(project)
            with open(os.path.join(project, 'calc.py'), 'w', encoding='utf-8') as handle:
                handle.write(MODULE)
            targets = os.path.join(project, 'targets.json')
            with open(targets, 'w', encoding='utf-8') as handle:
                json.dump({'version': 'test', 'targets': {'calc.py': ['add']}}, handle)
            output = os.path.join(directory, 'baseline')
            model = FakeModel()
            settings = {'model': 'fake-model', 'ollamaUrl': 'http://unused', 'numCtx': 8192, 'localThinkingMode': 'disabled',
                        'mutationEngine': 'builtin', 'mutationStageSeconds': 60, 'mutationWorkers': 1,
                        'requestTimeoutSeconds': 30, 'testTimeoutSeconds': 60, 'python': sys.executable}
            with patch('eval_baseline_plain_llm.measure_mutation', return_value={'score': None, 'reasonCode': 'mutation-unmeasured', 'counts': {}}):
                manifest = run_baseline(settings, targets, output, request_fn=model)

            self.assertEqual(manifest['statusCounts'], {'failed': 1})
            self.assertEqual(manifest['targets'][0]['terminalStatus'], 'failed')
            self.assertEqual(manifest['targets'][0]['reasonCode'], 'mutation-unmeasured')
            add_dir = os.path.join(output, 'calc', 'add')
            with open(os.path.join(add_dir, 'function_knowledge.json'), encoding='utf-8') as handle:
                knowledge = json.load(handle)
            self.assertEqual(knowledge['terminalStatus'], 'failed')
            self.assertEqual(knowledge['reasonCode'], 'mutation-unmeasured')
            self.assertEqual(knowledge['detail'], 'mutation-unmeasured')
            self.assertIsNone(knowledge['mutationScore'])

    def test_four_outcomes_are_counted_and_aggregated_as_a_third_group(self):
        with tempfile.TemporaryDirectory() as directory:
            project = os.path.join(directory, 'project')
            os.mkdir(project)
            with open(os.path.join(project, 'calc.py'), 'w', encoding='utf-8') as handle:
                handle.write(MODULE)
            targets = os.path.join(project, 'targets.json')
            with open(targets, 'w', encoding='utf-8') as handle:
                json.dump({'version': 'test', 'targets': {'calc.py': ['add', 'sub', 'mul', 'div']}}, handle)
            output = os.path.join(directory, 'baseline')
            model = FakeModel()
            settings = {'model': 'fake-model', 'ollamaUrl': 'http://unused', 'numCtx': 8192, 'localThinkingMode': 'disabled',
                        'mutationEngine': 'builtin', 'mutationStageSeconds': 60, 'mutationWorkers': 1,
                        'requestTimeoutSeconds': 30, 'testTimeoutSeconds': 60, 'python': sys.executable}
            manifest = run_baseline(settings, targets, output, request_fn=model)

            self.assertEqual(len(model.prompts), 4, 'one request per target, no revision')
            self.assertTrue(all(prompt.startswith(PROMPT_HEADER + '\n檔案：calc.py\n\ndef ') for prompt, _ in model.prompts))
            self.assertEqual({item['target']: item['reasonCode'] for item in manifest['targets']},
                             {'add': 'usable', 'sub': 'syntax-error', 'mul': 'no-test-methods', 'div': 'model-call-failed'})
            self.assertEqual(manifest['statusCounts'], {'usable': 1, 'failed': 3})
            self.assertEqual((manifest['expectedTargets'], manifest['finishedTargets']), (4, 4), 'failures stay in the denominator')
            self.assertEqual(manifest['settings'], {'model': 'fake-model', 'temperature': 0, 'numCtx': 8192, 'localThinkingMode': 'disabled',
                                                    'mutationEngine': 'builtin', 'prompt': PROMPT_HEADER + ' + 檔案：<檔名>.py + complete function source'})
            self.assertEqual(manifest['cost'], {'modelRequests': 4, 'outputTokens': 90})

            add_dir = os.path.join(output, 'calc', 'add')
            with open(os.path.join(add_dir, 'function_knowledge.json'), encoding='utf-8') as handle:
                knowledge = json.load(handle)
            self.assertEqual(knowledge['terminalStatus'], 'usable')
            self.assertGreater(knowledge['mutationScore'], 0)
            with open(os.path.join(output, 'calc', 'div', 'role_events.jsonl'), encoding='utf-8') as handle:
                statuses = [json.loads(line)['status'] for line in handle]
            self.assertEqual(statuses, ['requested', 'error'])

            summary = evaluate_batch_manifest(os.path.join(output, 'batch_manifest.json'), spec_map={})
            self.assertEqual(summary['method'], 'plain-llm')
            self.assertEqual((summary['retained'], summary['failed'], summary['expectedTargets']), (1, 3, 4))
            self.assertEqual(summary['mutationMeasuredCount'], 1)
            self.assertEqual(summary['modelRequests'], 4)
            self.assertEqual(summary['roleReplySummary']['byRole'], {'plain-llm': {'requested': 4, 'completed': 3, 'error': 1}})
            self.assertTrue(summary['comparable'])



class BaselinePreflightTests(unittest.TestCase):
    def settings(self, python=None, engine='builtin'):
        return {'model': 'fixture', 'python': python or sys.executable, 'mutationEngine': engine}

    def fixture(self, directory):
        targets = os.path.join(directory, 'targets.json')
        with open(targets, 'w', encoding='utf-8') as handle:
            json.dump({'targets': {'calc.py': ['add']}}, handle)
        return targets, os.path.join(directory, 'output')

    def assert_preflight_failure(self, python=None, failed_module=None, engine='builtin'):
        from types import SimpleNamespace
        from unittest.mock import patch
        from eval_baseline_plain_llm import BaselinePreflightError, main
        import io
        from contextlib import redirect_stderr
        with tempfile.TemporaryDirectory() as directory:
            targets, output = self.fixture(directory)
            requested = python or sys.executable
            model = FakeModel()
            def probe(_python, statement):
                return SimpleNamespace(returncode=1 if failed_module and f'import {failed_module}' in statement else 0)
            with patch('eval_baseline_plain_llm._probe_python', side_effect=probe), patch('urllib.request.urlopen') as transport:
                with self.assertRaises(BaselinePreflightError) as caught:
                    run_baseline(self.settings(requested, engine), targets, output, request_fn=model)
                self.assertIn('--python', str(caught.exception))
                self.assertEqual(model.prompts, [])
                self.assertFalse(os.path.exists(output), 'no target folder or manifest may be written')
                errors = io.StringIO()
                with redirect_stderr(errors):
                    code = main(['--targets', targets, '--output', output, '--model', 'fixture',
                                 '--python', requested, '--mutation-engine', engine])
                self.assertNotEqual(code, 0)
                self.assertIn('預檢失敗', errors.getvalue())
                self.assertIn(failed_module or requested, errors.getvalue())
                self.assertFalse(os.path.exists(output))
                transport.assert_not_called()

    def test_missing_interpreter_stops_before_any_model_request_or_manifest(self):
        self.assert_preflight_failure(python=os.path.join(tempfile.gettempdir(), 'pr16-nonexistent-python.exe'))

    def test_missing_coverage_stops_before_any_model_request_or_manifest(self):
        self.assert_preflight_failure(failed_module='coverage')

    def test_missing_mutatest_stops_before_any_model_request_or_manifest(self):
        self.assert_preflight_failure(failed_module='mutatest', engine='mutatest')

    def test_path_preflight_is_windows_only_and_uses_sixty_character_margin(self):
        from eval_baseline_plain_llm import estimate_output_path
        targets = [('validators_utils.py', '_func_args_as_dict')]
        short = estimate_output_path('C:/r/control', targets, platform='win32')
        long = estimate_output_path('C:/' + 'long-output/' * 16, targets, platform='win32')
        self.assertFalse(short['blocked'])
        self.assertEqual(short['temporaryAllowance'], 60)
        self.assertTrue(long['blocked'])
        self.assertGreater(long['estimatedLength'], 250)
        self.assertFalse(estimate_output_path('/' + 'long-output/' * 16, targets, platform='linux')['blocked'])

    def test_executable_without_python_cannot_start(self):
        from unittest.mock import patch
        from eval_baseline_plain_llm import BaselinePreflightError
        with tempfile.TemporaryDirectory() as directory:
            targets, output = self.fixture(directory)
            with patch('eval_baseline_plain_llm._probe_python', side_effect=OSError('not executable')):
                with self.assertRaisesRegex(BaselinePreflightError, '無法正常執行'):
                    run_baseline(self.settings(), targets, output, request_fn=FakeModel())
            self.assertFalse(os.path.exists(output))

    def test_missing_python_setting_uses_current_executable_and_writes_utf8(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import eval_baseline_plain_llm as baseline
        with tempfile.TemporaryDirectory() as directory:
            targets = os.path.join(directory, 'targets.json')
            with open(targets, 'w', encoding='utf-8') as handle:
                json.dump({'targets': {}}, handle)
            output = os.path.join(directory, 'out')
            settings = self.settings()
            del settings['python']
            settings.update(numCtx=8192, localThinkingMode='provider-default')
            with patch.object(baseline, '_probe_python', return_value=SimpleNamespace(returncode=0)) as probe:
                manifest = run_baseline(settings, targets, output, request_fn=FakeModel())
            self.assertTrue(os.path.samefile(probe.call_args_list[0].args[0], sys.executable))
            with open(os.path.join(output, 'batch_manifest.json'), encoding='utf-8') as handle:
                self.assertEqual(json.load(handle), manifest)
            self.assertIn('檔案', manifest['settings']['prompt'])


class ThinkingSettingTests(unittest.TestCase):
    def _body(self, model, mode):
        from unittest.mock import patch, MagicMock
        import eval_baseline_plain_llm as baseline
        captured = {}
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({'response': '', 'done_reason': 'stop'}).encode('utf-8')
        def fake(request, timeout=None):
            captured['body'] = json.loads(request.data.decode('utf-8'))
            return response
        with patch('urllib.request.urlopen', side_effect=fake):
            baseline.ollama_request('p', {'model': model, 'ollamaUrl': 'http://fixture:11434', 'numCtx': 8192,
                                          'localThinkingMode': mode, 'requestTimeoutSeconds': 5})
        return captured['body']

    def test_disabled_thinking_matches_the_extension_rule(self):
        self.assertEqual(self._body('gpt-oss:20b', 'disabled')['think'], 'low')
        self.assertIs(self._body('ministral-3:14b', 'disabled')['think'], False)
        self.assertNotIn('think', self._body('gpt-oss:20b', 'provider-default'))
        self.assertEqual(self._body('gpt-oss:20b', 'disabled')['options']['num_ctx'], 8192)


if __name__ == '__main__':
    unittest.main()
