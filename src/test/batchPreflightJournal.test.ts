import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BatchJournal } from '../pipeline/batchJournal';
import { partitionBatchPreflight } from '../pipeline/batchPreflightPartition';
import { AnalysisJournal } from '../pipeline/analysisJournal';
import { createAnalysisDirectory } from '../pipeline/analysisOutput';

test('partial batch reports blocked targets as terminal environment evidence without executing or counting them as passes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-preflight-journal-'));
    try {
        const directory = path.join(root, 'results'); fs.mkdirSync(directory);
        const ready = path.join(root, 'ready.py'), blocked = path.join(root, 'blocked.py');
        fs.writeFileSync(ready, 'def target(): return 1\n'); fs.writeFileSync(blocked, 'def other(): return 2\n');
        const batch = new BatchJournal(directory, root, { model: 'fixture', buildTimestamp: 'fixture', python: 'python' });
        batch.discover(ready, ['target']); batch.discover(blocked, ['other']); batch.start();
        const partition = partitionBatchPreflight([{ id: 0, file: 'ready.py', target: 'target' }, { id: 1, file: 'blocked.py', target: 'other' }],
            [{ file: 'ready.py', status: 'loaded' }, { file: 'blocked.py', status: 'blocked', stage: 'module-import',
                issue: { kind: 'missing-dependency', issue: 'neutral_missing', advice: 'Install declared requirements.' } }],
            { actualImports: true, identityValid: true });
        const snapshot = path.join(directory, 'preflight', 'final_import_check.md');
        fs.mkdirSync(path.dirname(snapshot)); fs.writeFileSync(snapshot, 'actual final import diagnostics');
        batch.blockPreflightTargets(partition.blocked, snapshot); batch.preflight(1);
        assert.throws(() => batch.begin(1), /preflight-blocked/);
        batch.begin(0);
        const report = createAnalysisDirectory(root, 'fixed', ready, 'target', 'fixture', root, directory);
        batch.attach(0, report); fs.writeFileSync(path.join(report, 'final_report.md'), 'failed candidate');
        const journal = new AnalysisJournal(report, fs.readFileSync(ready, 'utf8'), 'target', 'fixture');
        journal.record(0, 'validation', 'failed', { category: 'validation', reason: 'failed candidate fixture' });
        journal.knowledge({ terminalStatus: 'failed', failureCategory: 'validation', failureStage: 'validation' });
        batch.refresh(0); batch.finish('completed');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.status, 'partial'); assert.equal(manifest.complete, false);
        assert.equal(manifest.expectedTargets, 2); assert.equal(manifest.finishedTargets, 2);
        assert.equal(manifest.attemptedTargets, 1); assert.equal(manifest.preflightBlockedTargets, 1);
        assert.deepEqual(manifest.statusCounts, { failed: 1, 'environment-blocked': 1 });
        assert.equal(manifest.allTargetsPassed, false); assert.equal(manifest.allTargetsExecutionVerified, false);
        assert.equal(manifest.targets[1].state, 'finished'); assert.equal(manifest.targets[1].category, 'environment');
        assert.equal(manifest.targets[1].modelRequests, 0); assert.equal(manifest.targets[1].formalRequests, 0);
        assert.equal(manifest.environmentIssues[0].issue, 'neutral_missing');
        const failure = fs.readFileSync(path.join(directory, 'failure_report.md'), 'utf8');
        assert.match(failure, /blocked\.py/); assert.match(failure, /neutral_missing/);
        assert.match(failure, /preflight\/final_import_check\.md/);
        assert.doesNotMatch(fs.readFileSync(path.join(directory, 'batch_summary.md'), 'utf8'), /blocked\.py :: other/,
            'an unattempted target belongs to the separate failure workflow, not the generated test table');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('all blocked targets finish as environment-blocked and mismatched partitions cannot mutate the inventory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-all-blocked-'));
    try {
        const directory = path.join(root, 'results'); fs.mkdirSync(directory);
        const batch = new BatchJournal(directory, root, { model: 'fixture', buildTimestamp: 'fixture', python: 'python' });
        batch.discover(path.join(root, 'sample.py'), ['one', 'two']); batch.start();
        const partition = partitionBatchPreflight([{ id: 0, file: 'sample.py', target: 'one' }, { id: 1, file: 'sample.py', target: 'two' }], [],
            { actualImports: true, identityValid: true });
        assert.throws(() => batch.blockPreflightTargets([partition.blocked[0], { ...partition.blocked[1], target: 'wrong' }]), /does not match/);
        let manifest = JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
        assert.deepEqual(manifest.statusCounts, { pending: 2 });
        assert.throws(() => batch.blockPreflightTargets(partition.blocked, path.join(root, 'external.md')), /inside this batch/);
        batch.blockPreflightTargets(partition.blocked); batch.finish('completed');
        manifest = JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.status, 'environment-blocked'); assert.equal(manifest.complete, false);
        assert.equal(manifest.finishedTargets, 2); assert.equal(manifest.attemptedTargets, 0);
        assert.equal(manifest.preflightBlockedTargets, 2); assert.equal(manifest.allTargetsPassed, false);
        assert.deepEqual(manifest.statusCounts, { 'environment-blocked': 2 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancellation remains cancellation when partial preflight evidence already exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-preflight-cancel-'));
    try {
        const directory = path.join(root, 'results'); fs.mkdirSync(directory);
        const batch = new BatchJournal(directory, root, { model: 'fixture', buildTimestamp: 'fixture', python: 'python' });
        batch.discover(path.join(root, 'sample.py'), ['one', 'two']); batch.start();
        const partition = partitionBatchPreflight([{ id: 1, file: 'sample.py', target: 'two' }], [], { actualImports: true, identityValid: true });
        batch.blockPreflightTargets(partition.blocked); batch.finish('cancelled');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.status, 'cancelled'); assert.deepEqual(manifest.statusCounts, { pending: 1, 'environment-blocked': 1 });
        assert.equal(manifest.allTargetsPassed, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
