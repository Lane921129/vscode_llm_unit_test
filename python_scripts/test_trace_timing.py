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
    def test_slow_initialization_uses_separate_planning_allowance_through_real_cli(self):
        with tempfile.TemporaryDirectory(prefix='neutral-trace-cold-plan-') as directory:
            source = Path(directory) / 'sample.py'
            original = 'import time\ntime.sleep(5.2)\ndef target(value):\n    return value\n'
            source.write_text(original, encoding='utf-8')
            progress = Path(directory) / 'progress.jsonl'
            completed = subprocess.run([sys.executable, '-B', dynamic_tracer.__file__, str(source), 'target',
                json.dumps([[7]]), json.dumps({'planning_timeout_seconds': 8,
                    'case_timeout_seconds': 0.5, 'total_timeout_seconds': 16,
                    'progress_path': str(progress)})], capture_output=True, encoding='utf-8',
                timeout=20, check=True)
            result = json.loads(completed.stdout)
            events = [json.loads(line) for line in progress.read_text(encoding='utf-8').splitlines()]
            self.assertEqual(source.read_text(encoding='utf-8'), original)
        self.assertEqual(result['planning']['status'], 'completed')
        self.assertGreaterEqual(result['planning']['duration_ms'], 5000)
        self.assertEqual(result['planning']['configured_timeout_seconds'], 8)
        self.assertLessEqual(result['planning']['allocated_timeout_seconds'], 8)
        self.assertEqual([row['status'] for row in result['cases']], ['returned'])
        self.assertEqual(result['examples'][0]['result'], '7')
        self.assertTrue(result['complete'])
        self.assertEqual(next(row for row in events if row['event'] == 'planning_completed')['planning'], result['planning'])

    def test_planning_allowance_is_bounded_and_never_extends_original_total_deadline(self):
        for requested, configured in ((20, 20), (1000, 300), (True, 5), (float('nan'), 5), (-1, 5)):
            with self.subTest(requested=requested):
                clock = [0.0]
                calls = []

                def worker(payload, timeout):
                    calls.append((payload['mode'], timeout))
                    clock[0] += timeout
                    raise subprocess.TimeoutExpired('neutral planning', timeout)

                with patch.object(dynamic_tracer.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(dynamic_tracer, '_worker_result', side_effect=worker):
                    result = dynamic_tracer.trace_function('neutral.py', 'target', [[1]],
                        planning_timeout_seconds=requested, case_timeout_seconds=0.25, total_timeout_seconds=3)
                self.assertEqual(calls, [('plan', 3.0)])
                self.assertEqual(result['planning']['configured_timeout_seconds'], configured)
                self.assertEqual(result['planning']['allocated_timeout_seconds'], 3)
                self.assertEqual(result['planning']['status'], 'timeout')
                self.assertEqual(result['examples'], [])
                self.assertEqual(result['errors'], [])
                self.assertEqual(result['cases'][0]['status'], 'not_started')
                self.assertFalse(result['complete'])

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

    def test_total_deadline_timeout_latches_exhaustion_when_worker_returns_before_clock_deadline(self):
        for planning_seconds, configured_case, total_seconds in ((2.0, 0.25, 3.0), (0.25, 0.5, 1.0)):
            with self.subTest(planning=planning_seconds, total=total_seconds), \
                    tempfile.TemporaryDirectory(prefix='neutral-trace-deadline-') as directory:
                clock = [0.0]
                calls = []
                planned_inputs = [snapshot_value([number]) for number in (1, 2, 3)]

                def worker(payload, timeout):
                    calls.append((payload['mode'], timeout))
                    if payload['mode'] == 'plan':
                        clock[0] += planning_seconds
                        return {'args': ['value'], 'load_error': None, 'planned_inputs': planned_inputs}
                    # Windows subprocess timeout rounding can report expiry while
                    # monotonic() still shows a fraction of a millisecond left.
                    clock[0] += max(0, timeout - 0.0005)
                    raise subprocess.TimeoutExpired('neutral early-expiry worker', timeout)

                progress = Path(directory) / 'progress.jsonl'
                with patch.object(dynamic_tracer.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(dynamic_tracer, '_worker_result', side_effect=worker):
                    result = dynamic_tracer.trace_function('neutral.py', 'target', [[1], [2], [3]],
                        case_timeout_seconds=configured_case, total_timeout_seconds=total_seconds,
                        progress_path=str(progress))
                events = [json.loads(line) for line in progress.read_text(encoding='utf-8').splitlines()]
                allocation = total_seconds - planning_seconds
                self.assertEqual(calls, [('plan', total_seconds), ('case', allocation)])
                self.assertLess(clock[0], total_seconds)
                self.assertEqual([case['status'] for case in result['cases']],
                                 ['timeout', 'not_started', 'not_started'])
                self.assertEqual([case['reason'] for case in result['cases']], ['total-deadline'] * 3)
                self.assertEqual([case['allocated_timeout_seconds'] for case in result['cases']],
                                 [allocation, 0, 0])
                self.assertEqual(sum(event['event'] == 'case_started' for event in events), 1)
                self.assertEqual([event['case'] for event in events if event['event'] == 'case_completed'],
                                 result['cases'])
                self.assertEqual(result['examples'], [])
                self.assertEqual(result['errors'], [])
                self.assertFalse(result['complete'])

    def test_successful_total_limited_worker_keeps_unused_time_for_later_cases(self):
        clock = [0.0]
        calls = []
        planned_inputs = [snapshot_value([number]) for number in (1, 2, 3)]

        def worker(payload, timeout):
            calls.append((payload['mode'], timeout))
            if payload['mode'] == 'plan':
                clock[0] += 0.25
                return {'args': ['value'], 'load_error': None, 'planned_inputs': planned_inputs}
            clock[0] += 0.125
            return {'cases': [{'status': 'returned'}], 'examples': [], 'errors': []}

        with patch.object(dynamic_tracer.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(dynamic_tracer, '_worker_result', side_effect=worker):
            result = dynamic_tracer.trace_function('neutral.py', 'target', [[1], [2], [3]],
                                                  case_timeout_seconds=1, total_timeout_seconds=1)
        self.assertEqual(calls, [('plan', 1.0), ('case', 0.75), ('case', 0.625), ('case', 0.5)])
        self.assertEqual([case['status'] for case in result['cases']], ['returned'] * 3)
        self.assertEqual([case['allocated_timeout_seconds'] for case in result['cases']], [0.75, 0.625, 0.5])
        self.assertTrue(result['complete'])

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
