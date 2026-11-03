import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readGeneratedRunnerDiagnostics, GeneratedRunnerDiagnosticIdentity } from '../pipeline/generatedRunnerDiagnostics';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-diagnostics-'));
    const sourceFile = path.join(root, 'sample.py'), testFile = path.join(root, 'generated.py');
    fs.writeFileSync(sourceFile, 'def target(): return 1\n');
    fs.writeFileSync(testFile, 'import unittest\n');
    const expected: GeneratedRunnerDiagnosticIdentity = { resultFile: path.join(root, 'result.json'),
        invocationFile: path.join(root, 'invocation.json'), sourceFile, testFile, target: 'target', testRunId: 'runner-test-1',
        sourceHash: digest(sourceFile), testHash: digest(testFile) };
    const identity = { version: 'generated-test-result-identity-v1', testRunId: expected.testRunId,
        canonicalFile: sourceFile, canonicalTestFile: testFile, target: expected.target,
        sourceHash: expected.sourceHash, testHash: expected.testHash };
    const invocation = { schemaVersion: 'target-invocation-v1', ...identity, status: 'failed',
        observed: false, profileIntact: true, targetCodeHash: 'a'.repeat(64), coverageDataHash: null,
        testResult: { testsRun: 1, failures: 0, errors: 1, skipped: 0, expectedFailures: 0, unexpectedSuccesses: 0 } };
    const result = { schemaVersion: 'generated-test-result-v1', status: 'runner-error', testsRun: 1,
        testFailures: [{ testId: null, kind: 'error', phase: 'fixture-or-load' }], identity,
        loadDiagnostics: { version: 'generated-test-load-diagnostics-v1', reasonCode: 'generated-test-load-failed',
            failedTests: 1, truncated: false } };
    const save = (nextResult: unknown = result, nextInvocation: unknown = invocation) => {
        fs.writeFileSync(expected.resultFile, JSON.stringify(nextResult));
        fs.writeFileSync(expected.invocationFile, JSON.stringify(nextInvocation));
    };
    save();
    return { root, expected, identity, invocation, result, save };
}

const rejects = (callback: () => unknown) => assert.throws(callback,
    (error: unknown) => error instanceof AnalysisStageError && error.category === 'validation'
        && error.stage === 'generated-test-runner'
        && (error.diagnostic as { reasonCode: string }).reasonCode === 'generated-test-diagnostics-invalid');

