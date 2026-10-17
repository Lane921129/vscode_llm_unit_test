import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { runExecutionVerification } from '../pipeline/executionVerification';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { createImportFixturePlan, withImportFixtures } from '../pipeline/importFixtures';
import { buildGeneratedTestEnvironment, resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const source = 'def target(value):\n    return value + 1\n';
const good = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
    + '    def test_value(self):\n        self.assertEqual(target(2), 3)\n';
const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));

function fixture(targetSource = source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-load-route-'));
    const file = path.join(root, 'sample.py'), directory = path.join(root, 'result');
    fs.writeFileSync(file, targetSource);
    const journal = new AnalysisJournal(directory, targetSource, 'target', 'scripted-routing-fixture');
    return { root, file, directory, journal, options: { file, directory, journal, target: 'target', python,
        dependencies: [], env: buildGeneratedTestEnvironment(process.env, [root]) } };
}

test('real Python generated import failure routes only to Writer and retains separate runner artifacts per candidate', async () => {
    const f = fixture();
    const roles: string[] = [], failures: string[] = [];
    const events: Array<{ stage: string; status: string; detail: unknown }> = [];
    let methodRouterCalls = 0;
    try {
        const initial = 'from absent_generated_helper_1013 import value\n' + good;
        const baseline = await runExecutionVerification({ ...f.options, generate: async () => initial, hooks: {
            validate: async () => undefined, repairRole: () => { methodRouterCalls++; return 'bug-fixer'; },
            revise: async (_code, failure, role) => { roles.push(role); failures.push(failure); return good; },
            event: (stage, status, detail) => events.push({ stage, status, detail })
        } });
        assert.deepEqual(roles, ['writer']);
        assert.equal(methodRouterCalls, 0, 'verified loader classification cannot be overridden by a method router');
        assert.match(failures[0], /No module named 'absent_generated_helper_1013'/);
        assert.doesNotMatch(failures[0], /Target invocation test identity mismatch/);
        assert.equal(verifyExecutionEvidence(f.directory, f.file, baseline,
            { runId: f.journal.runId, sourceHash: f.journal.sourceHash, target: 'target' }), true);
        const results = fs.readdirSync(f.directory).filter(name => /^runner_\d+\.jsonl$/.test(name))
            .map(name => JSON.parse(fs.readFileSync(path.join(f.directory, name), 'utf8')));
        assert.equal(results.length, 2);
        assert.equal(results[0].loadDiagnostics.reasonCode, 'generated-test-load-failed');
        assert.equal(results[1].status, 'passed');
        assert.notEqual(results[0].identity.testRunId, results[1].identity.testRunId);
        assert.notEqual(results[0].identity.testHash, results[1].identity.testHash);
        assert.equal(results[0].identity.sourceHash, f.journal.sourceHash);
        assert.equal(results[1].identity.testHash, baseline.testHash);
        const diagnostic = events.find(event => event.stage === 'generated-test-runner');
        assert.equal(diagnostic?.status, 'load-failed');
        assert.equal((diagnostic?.detail as { testHash: string }).testHash, evidenceHash(initial));
        assert.equal(fs.readFileSync(f.file, 'utf8'), source);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a real candidate decorator initialization error reaches Writer with failing load evidence before any baseline exists', async () => {
    const f = fixture(), roles: string[] = [], failures: string[] = [];
    let methodRouterCalls = 0;
    const initial = 'import unittest\nfrom unittest.mock import patch\nfrom sqlite3 import Connection\nfrom sample import target\n'
        + 'class Cases(unittest.TestCase):\n'
        + '    @patch("sample.connection", return_value=Connection())\n'
        + '    def test_value(self, connection):\n        self.assertEqual(target(2), 3)\n';
    try {
        const baseline = await runExecutionVerification({ ...f.options, generate: async () => initial, hooks: {
            validate: async () => undefined, repairRole: () => { methodRouterCalls++; return 'bug-fixer'; },
            revise: async (_code, failure, role) => {
                roles.push(role); failures.push(failure);
                assert.equal(fs.existsSync(path.join(f.directory, 'execution_baseline.json')), false);
                return good;
            }, event: () => {}
        } });
        assert.deepEqual(roles, ['writer']);
        assert.equal(methodRouterCalls, 0);
        assert.match(failures[0], /TypeError/);
        assert.match(failures[0], /module\/class setup shown in the actual failure/);
        assert.match(failures[0], /decorator arguments and fixture construction/);
        assert.doesNotMatch(failures[0], /Target invocation test identity mismatch/);
        const results = fs.readdirSync(f.directory).filter(name => /^runner_\d+\.jsonl$/.test(name))
            .map(name => JSON.parse(fs.readFileSync(path.join(f.directory, name), 'utf8')));
        assert.equal(results.length, 2);
        assert.equal(results[0].status, 'runner-error');
        assert.equal(results[0].loadDiagnostics.reasonCode, 'generated-test-load-failed');
        assert.equal(results[0].testsRun, 1);
        assert.deepEqual(results[0].testFailures, [{ testId: null, kind: 'error', phase: 'fixture-or-load' }]);
        assert.equal(results[1].status, 'passed');
        assert.notEqual(results[0].identity.testRunId, results[1].identity.testRunId);
        assert.notEqual(results[0].identity.testHash, results[1].identity.testHash);
        assert.equal(results[1].identity.testHash, baseline.testHash);
        assert.equal(verifyExecutionEvidence(f.directory, f.file, baseline,
            { runId: f.journal.runId, sourceHash: f.journal.sourceHash, target: 'target' }), true);
        assert.equal(fs.readFileSync(f.file, 'utf8'), source);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('verified pure loader classification bypasses method guessing and arithmetic rewrites, then resets on a genuine test failure', async () => {
    const roles: string[] = [];
    let executions = 0, arithmeticCalls = 0;
    const failure = 'FAIL: test_value (Cases.test_value)\nAssertionError: expected two';
    const candidate = await validateTestCandidate('first', {
        reviewRequired: false, checkCancelled: () => {}, event: () => {}, validate: async () => undefined,
        review: async () => undefined, repairRole: () => 'bug-fixer',
        repairExpectations: async () => { arithmeticCalls++; return undefined; },
        revise: async (_code, _failure, role, attempt) => { roles.push(role); return 'candidate-' + attempt; },
        execute: async () => {
            executions++;
            if (executions === 1) { return { ok: false, out: 'runner load failed', qualityGaps: [], repairRole: 'writer' }; }
            if (executions === 2) { return { ok: false, out: failure, qualityGaps: [] }; }
            return { ok: true, out: 'test_value (Cases.test_value) ... ok\nRan 1 test\nOK', qualityGaps: [] };
        }
    }, 2);
    assert.equal(candidate.code, 'candidate-2');
    assert.deepEqual(roles, ['writer', 'bug-fixer']);
    assert.equal(arithmeticCalls, 1, 'only the genuine method failure can request arithmetic assistance');
});

test('identity mismatch, unavailable loader and stale artifact diagnostics stop before any repair request', async t => {
    const runner = require('../utils/processRunner') as typeof import('../utils/processRunner');
    for (const mode of ['identity', 'loader', 'stale', 'zero-exit'] as const) {
        const f = fixture();
        let revisions = 0;
        const mocked = t.mock.method(runner, 'runSpawn', async (_python: string, args: string[]) => {
            const value = (name: string) => args[args.indexOf(name) + 1];
            const testFile = value('--target-test-file'), testRunId = value('--target-run-id');
            const identity = { version: 'generated-test-result-identity-v1', testRunId,
                canonicalFile: f.file, canonicalTestFile: testFile, target: 'target',
                sourceHash: evidenceHash(source), testHash: evidenceHash(fs.readFileSync(testFile, 'utf8')) };
            const pureLoad = mode === 'zero-exit';
            const result = { schemaVersion: 'generated-test-result-v1', status: 'runner-error', identity,
                testsRun: pureLoad ? 1 : 0,
                testFailures: pureLoad ? [{ testId: null, kind: 'error', phase: 'fixture-or-load' }] : [],
                loadDiagnostics: { version: 'generated-test-load-diagnostics-v1',
                    reasonCode: pureLoad ? 'generated-test-load-failed'
                        : mode === 'identity' ? 'generated-test-identity-mismatch' : 'generated-test-loader-error',
                    failedTests: pureLoad ? 1 : 0, truncated: false } };
            const invocation = { schemaVersion: 'target-invocation-v1', ...identity, status: 'failed', observed: false,
                profileIntact: true, targetCodeHash: 'b'.repeat(64), testResult: pureLoad ? {
                    testsRun: 1, failures: 0, errors: 1, skipped: 0, expectedFailures: 0, unexpectedSuccesses: 0 } : null,
                ...(mode === 'stale' ? { testRunId: 'previous-candidate' } : {}) };
            fs.writeFileSync(value('--result-json'), JSON.stringify(result));
            fs.writeFileSync(value('--target-evidence'), JSON.stringify(invocation));
            return { code: pureLoad ? 0 : 1, stdout: '', stderr: 'runner internal private detail' };
        });
        try {
            await assert.rejects(runExecutionVerification({ ...f.options, generate: async () => good, hooks: {
                validate: async () => undefined, revise: async () => { revisions++; return good; }, event: () => {}
            } }), (error: unknown) => error instanceof AnalysisStageError && error.stage === 'generated-test-runner'
                && !error.message.includes('private detail'));
            assert.equal(revisions, 0);
            assert.equal(fs.existsSync(path.join(f.directory, 'execution_baseline.json')), false);
        } finally { mocked.mock.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
    }
});

test('real verified resource failure wins over a malformed loader artifact and never requests candidate repair', async t => {
    const databaseSource = 'import sqlite3\nfrom pathlib import Path\nDB = Path(__file__).parent / "data.db"\n'
        + 'def target():\n    with sqlite3.connect(DB) as connection:\n        return connection.execute("SELECT value FROM missing").fetchone()[0]\n';
    const f = fixture(databaseSource);
    const runner = require('../utils/processRunner') as typeof import('../utils/processRunner');
    const original = runner.runSpawn;
    let repairs = 0;
    const mocked = t.mock.method(runner, 'runSpawn', async (...args: Parameters<typeof runner.runSpawn>) => {
        const run = await original(...args);
        const index = args[1].indexOf('--result-json');
        if (index >= 0) {
            const resultFile = args[1][index + 1];
            const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
            fs.writeFileSync(resultFile, JSON.stringify({ ...result, loadDiagnostics: { unknownPrivateField: 'invalid' } }));
        }
        return run;
    });
    try {
        const plan = createImportFixturePlan(f.root, [{ file: 'sample.py', resourceSourceHash: evidenceHash(databaseSource),
            resources: [{ path: 'data.db', kind: 'sqlite', tables: [] }] }])!;
        const code = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
            + '    def test_schema(self):\n        with self.assertRaises(Exception):\n            target()\n';
        await assert.rejects(withImportFixtures(plan, () => runExecutionVerification({ ...f.options,
            env: buildGeneratedTestEnvironment(process.env, [f.root]),
            generate: async () => code, hooks: { validate: async () => undefined,
                revise: async () => { repairs++; return code; }, event: () => {} }
        })), (error: unknown) => error instanceof AnalysisStageError && error.category === 'environment'
            && error.stage === 'resource-setup');
        assert.equal(repairs, 0);
        assert.equal(fs.existsSync(path.join(f.directory, 'execution_baseline.json')), false);
        assert.equal(fs.existsSync(path.join(f.root, 'data.db')), false);
    } finally { mocked.mock.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
