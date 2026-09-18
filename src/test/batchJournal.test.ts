import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BatchJournal } from '../pipeline/batchJournal';
import { createAnalysisDirectory, createBatchDirectory } from '../pipeline/analysisOutput';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';

test('batch inventory distinguishes completion, verified passes, skips and incomplete provenance across reruns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-journal-'));
    try {
        const directory = createBatchDirectory(root, 'fixed-minute', 'project');
        const second = createBatchDirectory(root, 'fixed-minute', 'project');
        assert.equal(second, directory + '__run2');
        const batch = new BatchJournal(directory, root, { model: 'fixture', buildTimestamp: 'build', python: 'python' });
        const file = path.join(root, 'pkg', 'sample.py');
        const names = ['good', 'missing', 'stub', 'unknown_review', 'changed_code', 'wrong_run', 'still_running', 'dummy', 'missing_execution'];
        batch.discover(file, names);
        batch.start();
        const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
        assert.equal(read().expectedTargets, names.length);
        assert.equal(read().finishedTargets, 0);
        const code = 'import unittest\n';
        names.forEach((name, id) => {
            batch.begin(id);
            const targetDir = createAnalysisDirectory(root, 'fixed-minute', file, name, 'project', root, directory);
            batch.attach(id, targetDir);
            if (name !== 'missing') { fs.writeFileSync(path.join(targetDir, 'final_report.md'), 'report'); }
            if (name === 'dummy') { batch.dummy(id); batch.refresh(id); return; }
            const journal = new AnalysisJournal(targetDir, 'source', name, 'fixture');
            journal.record(0, 'pipeline', 'running', {});
            journal.knowledge({ terminalStatus: name === 'stub' ? 'stub-smoke-generated' : name === 'still_running' ? 'running' : 'passed',
                acceptedTest: 'loop1_test.py', acceptedCodeHash: evidenceHash(code), qualityGaps: [],
                execution: name === 'missing_execution' ? undefined : 'Ran 1 test\nOK', mutationScore: 100, survivors: [],
                reviewStatus: name === 'unknown_review' ? 'incomplete' : 'completed' });
            fs.writeFileSync(path.join(targetDir, 'loop1_test.py'), name === 'changed_code' ? 'changed' : code);
            if (name === 'wrong_run') {
                const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'run_manifest.json'), 'utf8'));
                fs.writeFileSync(path.join(targetDir, 'run_manifest.json'), JSON.stringify({ ...manifest, runId: 'another-run' }));
            }
            batch.refresh(id);
        });
        batch.finish('completed');
        const result = read();
        assert.equal(result.status, 'incomplete');
        assert.equal(result.complete, false);
        assert.equal(result.allTargetsPassed, false);
        assert.equal(result.finishedTargets, 3);
        assert.deepEqual(result.statusCounts, { passed: 1, 'incomplete-report': 6, 'stub-smoke-generated': 1, 'dummy-skipped': 1 });
        assert.ok(result.targets.every((target: any) => target.file === 'pkg/sample.py' && !path.isAbsolute(target.reportDirectory)));
        assert.throws(() => batch.discover(path.join(root, '..', 'outside.py'), ['target']));
        assert.throws(() => batch.attach(0, second));
        assert.equal(fs.readdirSync(second).length, 0, 'a new batch never inherits old results');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('batch cancellation and discovery failures preserve pending work without claiming a complete run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-pending-'));
    try {
        const batch = new BatchJournal(root, root, { model: 'fixture', buildTimestamp: 'build', python: 'python' });
        batch.discover(path.join(root, 'sample.py'), ['Target.method', 'Target.method']);
        batch.discoveryFailed(path.join(root, 'broken.py'), 'ast-discovery');
        batch.start(); batch.begin(0); batch.finish('cancelled');
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.status, 'cancelled');
        assert.equal(manifest.expectedTargets, 2, 'duplicate discovered attempts must stay visible');
        assert.deepEqual(manifest.statusCounts, { running: 1, pending: 1 });
        assert.equal(manifest.complete, false);
        assert.equal(manifest.discoveryFailures[0].file, 'broken.py');
        assert.match(fs.readFileSync(path.join(root, 'batch_summary.md'), 'utf8'), /無法掃描 broken.py/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