test('only current identity-bound pure loader failures authorize Writer repair', () => {
    const f = fixture();
    try {
        assert.deepEqual(readGeneratedRunnerDiagnostics(f.expected), { ...f.result.loadDiagnostics, repairRole: 'writer',
            target: f.expected.target, testRunId: f.expected.testRunId, sourceHash: f.expected.sourceHash, testHash: f.expected.testHash });
        for (const change of [{ testRunId: 'other-run' }, { sourceHash: 'b'.repeat(64) }, { testHash: 'b'.repeat(64) },
            { target: 'Class.target' }]) { rejects(() => readGeneratedRunnerDiagnostics({ ...f.expected, ...change })); }
        for (const change of [{ testRunId: 'other-run' }, { target: 'other' }, { sourceHash: 'b'.repeat(64) },
            { testHash: 'b'.repeat(64) }, { canonicalFile: f.expected.testFile }, { canonicalTestFile: f.expected.sourceFile },
            { canonicalFile: '\\\\unapproved-host\\private\\source.py' }]) {
            f.save({ ...f.result, identity: { ...f.identity, ...change } });
            rejects(() => readGeneratedRunnerDiagnostics(f.expected));
            f.save(f.result, { ...f.invocation, ...change });
            rejects(() => readGeneratedRunnerDiagnostics(f.expected));
        }
        f.save();
        fs.appendFileSync(f.expected.sourceFile, '# source drift\n');
        rejects(() => readGeneratedRunnerDiagnostics(f.expected));
        fs.writeFileSync(f.expected.sourceFile, 'def target(): return 1\n');
        fs.appendFileSync(f.expected.testFile, '# test drift\n');
        rejects(() => readGeneratedRunnerDiagnostics(f.expected));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('identity and direct loader errors remain framework stops', () => {
    const f = fixture();
    try {
        for (const reasonCode of ['generated-test-identity-mismatch', 'generated-test-loader-error']) {
            f.save({ ...f.result, testsRun: 0, testFailures: [],
                loadDiagnostics: { ...f.result.loadDiagnostics, reasonCode, failedTests: 0 } },
            { ...f.invocation, testResult: null });
            assert.equal(readGeneratedRunnerDiagnostics(f.expected)?.repairRole, 'none');
            assert.equal(readGeneratedRunnerDiagnostics(f.expected)?.reasonCode, reasonCode);
        }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('test failures, successes, partial counts and unverified invocation cannot become loader repair', () => {
    const f = fixture();
    try {
        for (const change of [{ status: 'passed' }, { profileIntact: false }, { observed: true },
            { targetCodeHash: 'invalid' }, { testResult: null },
            { testResult: { ...f.invocation.testResult, testsRun: 2 } },
            { testResult: { ...f.invocation.testResult, skipped: 1 } }]) {
            f.save(f.result, { ...f.invocation, ...change }); rejects(() => readGeneratedRunnerDiagnostics(f.expected));
        }
        for (const change of [{ status: 'passed' }, { status: 'failed' }, { status: 'isolation-blocked' },
            { testsRun: 0 }, { testFailures: [] },
            { testFailures: [{ testId: 'generated.Cases.test_case', kind: 'failure', phase: 'test' }] },
            { identity: undefined }]) {
            f.save({ ...f.result, ...change }); rejects(() => readGeneratedRunnerDiagnostics(f.expected));
        }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('unknown, truncated or text-bearing diagnostics fail closed without exposing text', () => {
    const f = fixture();
    try {
        for (const diagnostic of [null, 'loader failed', {}, { ...f.result.loadDiagnostics, reasonCode: 'MissingDependency' },
            { ...f.result.loadDiagnostics, failedTests: -1 }, { ...f.result.loadDiagnostics, failedTests: 33 },
            { ...f.result.loadDiagnostics, failedTests: 1.5 }, { ...f.result.loadDiagnostics, truncated: true },
            { ...f.result.loadDiagnostics, error: 'private-provider-detail' }]) {
            f.save({ ...f.result, loadDiagnostics: diagnostic }); rejects(() => readGeneratedRunnerDiagnostics(f.expected));
        }
        fs.writeFileSync(f.expected.resultFile, '{broken'); rejects(() => readGeneratedRunnerDiagnostics(f.expected));
        fs.writeFileSync(f.expected.resultFile, 'x'.repeat(131073)); rejects(() => readGeneratedRunnerDiagnostics(f.expected));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('legacy absent or empty runner results do not invent a diagnosis', () => {
    const f = fixture();
    try {
        for (const result of [{}, { schemaVersion: 'generated-test-result-v1', status: 'failed', error: 'identity mismatch' }]) {
            f.save(result); assert.equal(readGeneratedRunnerDiagnostics(f.expected), undefined);
        }
        fs.writeFileSync(f.expected.resultFile, ''); assert.equal(readGeneratedRunnerDiagnostics(f.expected), undefined);
        fs.unlinkSync(f.expected.resultFile); assert.equal(readGeneratedRunnerDiagnostics(f.expected), undefined);
        f.save(); fs.unlinkSync(f.expected.invocationFile); rejects(() => readGeneratedRunnerDiagnostics(f.expected));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('real Python loader artifacts bind native paths and preserve original import cause', () => {
    const f = fixture();
    try {
        fs.writeFileSync(f.expected.testFile, 'import unittest\nfrom absent_generated_helper_1013 import DB_NAME\n'
            + 'from sample import target\nclass Cases(unittest.TestCase):\n    def test_case(self):\n        self.assertEqual(target(), 1)\n');
        f.expected.testHash = digest(f.expected.testFile);
        const project = path.resolve(__dirname, '../..');
        const python = resolvePythonExecutable(undefined, project);
        const run = spawnSync(python, ['-B', path.join(project, 'python_scripts/generated_test_runner.py'), 'generated',
            '--result-json', f.expected.resultFile, '--target-file', f.expected.sourceFile,
            '--target-name', f.expected.target, '--target-evidence', f.expected.invocationFile,
            '--target-run-id', f.expected.testRunId, '--target-test-file', f.expected.testFile],
        { cwd: f.root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 20000 });
        assert.equal(run.status, 1, run.stderr);
        assert.match(run.stderr, /No module named 'absent_generated_helper_1013'/);
        assert.doesNotMatch(run.stderr, /Target invocation test identity mismatch/);
        assert.equal(readGeneratedRunnerDiagnostics(f.expected)?.repairRole, 'writer');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
