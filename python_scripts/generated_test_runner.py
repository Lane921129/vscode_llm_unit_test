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
from import_fixtures import evidence as import_fixture_evidence
from runtime_policy import ISOLATION_EXIT_CODE, ISOLATION_MARKER, POLICY_VERSION, RuntimePolicyError, BackgroundExecutionError, guarded_runtime


_target_tracking = False


def _safe_test_id(test):
    if not isinstance(test, unittest.TestCase) or isinstance(test, unittest.loader._FailedTest):
        return None
    identifier = unittest.TestCase.id(test)
    return identifier if len(identifier) <= 1024 and all(part.isidentifier() for part in identifier.split('.')) else None


class StructuredTestResult(unittest.TextTestResult):
    """Record identifiers only; exception text and subTest values stay private."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.test_failures = []

    def _record(self, test, kind, err=None):
        identifier = _safe_test_id(test)
        fixture = False
        traceback = err[2] if err else None
        frames = []
        while traceback is not None:
            frames.append(traceback.tb_frame)
            traceback = traceback.tb_next
        # subTest catches the error inside setUp/tearDown, so those frames may
        # still be on the active stack instead of the exception traceback.
        frame = sys._getframe()
        while frame is not None:
            frames.append(frame)
            frame = frame.f_back
        for frame in frames:
            if (frame.f_globals.get('__name__') in ('unittest.case', 'unittest.async_case')
                    and frame.f_code.co_name in ('_callSetUp', '_callTearDown', '_callCleanup')):
                fixture = True
        # Avoid retaining test frames (and their argument values) in cycles.
        frames.clear()
        del frame
        self.test_failures.append({'testId': identifier, 'kind': kind,
                                   'phase': 'test' if identifier and not fixture else 'fixture-or-load'})

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._record(test, 'failure', err)

    def addError(self, test, err):
        super().addError(test, err)
        self._record(test, 'error', err)

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._record(test, 'unexpected-success')

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self._record(test, 'failure' if issubclass(err[0], test.failureException) else 'error', err)


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
    parser.add_argument('--result-json')
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
                report.write(json.dumps({'runId': run_id, 'event': event, 'policyVersion': POLICY_VERSION,
                                         'importFixtures': import_fixture_evidence(),
                                         'targetRunId': args.target_run_id,
                                         'sourceHash': tracker.source_hash if tracker else None,
                                         'testHash': tracker.test_hash if tracker else None, **detail}) + '\n')

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
    test_result = None
    structured_result = None
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
                result = unittest.TextTestRunner(verbosity=2 if args.verbose else 1,
                                                 resultclass=StructuredTestResult).run(suite)
                structured_result = result
                test_result = {'testsRun': result.testsRun, 'failures': len(result.failures),
                               'errors': len(result.errors), 'skipped': len(result.skipped),
                               'expectedFailures': len(result.expectedFailures),
                               'unexpectedSuccesses': len(result.unexpectedSuccesses)}
                exit_code = 0 if result.wasSuccessful() and result.testsRun > 0 else 1
    except TestIsolationError:
        violation = violations[0] if violations else 'external operation'
    except BackgroundExecutionError as error:
        structured_result = None
        print(str(error), file=sys.stderr)
        exit_code = 1
    except SystemExit:
        structured_result = None
        # A test calling sys.exit(0) is not a successful unittest result.
        exit_code = 1
    except Exception:
        if not args.result_json:
            raise
        structured_result = None
        # Load/setup/tool exceptions without a completed unittest result are
        # infrastructure errors, never evidence of a killing test method.
        exit_code = 1
    finally:
        _target_tracking = False
        if coverage:
            coverage.stop()
            coverage.save()
        if tracker:
            tracker.save(args.target_evidence, 'passed' if exit_code == 0 and not violation else 'failed',
                         coverage.get_data().data_filename() if coverage else None, test_result)
    if violation:
        if args.result_json:
            with open(args.result_json, 'w', encoding='utf-8') as report:
                json.dump({'schemaVersion': 'generated-test-result-v1', 'status': 'isolation-blocked',
                           'testsRun': test_result['testsRun'] if test_result else 0, 'testFailures': []}, report)
        print(f'{ISOLATION_MARKER}: {violation}; mock the dependency at its target use point.', file=sys.stderr)
        record('completed', status='isolation-blocked', operation=violation)
        return ISOLATION_EXIT_CODE
    if args.result_json:
        failures = structured_result.test_failures if structured_result else []
        status = ('passed' if exit_code == 0 else 'failed' if failures and
                  all(item['phase'] == 'test' for item in failures) else 'runner-error')
        with open(args.result_json, 'w', encoding='utf-8') as report:
            json.dump({'schemaVersion': 'generated-test-result-v1', 'status': status,
                       'testsRun': test_result['testsRun'] if test_result else 0,
                       'testFailures': failures}, report)
    record('completed', status='passed' if exit_code == 0 else 'failed')
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
