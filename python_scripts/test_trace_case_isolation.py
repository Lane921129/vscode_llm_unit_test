import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from dynamic_tracer import trace_function, trace_repr_with_oracle
from trace_value_codec import snapshot_value, snapshot_call, restore_value, MAX_ITEMS


class TraceValueCodecTests(unittest.TestCase):
    def test_exact_builtin_types_roundtrip_without_json_type_loss(self):
        value = {1: (b'abc', [True, None, 1.5]), 'set': {2, 3}, 'frozen': frozenset({'a'})}
        snapshot = snapshot_value(value)
        self.assertTrue(snapshot['replayable'])
        self.assertEqual(restore_value(json.loads(json.dumps(snapshot))), value)

    def test_user_hooks_are_never_called(self):
        class Hostile(list):
            def __repr__(self):
                raise AssertionError('repr invoked')
            def __iter__(self):
                raise AssertionError('iter invoked')
            def __deepcopy__(self, memo):
                raise AssertionError('deepcopy invoked')
        candidate = Hostile()
        self.assertFalse(snapshot_value(candidate)['replayable'])
        self.assertFalse(trace_repr_with_oracle(candidate)[1])

    def test_metaclass_name_descriptor_is_never_called(self):
        hooks = []
        class Meta(type):
            @property
            def __name__(cls):
                hooks.append('name hook')
                return 'HookedName'
        class Value(metaclass=Meta):
            pass
        candidate = Value()
        encoded = snapshot_value(candidate)
        self.assertFalse(encoded['replayable'])
        self.assertEqual(encoded['value']['python_type'], 'Value')
        self.assertEqual(trace_repr_with_oracle(candidate), ('<non_assertable: Value>', False))
        self.assertEqual(hooks, [])

    def test_cycles_shared_identity_and_excessive_values_are_not_replayed(self):
        cycle = []
        cycle.append(cycle)
        shared = []
        for candidate in (cycle, [shared, shared], list(range(MAX_ITEMS + 1)), float('nan'), 'x' * 4097):
            encoded = snapshot_value(candidate)
            self.assertFalse(encoded['replayable'])
            with self.assertRaises(ValueError):
                restore_value(encoded)

    def test_decoder_rejects_forged_or_executable_tags(self):
        for value in ({'type': 'call', 'value': 'print(1)'}, {'type': 'float', 'value': 'nan'}):
            with self.assertRaises(ValueError):
                restore_value({'schema_version': 'trace-value-v1', 'replayable': True, 'value': value})

    def test_call_graph_detects_aliases_across_args_kwargs_and_constructor(self):
        shared = []
        before = snapshot_call([shared], {'value': shared}, [shared], {})
        self.assertFalse(before['replayable'])
        self.assertFalse(before['call_graph']['replayable'])


