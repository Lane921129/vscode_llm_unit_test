"""Run generated unittest code under a process-local external-operation guard.

The guard supplements AST validation; it is not an OS sandbox for hostile native
extensions. Coverage starts/saves outside the guarded application execution.
"""
import argparse
from contextlib import contextmanager, nullcontext
import json
import os
import sys
import unittest
from uuid import uuid4
from target_invocation import TargetInvocationTracker
from runtime_policy import ISOLATION_EXIT_CODE, ISOLATION_MARKER, POLICY_VERSION, RuntimePolicyError, BackgroundExecutionError, guarded_runtime


_target_tracking = False


class TestIsolationError(RuntimePolicyError):
    pass


@contextmanager
def guarded_test_runtime():
    with guarded_runtime(error_type=TestIsolationError, protect_profile=_target_tracking) as violations:
        yield violations


def main(argv=None):
    global _target_tracking
    parser = argparse.ArgumentParser()
    parser.add_argument('test_module')
    parser.add_argument('--coverage-source')
    parser.add_argument('--violation-report')
    parser.add_argument('--target-file')
    parser.add_argument('--target-name')
    parser.add_argument('--target-evidence')
    parser.add_argument('--target-run-id')
    parser.add_argument('--target-test-file')
    parser.add_argument('-v', '--verbose', action='store_true')
    args = parser.parse_args(argv)
    run_id = uuid4().hex
    target_options = [args.target_file, args.target_name, args.target_evidence, args.target_run_id, args.target_test_file]
    if any(target_options) and not all(target_options):
        parser.error('Target invocation evidence requires all five --target-* options.')
    tracker = TargetInvocationTracker(args.target_file, args.target_name, args.target_test_file,
                                      args.target_run_id) if all(target_options) else None
    if tracker:
        tracker.save(args.target_evidence, 'running')

    def record(event, **detail):
        if args.violation_report:
            with open(args.violation_report, 'a', encoding='utf-8') as report:
                report.write(json.dumps({'runId': run_id, 'event': event, 'policyVersion': POLICY_VERSION, **detail}) + '\n')

    # An engine that fails to invoke/finish its guarded runner cannot certify
    # isolation merely because no violation file appeared.
    record('started')
    sys.dont_write_bytecode = True
    # Script execution otherwise places the extension's tool folder first.
    sys.path.insert(0, os.getcwd())
    coverage = None
    if args.coverage_source:
        from coverage import Coverage
        coverage = Coverage(branch=True, source=[args.coverage_source], config_file=False)
        coverage.start()
    exit_code = 1
    violation = None
    observation = tracker.observe() if tracker else nullcontext()
    try:
        with observation:
            _target_tracking = bool(tracker)
            with guarded_test_runtime() as violations:
                suite = unittest.defaultTestLoader.loadTestsFromName(args.test_module)
                if tracker:
                    if not tracker.matches_test_module(args.test_module):
                        raise RuntimeError('Target invocation test identity mismatch')
                    tracker.testing = True
                result = unittest.TextTestRunner(verbosity=2 if args.verbose else 1).run(suite)
                exit_code = 0 if result.wasSuccessful() and result.testsRun > 0 else 1
    except TestIsolationError:
        violation = violations[0] if violations else 'external operation'
    except BackgroundExecutionError as error:
        print(str(error), file=sys.stderr)
        exit_code = 1
    except SystemExit:
        # A test calling sys.exit(0) is not a successful unittest result.
        exit_code = 1
    finally:
        _target_tracking = False
        if coverage:
            coverage.stop()
            coverage.save()
        if tracker:
            tracker.save(args.target_evidence, 'passed' if exit_code == 0 and not violation else 'failed',
                         coverage.get_data().data_filename() if coverage else None)
    if violation:
        print(f'{ISOLATION_MARKER}: {violation}; mock the dependency at its target use point.', file=sys.stderr)
        record('completed', status='isolation-blocked', operation=violation)
        return ISOLATION_EXIT_CODE
    record('completed', status='passed' if exit_code == 0 else 'failed')
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
