import ast
import hashlib
import importlib.metadata
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import external_mutation_runner as adapter
from basic_mutation_runner import find_target_scope


def collect(source, target='combine'):
    tree = ast.parse(source)
    return adapter.mutatest_candidates(tree, find_target_scope(tree, target),
                                       hashlib.sha256(source.encode('utf-8')).hexdigest(),
                                       target, 'selected-function-body-v1')


class ExternalProbeTests(unittest.TestCase):
    def test_missing_package_never_selects_builtin(self):
        with patch.object(adapter.importlib.metadata, 'version', side_effect=importlib.metadata.PackageNotFoundError):
            result = adapter.probe_engine('mutatest')
        self.assertFalse(result['supported'])
        self.assertEqual(result['engine'], 'mutatest')
        self.assertEqual(result['diagnosticCode'], 'package-missing')
        self.assertIsNone(result['operatorSetVersion'])

    def test_unverified_version_and_unknown_engine_are_explicit(self):
        with patch.object(adapter.importlib.metadata, 'version', return_value='9.0.0'):
            result = adapter.probe_engine('mutatest')
        self.assertFalse(result['supported'])
        self.assertEqual(result['diagnosticCode'], 'unsupported-version')
        self.assertEqual(adapter.probe_engine('unknown')['diagnosticCode'], 'adapter-unavailable')

    def test_mutmut_is_not_advertised_as_supported(self):
        with patch.object(adapter.importlib.metadata, 'version', return_value='3.7.0'):
            for host, diagnostic in [('win32', 'unsupported-platform'), ('linux', 'adapter-unavailable')]:
                with patch.object(adapter.sys, 'platform', host):
                    result = adapter.probe_engine('mutmut')
                self.assertFalse(result['supported'])
                self.assertEqual(result['diagnosticCode'], diagnostic)
        with patch.object(adapter.importlib.metadata, 'version', side_effect=importlib.metadata.PackageNotFoundError):
            self.assertNotEqual(adapter.probe_engine('mutmut')['diagnosticCode'], 'package-missing')

    def test_untrusted_dependency_exception_is_not_printed(self):
        with patch.object(adapter.importlib.metadata, 'version', side_effect=RuntimeError('private arbitrary output')):
            result = adapter.probe_engine('mutatest')
        self.assertEqual(result['diagnosticCode'], 'self-check-failed')
        self.assertNotIn('private', json.dumps(result))

    def test_failed_self_check_cannot_certify_engine(self):
        with patch.object(adapter.importlib.metadata, 'version', return_value='3.1.0'), \
                patch.object(adapter, 'mutatest_candidates', return_value={'candidates': []}):
            self.assertEqual(adapter.probe_engine('mutatest')['diagnosticCode'], 'self-check-failed')

    def test_probe_cli_has_machine_readable_unknown_engine(self):
        completed = subprocess.run([sys.executable, '-B', adapter.__file__, '--probe', 'unknown'],
                                   capture_output=True, encoding='utf-8', timeout=10, check=True)
        result = json.loads(completed.stdout)
        self.assertFalse(result['supported'])
        self.assertEqual(result['engine'], 'unknown')

    def test_pre_enumeration_failure_keeps_selected_engine_without_masking_fallback(self):
        probe = {'supported': True, 'engineVersion': '3.1.0', 'operatorSetVersion': adapter.MUTATEST_OPERATOR_VERSION}
        for status, executed, expected_exit in [('failed', 0, 0), ('complete', 6, 2)]:
            captured = io.StringIO()
            with patch.object(adapter, 'probe_engine', return_value=probe), \
                    patch.object(adapter, 'run_mutation_trials', return_value={
                        'engine': 'builtin', 'status': status, 'counts': {'executed': executed}}), \
                    redirect_stdout(captured):
                exit_code = adapter.main(['mutatest', 'source.py', 'tests.py'])
            result = json.loads(captured.getvalue())
            self.assertEqual(exit_code, expected_exit)
            self.assertEqual(result['engine'], 'mutatest')
            if expected_exit == 0:
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['counts']['executed'], 0)
            else:
                self.assertEqual(result['error'], 'external-engine-execution-failed')