class TraceCaseIsolationTests(unittest.TestCase):
    def run_trace(self, source, inputs, target='target', **options):
        with tempfile.TemporaryDirectory(prefix='neutral-trace-case-') as directory:
            file = pathlib.Path(directory) / 'neutral.py'
            file.write_text(source, encoding='utf-8')
            return trace_function(str(file), target, inputs, **options)

    def test_mutated_inputs_preserve_before_and_record_after(self):
        facts = self.run_trace('def target(values):\n    values.append(2)\n    return len(values)\n', [[[1]]])
        record = facts['examples'][0]
        self.assertEqual(record['args'], ['[1]'])
        self.assertEqual(restore_value(record['input_before']['args']), [[1]])
        self.assertEqual(restore_value(record['input_after']['args']), [[1, 2]])
        self.assertTrue(record['inputs_mutated'])

    def test_mutation_before_exception_keeps_original_kwargs(self):
        facts = self.run_trace('def target(*, values):\n    values.pop()\n    raise ValueError("expected")\n',
                               [{'args': [], 'kwargs': {'values': [1]}}])
        record = facts['errors'][0]
        self.assertEqual(record['kwargs'], {'values': '[1]'})
        self.assertEqual(restore_value(record['input_after']['kwargs']), {'values': []})
        self.assertEqual(facts['cases'][0]['status'], 'raised')

    def test_constructor_mutation_and_failure_are_case_local(self):
        source = ('class Box:\n'
                  '    def __init__(self, values):\n'
                  '        self.count = len(values)\n'
                  '        values.append(9)\n'
                  '        if self.count == 0: raise ValueError("empty")\n'
                  '    def size(self): return self.count\n')
        inputs = [{'args': [], 'kwargs': {}, 'constructor_args': [value], 'constructor_kwargs': {}}
                  for value in ([1], [], [1, 2])]
        facts = self.run_trace(source, inputs, target='Box.size')
        self.assertIsNone(facts['load_error'])
        self.assertEqual([case['status'] for case in facts['cases']], ['returned', 'setup_error', 'returned'])
        self.assertEqual([row['result'] for row in facts['examples']], ['1', '2'])
        self.assertEqual(facts['examples'][0]['constructor_args'], ['[1]'])
        self.assertEqual(facts['errors'], [])

    def test_globals_and_mutable_defaults_are_fresh_per_case(self):
        source = ('count = 0\n'
                  'def target(value, seen=[]):\n'
                  '    global count\n'
                  '    count += 1\n'
                  '    seen.append(value)\n'
                  '    return count, len(seen)\n')
        facts = self.run_trace(source, [[1], [2]])
        self.assertEqual([record['result'] for record in facts['examples']], ['(1, 1)', '(1, 1)'])
        self.assertEqual(facts['isolation'], 'fresh-process-per-case')

    def test_typed_inputs_keep_tuple_bytes_set_and_integer_dict_keys(self):
        source = 'def target(value):\n    return type(value).__name__, type(next(iter(value))).__name__\n'
        facts = self.run_trace(source, [[(1,)], [b'a'], [{1}], [{1: 'value'}]])
        self.assertEqual([record['result'] for record in facts['examples']],
                         ["('tuple', 'int')", "('bytes', 'int')", "('set', 'int')", "('dict', 'int')"])

    def test_case_timeout_preserves_completed_and_later_cases(self):
        source = ('def target(value):\n'
                  '    if value == "wait":\n'
                  '        while True: pass\n'
                  '    return value\n')
        facts = self.run_trace(source, [['first'], ['wait'], ['last']], case_timeout_seconds=1, total_timeout_seconds=10)
        self.assertEqual([case['status'] for case in facts['cases'][:3]], ['returned', 'timeout', 'returned'])
        self.assertEqual([row['result'] for row in facts['examples'][:2]], ["'first'", "'last'"])
        self.assertFalse(facts['complete'])

    def test_total_deadline_marks_remaining_inputs_not_started(self):
        source = 'def target(value):\n    while True: pass\n'
        facts = self.run_trace(source, [[1], [2], [3]], case_timeout_seconds=1, total_timeout_seconds=0.8)
        self.assertEqual(facts['cases'][-1]['status'], 'not_started')
        self.assertFalse(facts['complete'])
        self.assertEqual(len(facts['cases']), 3)

    def test_planning_timeout_keeps_known_inputs_as_not_started(self):
        facts = self.run_trace('while True: pass\ndef target(value): return value\n', [[1], [2]], total_timeout_seconds=0.5)
        self.assertEqual(facts['planning']['status'], 'timeout')
        self.assertEqual([row['status'] for row in facts['cases']], ['not_started', 'not_started'])
        self.assertTrue(facts['load_error'])

    def test_duplicate_inputs_have_unique_attempt_ids_when_planning_fails(self):
        facts = self.run_trace('raise RuntimeError("setup unavailable")\ndef target(value): return value\n',
                               [[1], [1]])
        self.assertEqual([row['status'] for row in facts['cases']], ['not_started', 'not_started'])
        identifiers = [row['case_id'] for row in facts['cases']]
        self.assertEqual(len(set(identifiers)), 2)
        self.assertTrue(all(facts['run_id'] in identifier for identifier in identifiers))

    def test_source_metadata_and_incremental_journal_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix='neutral-trace-journal-') as directory:
            journal = pathlib.Path(directory) / 'events.jsonl'
            source = {'kind': 'caller_literals', 'line': 4}
            facts = self.run_trace('def target(value): return value\n',
                                   [{'args': [2], 'kwargs': {}, 'source': source}], progress_path=str(journal))
            events = [json.loads(line) for line in journal.read_text(encoding='utf-8').splitlines()]
        self.assertEqual(facts['cases'][0]['source'], source)
        completed = next(row for row in events if row['event'] == 'case_completed')
        self.assertEqual(completed['examples'][0]['case_id'], facts['cases'][0]['case_id'])
        self.assertEqual(events[-1]['event'], 'run_completed')
        self.assertTrue(events[-1]['complete'])

    def test_blocked_case_is_diagnostic_only(self):
        facts = self.run_trace('def target():\n    import subprocess\n    subprocess.run(["unused"])\n', [[]])
        self.assertEqual(facts['cases'][0]['status'], 'blocked')
        self.assertEqual(facts['examples'], [])
        self.assertEqual(facts['errors'], [])
        self.assertTrue(facts['blocked_operations'])

    def test_unsupported_inputs_do_not_invoke_user_hooks(self):
        class Unavailable:
            def __repr__(self):
                raise AssertionError('repr invoked')
        facts = self.run_trace('def target(value): return 1\n', [[Unavailable()]])
        self.assertEqual(facts['cases'][0]['status'], 'not_started')
        self.assertEqual(facts['cases'][0]['reason'], 'unsupported-input-snapshot')
        self.assertEqual(facts['examples'], [])


if __name__ == '__main__':
    unittest.main()
