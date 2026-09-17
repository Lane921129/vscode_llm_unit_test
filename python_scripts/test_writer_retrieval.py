import ast
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ast_extractor import extract_info, retrieve_local_helpers
from validate_test_bindings import validate_bindings


class WriterRetrievalTests(unittest.TestCase):
    def retrieve(self, source, **limits):
        tree = ast.parse(source)
        target = next(node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                      and node.name == 'target')
        return retrieve_local_helpers(tree, target, source.split('\n'), **limits)

    def test_retrieval_follows_real_symbols_with_complete_source_and_hashes(self):
        source = 'LIMIT = 3\ndef leaf(x):\n    return x + LIMIT\ndef helper(x):\n    return leaf(x)\ndef target(x):\n    return helper(x)\n'
        contexts, report = self.retrieve(source)
        self.assertEqual([item['name'] for item in contexts], ['helper', 'leaf'])
        self.assertEqual(contexts[1]['referenced_globals'], [{'name': 'LIMIT', 'code': 'LIMIT = 3'}])
        self.assertEqual(len(contexts[0]['sourceHash']), 64)
        self.assertNotIn('traceResult', contexts[0])
        self.assertEqual(report['selected'], 2)
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder, 'fixture.py')
            target.write_text(source, encoding='utf-8')
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                extract_info(str(target), 'target')
            result = json.loads(captured.getvalue())
            self.assertEqual(result['localDependencyContexts'], contexts)
        changed, _ = self.retrieve(source.replace('return x + LIMIT', 'return x - LIMIT'))
        self.assertNotEqual(changed[1]['sourceHash'], contexts[1]['sourceHash'])

    def test_retrieval_rejects_shadowing_rebinding_decorators_and_dynamic_calls(self):
        helper = 'def helper(x):\n    return x\n'
        cases = [
            helper + 'def target(helper):\n    return helper(1)\n',
            helper + 'helper = lambda x: 9\ndef target():\n    return helper(1)\n',
            helper + 'if flag:\n    helper = replacement\ndef target():\n    return helper(1)\n',
            helper + 'from another import helper\ndef target():\n    return helper(1)\n',
            helper + 'def target():\n    def nested(): return helper(1)\n    return nested()\n',
            helper + 'def target():\n    return [helper(1) for helper in []]\n',
            helper + 'def target():\n    global helper\n    helper = replacement\n    return helper(1)\n',
            '@decorator\n' + helper + 'def target():\n    return helper(1)\n',
            helper + 'def target(obj):\n    return obj.helper(1)\n',
            helper + 'def helper(x): return 9\ndef target(): return helper(1)\n',
            helper + 'try:\n    pass\nexcept Exception as helper:\n    pass\ndef target(): return helper(1)\n',
            helper + 'match obj:\n    case helper:\n        pass\ndef target(): return helper(1)\n',
            helper + 'if flag:\n    from another import *\ndef target(): return helper(1)\n',
        ]
        for source in cases:
            self.assertEqual(self.retrieve(source)[0], [], source)

    def test_retrieval_bounds_cycles_depth_and_size_without_slicing(self):
        source = 'def leaf(): return helper()\ndef helper(): return leaf()\ndef target(): return helper()\n'
        self.assertEqual(len(self.retrieve(source)[0]), 2)
        contexts, report = self.retrieve(source, max_depth=1)
        self.assertEqual([item['name'] for item in contexts], ['helper'])
        self.assertEqual(report['omitted'], ['leaf'])
        self.assertEqual(self.retrieve(source, max_symbols=1)[1]['omitted'], ['leaf'])
        self.assertEqual(self.retrieve(source, max_chars=1)[0], [])

    def test_setup_and_patch_return_values_are_provable_and_really_execute(self):
        setup = ('import unittest\nfrom unittest.mock import Mock, patch\nfrom sample import target\n'
                 'class Cases(unittest.TestCase):\n    def setUp(self):\n        self.client = Mock()\n'
                 '    def test_mock(self):\n        target(self.client)\n        self.client.send.assert_called_once_with("fixture")\n')
        context = {'module': 'sample', 'target': 'target', 'requireMockBehavior': True,
                   'source': 'def target(client):\n    client.send("fixture")\n'}
        self.assertTrue(validate_bindings(setup, context)['valid'])
        patch = ('import unittest\nfrom unittest.mock import patch\nfrom sample import target\n'
                 'class Cases(unittest.TestCase):\n    def test_mock(self):\n'
                 '        with patch("sample.dependency", return_value=3) as dependency:\n'
                 '            target()\n            dependency.assert_called_once_with()\n')
        patch_context = {**context, 'source': 'def dependency(): raise RuntimeError("not mocked")\ndef target(): return dependency()\n'}
        self.assertTrue(validate_bindings(patch, patch_context)['valid'])
        for source, code in [(context['source'], setup), (patch_context['source'], patch)]:
            with tempfile.TemporaryDirectory() as folder:
                Path(folder, 'sample.py').write_text(source, encoding='utf-8')
                Path(folder, 'generated_test.py').write_text(code, encoding='utf-8')
                result = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'generated_test'], cwd=folder,
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('Ran 1 test', result.stderr)

    def test_mock_extensions_do_not_admit_false_provenance_or_rebinding(self):
        context = {'module': 'sample', 'target': 'target', 'requireMockBehavior': True,
                   'source': 'def target(client=None):\n    return dependency()\n'}
        def candidate(body, setup='self.client = Mock()', extra=''):
            return ('import unittest\nfrom unittest.mock import Mock, patch\nfrom sample import target\n'
                    'class Cases(unittest.TestCase):\n    def setUp(self):\n' + textwrap.indent(setup, '        ') + '\n'
                    + extra + '    def test_mock(self):\n' + textwrap.indent(body, '        ') + '\n')
        check = 'target(self.client)\nself.client.send.assert_called_once()'
        cases = [
            candidate(check, 'self.client = object()'),
            candidate(check, 'if False:\n    self.client = Mock()'),
            candidate('self.client = object()\n' + check),
            candidate(check, 'client = Mock()'),
            candidate(check, extra='    async def asyncSetUp(self):\n        self.client = object()\n'),
            candidate(check, extra='    @property\n    def client(self):\n        return object()\n'),
            candidate('target()\nself.client.send.assert_called_once()'),
            candidate('with patch("sample.dependency", return_value=3) as dep:\n    target()\n    dep.return_value.send.assert_called_once()'),
            candidate('with patch("sample.dependency", assert_called_once=lambda: None) as dep:\n    target()\n    dep.assert_called_once()'),
            candidate('target(self.client)\nself.client.assert_called_once()', 'self.client = Mock(assert_called_once=lambda: None)'),
            candidate('with patch("sample.target", return_value=3) as dep:\n    target()\n    dep.assert_called_once()'),
        ]
        for code in cases:
            self.assertFalse(validate_bindings(code, context)['valid'], code)


if __name__ == '__main__':
    unittest.main()