@unittest.skipUnless(adapter.probe_engine('mutatest')['supported'], 'verified mutatest 3.1.0 AST API is not installed')
class RealMutatestTests(unittest.TestCase):
    def test_real_external_rules_enumerate_all_six_binary_replacements(self):
        source = 'def combine(a, b):\n    return a + b\n'
        first, second = collect(source), collect(source)
        self.assertEqual(first['engine'], 'mutatest')
        self.assertEqual(first['operatorSetVersion'], 'mutatest-ast-3.1.0-v1')
        self.assertEqual(first, second)
        records = [record for record, _ in first['candidates']]
        self.assertEqual(len(records), 6)
        self.assertEqual({r['to'] for r in records}, {'Sub', 'Mult', 'Div', 'FloorDiv', 'Mod', 'Pow'})
        self.assertTrue(all(r['codeChange']['before'].strip() == 'return a + b' for r in records))
        self.assertEqual(len({r['id'] for r in records}), 6)

    def test_discovery_never_executes_source(self):
        result = collect('raise RuntimeError("must never execute")\ndef combine(a, b):\n    return a + b\n')
        self.assertEqual(len(result['candidates']), 6)

    def test_scope_excludes_other_functions_defaults_decorators_and_nested_callables(self):
        source = ('DEFAULT = 4 + 5\n'
                  'def other(a, b):\n    return a - b\n'
                  '@decorate(1 + 2)\n'
                  'def combine(a=3 + 4, b=5 + 6):\n'
                  '    def nested(x=7 + 8):\n        return x * 2\n'
                  '    class Inner:\n        value = 9 + 10\n'
                  '    deferred = lambda x: x + 11\n'
                  '    return a + b\n')
        original = ast.parse(source)
        original_scope = find_target_scope(original, 'combine')
        result = collect(source)
        self.assertEqual(len(result['candidates']), 6)
        for _, mutated in result['candidates']:
            variant = ast.parse(mutated)
            selected = find_target_scope(variant, 'combine')
            self.assertEqual(ast.dump(selected.args), ast.dump(original_scope.args))
            self.assertEqual([ast.dump(n) for n in selected.decorator_list], [ast.dump(n) for n in original_scope.decorator_list])
            self.assertEqual([ast.dump(n) for n in selected.body[:-1]], [ast.dump(n) for n in original_scope.body[:-1]])
            self.assertEqual([ast.dump(n) for n in variant.body[:-1]], [ast.dump(n) for n in original.body[:-1]])

    def test_qualified_async_method_does_not_fall_back_to_top_level_namesake(self):
        source = ('def combine(a, b):\n    return a - b\n'
                  'class Calculator:\n    async def combine(self, a, b):\n        return a + b\n')
        result = collect(source, 'Calculator.combine')
        self.assertEqual(len(result['candidates']), 6)
        self.assertTrue(all(r['line'] == 5 for r, _ in result['candidates']))
        self.assertEqual(ast.dump(ast.parse(result['candidates'][0][1]).body[0]), ast.dump(ast.parse(source).body[0]))
        with self.assertRaises(adapter.AdapterUnavailable):
            collect(source, 'Missing.combine')

    def test_real_condition_boolean_and_comparison_rules_compile(self):
        source = 'def combine(a, b):\n    if a < b:\n        return True\n    return False\n'
        result = collect(source)
        kinds = {r['kind'] for r, _ in result['candidates']}
        self.assertEqual(kinds, {'If', 'Compare', 'NameConstant'})
        for _, mutated in result['candidates']:
            compile(mutated, '<test>', 'exec')
        self.assertEqual(len(result['candidates']), len({ast.dump(ast.parse(text)) for _, text in result['candidates']}))

    def test_real_external_candidates_use_shared_isolated_runner_and_preserve_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, tests = root / 'sample.py', root / 'test_sample.py'
            original = 'def combine(a, b):\n    return a + b\n'
            source.write_text(original, encoding='utf-8')
            tests.write_text('import unittest\nfrom sample import combine\n'
                             'class TestCombine(unittest.TestCase):\n'
                             '    def test_sum(self):\n        self.assertEqual(combine(2, 3), 5)\n', encoding='utf-8')
            completed = subprocess.run([sys.executable, '-B', adapter.__file__, 'mutatest', str(source), str(tests),
                                        '0', '5', 'combine', '', '30', '2'], capture_output=True,
                                       encoding='utf-8', timeout=40, check=True)
            result = json.loads(completed.stdout)
            self.assertEqual(result['engine'], 'mutatest')
            self.assertEqual(result['engineVersion'], '3.1.0')
            self.assertEqual(result['executionBackend'], 'isolated-unittest-v1')
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(result['counts']['available'], 6)
            self.assertEqual(result['counts']['executed'], 6)
            self.assertEqual(result['counts']['killed'], 6)
            self.assertTrue(all(m.get('codeChange') for m in result['mutants']))
            self.assertEqual(source.read_text(encoding='utf-8'), original)


if __name__ == '__main__':
    unittest.main()
