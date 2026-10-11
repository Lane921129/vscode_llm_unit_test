"""Trace startup calibration preserves isolation and the original total deadline."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import dynamic_tracer
from trace_value_codec import snapshot_value


class TraceTimingTests(unittest.TestCase):
    def test_slow_import_fast_target_observes_fresh_state_per_case_and_records_allocation(self):
        with tempfile.TemporaryDirectory(prefix='neutral-trace-timing-') as directory:
            source = Path(directory) / 'sample.py'
            source.write_text('import time\ntime.sleep(0.8)\ncount = 0\n'
                              'def target(value, seen=[]):\n'
                              '    global count\n    count += 1\n    seen.append(value)\n'
                              '    return count, len(seen)\n', encoding='utf-8')
            progress = Path(directory) / 'progress.jsonl'
            result = dynamic_tracer.trace_function(str(source), 'target', [[1], [2]],
                                                  case_timeout_seconds=0.5, total_timeout_seconds=10,
                                                  progress_path=str(progress))
            events = [json.loads(line) for line in progress.read_text(encoding='utf-8').splitlines()]
        self.assertEqual(result['planning']['status'], 'completed')
        self.assertGreaterEqual(result['planning']['duration_ms'], 750)
        timing = result['case_timing']
        self.assertEqual(timing['calibration_reason'], 'completed-planning-startup')
        self.assertEqual(timing['configured_timeout_seconds'], 0.5)
        self.assertEqual(timing['effective_timeout_seconds'], 0.5 + result['planning']['duration_ms'] / 1000)
        self.assertEqual([case['status'] for case in result['cases']], ['returned', 'returned'])
        self.assertEqual([row['result'] for row in result['examples']], ['(1, 1)', '(1, 1)'])
        self.assertTrue(result['complete'])
        self.assertEqual(result['isolation'], 'fresh-process-per-case')
        self.assertEqual(next(row for row in events if row['event'] == 'planning_completed')['case_timing'], timing)
        completed = [row['case'] for row in events if row['event'] == 'case_completed']
        self.assertEqual([case['allocated_timeout_seconds'] for case in completed],
                         [timing['effective_timeout_seconds']] * 2)

    def test_calibrated_case_is_clipped_to_original_total_deadline_without_retry(self):
        clock = [0.0]
        calls = []
        planned_inputs = [snapshot_value([1]), snapshot_value([2])]

        def worker(payload, timeout):
            calls.append((payload['mode'], timeout))
            if payload['mode'] == 'plan':
                clock[0] += 2.0
                return {'args': ['value'], 'load_error': None, 'planned_inputs': planned_inputs}
            clock[0] += timeout
            raise subprocess.TimeoutExpired('neutral case', timeout)

        with patch.object(dynamic_tracer.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(dynamic_tracer, '_worker_result', side_effect=worker):
            result = dynamic_tracer.trace_function('neutral.py', 'target', [[1], [2]],
                                                  case_timeout_seconds=0.25, total_timeout_seconds=3)
        self.assertEqual(calls, [('plan', 3.0), ('case', 1.0)])
        self.assertEqual(result['case_timing']['effective_timeout_seconds'], 2.25)
        self.assertEqual(result['duration_ms'], 3000)
        self.assertEqual([case['status'] for case in result['cases']], ['timeout', 'not_started'])
        self.assertEqual([case['reason'] for case in result['cases']], ['total-deadline', 'total-deadline'])
        self.assertEqual([case['allocated_timeout_seconds'] for case in result['cases']], [1.0, 0])
        self.assertEqual(result['examples'], [])
        self.assertEqual(result['errors'], [])
        self.assertFalse(result['complete'])

    def test_unsuccessful_planning_never_calibrates_or_launches_a_case(self):
        for outcome in ('load-error', 'timeout', 'worker-error'):
            with self.subTest(outcome=outcome):
                clock = [0.0]
                calls = []

                def worker(payload, timeout):
                    calls.append(payload['mode'])
                    clock[0] += 0.8
                    if outcome == 'timeout':
                        raise subprocess.TimeoutExpired('neutral planning', timeout)
                    if outcome == 'worker-error':
                        raise RuntimeError('neutral invalid worker')
                    return {'args': [], 'load_error': 'neutral setup unavailable', 'planned_inputs': []}

                with patch.object(dynamic_tracer.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(dynamic_tracer, '_worker_result', side_effect=worker):
                    result = dynamic_tracer.trace_function('neutral.py', 'target', [[1]],
                                                          case_timeout_seconds=0.25, total_timeout_seconds=3)
                self.assertEqual(calls, ['plan'])
                self.assertEqual(result['case_timing'], {'configured_timeout_seconds': 0.25,
                                                       'effective_timeout_seconds': 0.25,
                                                       'calibration_reason': 'planning-unavailable'})
                self.assertEqual(result['cases'][0]['allocated_timeout_seconds'], 0)
                self.assertEqual(result['cases'][0]['reason'], 'planning-unavailable')
                self.assertEqual(result['examples'], [])
                self.assertEqual(result['errors'], [])
                self.assertFalse(result['complete'])

    def test_infinite_target_remains_timeout_and_a_later_case_still_runs(self):
        with tempfile.TemporaryDirectory(prefix='neutral-trace-infinite-') as directory:
            source = Path(directory) / 'sample.py'
            source.write_text('def target(value):\n    if value == "wait":\n'
                              '        while True: pass\n    return value\n', encoding='utf-8')
            result = dynamic_tracer.trace_function(str(source), 'target', [['wait'], ['ready']],
                                                  case_timeout_seconds=0.5, total_timeout_seconds=8)
        self.assertEqual([case['status'] for case in result['cases'][:2]], ['timeout', 'returned'])
        self.assertEqual(result['cases'][0]['reason'], 'case-deadline')
        self.assertEqual(result['cases'][0]['allocated_timeout_seconds'], result['case_timing']['effective_timeout_seconds'])
        self.assertTrue(any(row['result'] == "'ready'" for row in result['examples']))
        self.assertEqual(result['errors'], [])
        timeout_ids = {case['case_id'] for case in result['cases'] if case['status'] == 'timeout'}
        self.assertTrue(all(row['case_id'] not in timeout_ids for row in result['examples']))
        self.assertFalse(result['complete'])


if __name__ == '__main__':
    unittest.main()
