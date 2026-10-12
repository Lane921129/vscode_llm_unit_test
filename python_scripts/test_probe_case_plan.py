import unittest
import sys
import tempfile
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dynamic_tracer import _candidate_context, trace_function
from probe_case_plan import deduplicate_planned_calls
from trace_value_codec import snapshot_value


class ProbeCasePlanTests(unittest.TestCase):
    def encoded(self, args=None, kwargs=None, **extra):
        return snapshot_value({'args': args or [], 'kwargs': kwargs or {},
                               'source': {'kind': 'caller_literals', 'caller_file': extra.pop('site', 'app.py')}, **extra})

    def test_zero_argument_callers_share_one_attempt_but_keep_all_origins(self):
        entries, stats = deduplicate_planned_calls([self.encoded(site=f'caller_{i}.py') for i in range(33)], _candidate_context)
        self.assertEqual(len(entries), 1)
        self.assertEqual(len(entries[0]['source_sites']), 33)
        self.assertEqual(stats['duplicate_count'], 32)
        self.assertEqual(stats['source_count'], 33)

    def test_python_types_keyword_order_and_constructor_values_stay_separate(self):
        values = [self.encoded(args=[1]), self.encoded(args=[1.0]),
                  self.encoded(kwargs={'a': 1, 'b': 2}), self.encoded(kwargs={'b': 2, 'a': 1}),
                  self.encoded(constructor_args=[1]), self.encoded(constructor_args=[2])]
        entries, stats = deduplicate_planned_calls(values, _candidate_context)
        self.assertEqual(len(entries), 6)
        self.assertEqual(stats['duplicate_count'], 0)

    def test_unknown_setup_and_user_fixture_attempts_are_not_merged(self):
        values = [self.encoded(receiver_state={'count': 1}), self.encoded(receiver_state={'count': 1}),
                  snapshot_value({'args': [], 'source': {'kind': 'unknown', 'detail': 'user-fixture'}}),
                  snapshot_value({'args': [], 'source': {'kind': 'unknown', 'detail': 'user-fixture'}})]
        entries, _ = deduplicate_planned_calls(values, _candidate_context)
        self.assertEqual(len(entries), 4)

    def test_real_workers_execute_one_duplicate_call_and_keep_journal_origins(self):
        with tempfile.TemporaryDirectory(prefix='probe-call-plan-') as root:
            source = Path(root) / 'sample.py'
            source.write_text('def ping():\n    return 7\n', encoding='utf-8')
            progress = Path(root) / 'trace.jsonl'
            inputs = [{'args': [], 'kwargs': {}, 'source': {'kind': 'caller_literals',
                      'file': f'caller_{index}.py', 'line': index + 1}} for index in range(33)]
            result = trace_function(str(source), 'ping', inputs, progress_path=str(progress),
                                    case_timeout_seconds=5, planning_timeout_seconds=10, total_timeout_seconds=25)
            self.assertTrue(result['complete'], result.get('load_error'))
            self.assertEqual(len(result['cases']), 1)
            self.assertEqual(result['cases'][0]['status'], 'returned')
            self.assertEqual(result['examples'][0]['result'], '7')
            self.assertEqual(len(result['examples'][0]['source_sites']), 33)
            events = [json.loads(line) for line in progress.read_text(encoding='utf-8').splitlines()]
            self.assertEqual(sum(event['event'] == 'case_started' for event in events), 1)
            planned = next(event for event in events if event['event'] == 'planning_completed')
            self.assertEqual(planned['input_deduplication']['duplicate_count'], 32)


if __name__ == '__main__':
    unittest.main()
