import json
import math
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).parent
sys.path.insert(0, str(SCRIPTS))
from ast_caller_finder import find_call_sites
from probe_input_transport import prepare_probe_inputs, restore_call
from trace_value_codec import snapshot_value, restore_value, is_lossless_json_value


class TypedCallerTransportTests(unittest.TestCase):
    def cli(self, script, *args):
        result = subprocess.run([sys.executable, '-B', str(SCRIPTS / script), *map(str, args)],
                                capture_output=True, text=True, encoding='utf-8', timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def caller_trace(self, source, target='target'):
        with tempfile.TemporaryDirectory(prefix='neutral-typed-caller-') as directory:
            path = pathlib.Path(directory) / 'sample.py'
            path.write_text(source, encoding='utf-8')
            callers = self.cli('ast_caller_finder.py', target, directory, path)
            envelope = {'schema_version': 'probe-inputs-v1', 'cases': [
                {'input': caller['trace_input'], 'source': {'kind': 'caller_literals',
                 'file': caller['caller_file'], 'caller': caller['caller_func'], 'line': caller['line']}}
                for caller in callers
            ]}
            traced = self.cli('dynamic_tracer.py', path, target, json.dumps(envelope))
            return callers, traced

    def test_nested_tuple_bytes_and_non_string_keys_survive_both_clis(self):
        callers, trace = self.caller_trace(
            "def target(data): return data[(1, 2)][0] + len(data[3])\n"
            "def example(): return target({(1, 2): (4,), 3: b'\\x00A'})\n")
        self.assertIsNone(callers[0]['trace_args'])
        expected = [{(1, 2): (4,), 3: b'\x00A'}]
        self.assertEqual(restore_call(callers[0]['trace_input'])['args'], expected)
        self.assertEqual(restore_value(trace['cases'][0]['input_before']['args']), expected)
        self.assertEqual(trace['examples'][0]['result'], '6')
        self.assertNotEqual(trace['examples'][0].get('call_assertable'), False)
        self.assertEqual(trace['cases'][0]['source']['line'], 2)

    def test_large_integer_integral_float_and_negative_zero_stay_distinct(self):
        callers, trace = self.caller_trace(
            'def target(value): return value + 1\n'
            'def examples(): return target(9007199254740993), target(1.0), target(-0.0)\n')
        self.assertTrue(all(caller['trace_args'] is None for caller in callers))
        values = [restore_value(row['input_before']['args'])[0] for row in trace['cases']]
        self.assertEqual(values[0], 9007199254740993)
        self.assertIs(type(values[0]), int)
        self.assertIs(type(values[1]), float)
        self.assertIs(type(values[2]), float)
        self.assertEqual(math.copysign(1, values[2]), -1)
        self.assertEqual([row['result'] for row in trace['examples']], ['9007199254740994', '2.0', '1.0'])

    def test_kwargs_and_nested_dictionary_insertion_order_survive(self):
        callers, trace = self.caller_trace(
            'def target(**values): return [(key, list(value)) for key, value in values.items()]\n'
            "def example(): return target(second={'2': 3, '1': 4}, first={'1': 5, '0': 6})\n")
        self.assertIsNone(callers[0]['trace_kwargs'])
        kwargs = restore_value(trace['cases'][0]['input_before']['kwargs'])
        self.assertEqual(list(kwargs), ['second', 'first'])
        self.assertEqual(list(kwargs['second']), ['2', '1'])
        self.assertEqual(trace['examples'][0]['result'], "[('second', ['2', '1']), ('first', ['1', '0'])]")

    def test_constructor_values_are_preserved_and_never_become_method_args(self):
        callers, trace = self.caller_trace(
            'class Box:\n'
            '    def __init__(self, prefix): self.prefix = prefix\n'
            '    def join(self, parts): return self.prefix + parts[0]\n'
            "def examples(): return Box(b'A').join((b'Z',)), Box(b'B').join((b'Z',))\n", 'Box.join')
        self.assertEqual([row['result'] for row in trace['examples']], ["b'AZ'", "b'BZ'"])
        self.assertTrue(all(caller['trace_constructor_args'] is None for caller in callers))
        self.assertEqual([restore_value(row['input_before']['constructor_args']) for row in trace['cases']],
                         [[b'A'], [b'B']])
        self.assertTrue(all(restore_value(row['input_before']['args']) == [(b'Z',)] for row in trace['cases']))

    def test_nonliteral_budget_and_set_calls_do_not_discard_other_callers(self):
        oversized = repr('x' * 4097)
        callers, trace = self.caller_trace(
            'def target(value): return len(value)\n'
            f'def examples(value): return target((1,)), target({{2, 3}}), target(value), target({oversized})\n')
        self.assertEqual(len(callers), 4)
        reasons = {caller['trace_input_diagnostic']['reason'] for caller in callers if caller['trace_input_diagnostic']}
        self.assertEqual(reasons, {'non-literal-arguments', 'unreplayable-input'})
        self.assertEqual(callers[3]['trace_input_diagnostic']['details'], ['text-budget'])
        self.assertEqual(sum(row['status'] == 'not_started' for row in trace['cases']), 2)
        self.assertEqual([row['result'] for row in trace['examples']], ['1', '2'])
        self.assertIs(trace['examples'][1]['call_assertable'], False)
        self.assertEqual(trace['errors'], [])
        self.assertFalse(trace['complete'])

    def test_unresolved_constructor_is_not_encoded_as_verified_empty_setup(self):
        source = ('class Box:\n    def __init__(self, value): self.value = value\n'
                  '    def read(self, value): return value\n'
                  'def example(prefix): return Box(prefix).read((1,))\n')
        with tempfile.TemporaryDirectory(prefix='neutral-typed-constructor-') as directory:
            path = pathlib.Path(directory) / 'sample.py'
            path.write_text(source, encoding='utf-8')
            caller = find_call_sites('Box.read', directory, str(path))[0]
        self.assertEqual(set(restore_call(caller['trace_input'])), {'args', 'kwargs'})
        self.assertEqual(caller['trace_constructor_diagnostic'], {'reason': 'non-literal-constructor'})

    def test_invalid_typed_cases_are_independent_diagnostics_not_ordinary_dicts(self):
        valid = snapshot_value({'args': [3], 'kwargs': {}})
        invalid_values = [
            {'schema_version': 'trace-value-v1', 'replayable': True, 'value': {'type': 'call', 'value': 'bad()'}},
            snapshot_value({'args': [1], 'kwargs': {}, 'constructor_args': []}),
            snapshot_value({'args': [], 'kwargs': {1: 'bad-key'}}),
            snapshot_value({'args': 1, 'kwargs': {}}),
        ]
        cases = [{'input': value, 'source': {'kind': 'caller_literals', 'line': index + 1}}
                 for index, value in enumerate(invalid_values + [valid])]
        with tempfile.TemporaryDirectory(prefix='neutral-invalid-envelope-') as directory:
            path = pathlib.Path(directory) / 'sample.py'
            path.write_text('def target(value): return value + 1\n', encoding='utf-8')
            trace = self.cli('dynamic_tracer.py', path, 'target', json.dumps({'schema_version': 'probe-inputs-v1', 'cases': cases}))
        self.assertEqual([row['status'] for row in trace['cases']], ['not_started'] * 4 + ['returned'])
        self.assertEqual([row['source']['line'] for row in trace['cases']], [1, 2, 3, 4, 5])
        self.assertTrue(all(row['reason'] == 'invalid-input-envelope' for row in trace['cases'][:4]))
        self.assertEqual(trace['examples'][0]['result'], '4')
        self.assertEqual(trace['errors'], [])

    def test_bad_envelope_version_never_falls_back_to_legacy_inputs(self):
        value = snapshot_value({'args': [4], 'kwargs': {}})
        for envelope in ({'args': [4]}, {'schema_version': 'probe-inputs-v2', 'cases': [
                {'input': value, 'source': {'kind': 'caller_literals'}}]}):
            valid, invalid = prepare_probe_inputs(envelope)
            self.assertEqual(valid, [])
            self.assertEqual(len(invalid), 1)
            self.assertEqual(invalid[0][2], 'invalid-input-envelope')

    def test_decoder_rejects_noncanonical_and_collapsing_transport(self):
        snapshots = [snapshot_value({1: 'first'}), snapshot_value({1, 2}), snapshot_value(1.0)]
        snapshots[0]['value']['items'].append({'key': {'type': 'bool', 'value': True}, 'value': {'type': 'str', 'value': 'second'}})
        snapshots[1]['value']['items'].append({'type': 'int', 'value': '1'})
        snapshots[2]['value']['extra'] = 'discarded'
        for snapshot in snapshots:
            with self.assertRaises(ValueError):
                restore_value(snapshot)

    def test_legacy_values_are_only_the_lossless_json_subset(self):
        for value in ([1, 'text', True, None, 1.5], {'key': [2]}):
            self.assertTrue(is_lossless_json_value(value))
        for value in ((1,), b'a', {1}, {1: 'value'}, {'2': 1, '1': 2}, 1.0, -0.0, 9007199254740993):
            self.assertFalse(is_lossless_json_value(value))
        valid, invalid = prepare_probe_inputs([[1], {'args': [2], 'kwargs': {}}])
        self.assertEqual(len(valid), 2)
        self.assertEqual(invalid, [])

    def test_equivalent_js_float_spellings_keep_exact_value_and_negative_zero(self):
        for wire, expected in [('1e-7', 1e-7), ('0.000001', 1e-6), ('-0', -0.0), ('1', 1.0)]:
            snapshot = {'schema_version': 'trace-value-v1', 'replayable': True,
                        'value': {'type': 'float', 'value': wire}}
            restored = restore_value(snapshot)
            self.assertIs(type(restored), float)
            self.assertEqual(restored, expected)
            self.assertEqual(math.copysign(1, restored), math.copysign(1, expected))


if __name__ == '__main__':
    unittest.main()
