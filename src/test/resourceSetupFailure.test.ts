import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { createImportFixturePlan, withImportFixtures } from '../pipeline/importFixtures';
import { readResourceSetupFailure, ResourceSetupFailureIdentity } from '../pipeline/resourceSetupFailure';
import { runExecutionVerification } from '../pipeline/executionVerification';
import { buildGeneratedTestEnvironment, resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { AnalysisStageError } from '../utils/executionFailureCategory';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-failure-'));
    const sourceFile = path.join(root, 'sample.py'), testFile = path.join(root, 'generated.py');
    fs.writeFileSync(sourceFile, 'def target(): return 1\n');
    fs.writeFileSync(testFile, 'import unittest\n');
    const expected: ResourceSetupFailureIdentity = { isolationFile: path.join(root, 'isolation.jsonl'), sourceFile, testFile,
        targetRunId: 'test-run-1', sourceHash: evidenceHash(fs.readFileSync(sourceFile, 'utf8')),
        testHash: evidenceHash(fs.readFileSync(testFile, 'utf8')), importFixturePlanId: 'c'.repeat(64), exitCode: 86 };
    const common = { runId: 'a'.repeat(32), policyVersion: 'python-execution-policy-v1', targetRunId: expected.targetRunId,
        sourceHash: expected.sourceHash, testHash: expected.testHash };
    const started = { ...common, event: 'started', importFixtures: null };
    const completed = { ...common, event: 'completed', status: 'isolation-blocked', operation: 'resource-schema-required',
        importFixtures: { id: expected.importFixturePlanId, resources: {
            planId: expected.importFixturePlanId, scope: 'fresh-process', resourceCount: 1, operations: { 'sqlite3.connect': 1 } } } };
    const save = (events: unknown[] = [started, completed]) => fs.writeFileSync(expected.isolationFile, events.map(value => JSON.stringify(value)).join('\n') + '\n');
    save();
    return { root, expected, started, completed, save };
}

test('resource schema routing accepts only exact current runner and resource identities', () => {
    const f = fixture();
    try {
        assert.deepEqual(readResourceSetupFailure(f.expected), { category: 'environment', stage: 'resource-setup',
            reasonCode: 'resource-schema-required', targetRunId: f.expected.targetRunId,
            sourceHash: f.expected.sourceHash, testHash: f.expected.testHash, importFixturePlanId: f.expected.importFixturePlanId });
        for (const change of [{ targetRunId: 'other' }, { sourceHash: 'd'.repeat(64) }, { testHash: 'd'.repeat(64) },
            { importFixturePlanId: 'd'.repeat(64) }, { importFixturePlanId: undefined }, { exitCode: 1 }, { exitCode: null }]) {
            assert.equal(readResourceSetupFailure({ ...f.expected, ...change }), undefined);
        }
        for (const change of [{ runId: 'b'.repeat(32) }, { targetRunId: 'other' }, { sourceHash: 'd'.repeat(64) },
            { testHash: 'd'.repeat(64) }, { policyVersion: 'unknown' }]) {
            f.save([f.started, { ...f.completed, ...change }]);
            assert.equal(readResourceSetupFailure(f.expected), undefined);
        }
        f.save(); fs.appendFileSync(f.expected.sourceFile, '# changed source\n');
        assert.equal(readResourceSetupFailure(f.expected), undefined);
        fs.writeFileSync(f.expected.sourceFile, 'def target(): return 1\n');
        fs.appendFileSync(f.expected.testFile, '# changed candidate\n');
        assert.equal(readResourceSetupFailure(f.expected), undefined);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('ordinary isolation, traceback mentions and incomplete evidence never become schema diagnoses', () => {
    const f = fixture();
    try {
        for (const change of [{ operation: 'non-isolated SQLite connection' }, { operation: 'prefix resource-schema-required' },
            { status: 'failed' }, { status: 'passed' }, { event: 'started' }, { importFixtures: null },
            { importFixtures: { id: 'd'.repeat(64), resources: f.completed.importFixtures.resources } },
            { importFixtures: { ...f.completed.importFixtures, resources: { ...f.completed.importFixtures.resources, planId: 'd'.repeat(64) } } },
            { importFixtures: { ...f.completed.importFixtures, resources: { ...f.completed.importFixtures.resources, resourceCount: 0 } } }]) {
            f.save([f.started, { ...f.completed, ...change, traceback: 'resource-schema-required' }]);
            assert.equal(readResourceSetupFailure(f.expected), undefined);
        }
        for (const events of [[f.completed], [f.started], [f.started, f.completed, f.completed], [f.completed, f.started]]) {
            f.save(events); assert.equal(readResourceSetupFailure(f.expected), undefined);
        }
        fs.writeFileSync(f.expected.isolationFile, 'Traceback: resource-schema-required');
        assert.equal(readResourceSetupFailure(f.expected), undefined);
        fs.writeFileSync(f.expected.isolationFile, ' '.repeat(131073));
        assert.equal(readResourceSetupFailure(f.expected), undefined);
        fs.unlinkSync(f.expected.isolationFile);
        assert.equal(readResourceSetupFailure(f.expected), undefined);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('execution verification stops a real missing-schema runner verdict before requesting AI repair', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-execution-route-'));
    const file = path.join(root, 'sample.py'), directory = path.join(root, 'result');
    const source = 'import sqlite3\nfrom pathlib import Path\nDB = Path(__file__).parent / "data.db"\n'
        + 'def target():\n    with sqlite3.connect(DB) as connection:\n        return connection.execute("SELECT value FROM missing").fetchone()[0]\n';
    const code = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
        + '    def test_schema(self):\n        with self.assertRaises(Exception):\n            target()\n';
    try {
        fs.writeFileSync(file, source);
        const plan = createImportFixturePlan(root, [{ file: 'sample.py', resourceSourceHash: evidenceHash(source),
            resources: [{ path: 'data.db', kind: 'sqlite', tables: [] }] }])!;
        const journal = new AnalysisJournal(directory, source, 'target', 'fixture-model');
        let repairs = 0;
        await assert.rejects(withImportFixtures(plan, () => runExecutionVerification({ directory, file, target: 'target',
            python: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')),
            env: buildGeneratedTestEnvironment(process.env, [root]), dependencies: [], journal,
            generate: async () => code,
            hooks: { validate: async () => undefined, revise: async () => { repairs++; return code; },
                repairRole: () => 'bug-fixer', validateRevision: async () => undefined, event: () => {} }
        })), (error: unknown) => error instanceof AnalysisStageError && error.category === 'environment'
            && error.stage === 'resource-setup' && (error.diagnostic as { reasonCode: string }).reasonCode === 'resource-schema-required');
        assert.equal(repairs, 0);
        assert.equal(fs.existsSync(path.join(directory, 'execution_baseline.json')), false);
        assert.equal(fs.existsSync(path.join(root, 'data.db')), false);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
