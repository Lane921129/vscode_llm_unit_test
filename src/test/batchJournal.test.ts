import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BatchJournal } from '../pipeline/batchJournal';
import { createAnalysisDirectory, createBatchDirectory } from '../pipeline/analysisOutput';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { createBatchScopeSelection } from '../pipeline/batchScope';
import { createStrictQualityPolicy } from '../pipeline/qualityPolicy';
import { CandidateCheckpointStore } from '../pipeline/candidateCheckpoint';
import { AI_WORKFLOW_VERSION } from '../pipeline/aiWorkflow';
import { SOURCE_VERSIONS_VERSION } from '../pipeline/sourceVersions';

test('batch failure limit stops dispatch after the Nth final failure and labels remaining targets as policy-not-run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-stop-policy-'));
    try {
        const directory = createBatchDirectory(root, 'fixed-minute', 'project');
        const batch = new BatchJournal(directory, root, { model: 'fixture', buildTimestamp: 'build', python: 'python',
            stopPolicy: { batchFailureLimit: 2 } });
        const file = path.join(root, 'sample.py');
        batch.discover(file, ['blocked', 'failure1', 'failure2', 'unstarted']);
        batch.start();
        for (let id = 0; id < 3; id++) {
            assert.equal(batch.stopDispatch(), false);
            batch.begin(id);
            const name = ['blocked', 'failure1', 'failure2'][id];
            const targetDir = createAnalysisDirectory(root, 'fixed-minute', file, name, 'project', root, directory);
            batch.attach(id, targetDir);
            fs.writeFileSync(path.join(targetDir, 'final_report.md'), 'failed report');
            const journal = new AnalysisJournal(targetDir, 'source', name, 'fixture');
            journal.record(0, 'pipeline', 'failed', {});
            journal.knowledge({ terminalStatus: 'failed', failureCategory: id === 0 ? 'environment' : 'validation',
                failureStage: id === 0 ? 'mutation-environment' : 'target-failure-policy',
                failureCount: id === 0 ? 0 : 5, failureLimit: 5, stopReason: id === 0 ? 'environment-blocked' : 'failure-limit' });
            batch.refresh(id);
        }
        assert.equal(batch.stopDispatch(), true);
        batch.finish('completed');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.status, 'policy-stopped');
        assert.equal(manifest.stopReason, 'batch-failure-limit');
        assert.equal(manifest.targets[3].terminalStatus, 'policy-not-run');
        assert.equal(manifest.targets[3].modelRequests, 0);
        assert.equal(manifest.attemptedTargets, 3);
        assert.equal(manifest.targets[1].failureCount, 5);
        assert.equal(manifest.allTargetsPassed, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
        assert.equal(result.finishedTargets, 2);
        // Legacy display scores lack source-dependency evidence and cannot be recertified.
        assert.deepEqual(result.statusCounts, { 'incomplete-report': 7, 'stub-smoke-generated': 1, 'dummy-skipped': 1 });
        assert.ok(result.targets.every((target: any) => target.file === 'pkg/sample.py' && !path.isAbsolute(target.reportDirectory)));
        assert.ok(result.targets.every((target: any) => target.reportDirectory.split('/').length === 2));
        assert.equal(new Set(result.targets.map((target: any) => target.reportDirectory.split('/')[0])).size, 1);
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
        assert.doesNotMatch(fs.readFileSync(path.join(root, 'batch_summary.md'), 'utf8'), /broken.py/);
        assert.match(fs.readFileSync(path.join(root, 'failure_report.md'), 'utf8'), /無法掃描 broken.py/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('batch manifest preserves confirmed source scope without counting excluded files as failed targets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-scope-journal-'));
    try {
        const batch = new BatchJournal(root, root, { model: 'fixture', buildTimestamp: 'build', python: 'python' });
        const selection = createBatchScopeSelection(root, ['main.py', 'old backup/main.py'], ['main.py']);
        batch.selectScope(selection);
        selection.selectedFiles.push('old backup/main.py');
        assert.throws(() => batch.discover(path.join(root, 'old backup', 'main.py'), ['backup_target']), /excluded/);
        batch.discover(path.join(root, 'main.py'), ['target']);
        assert.throws(() => batch.selectScope(selection), /fixed/);
        batch.finish('cancelled');
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'batch_manifest.json'), 'utf8'));
        assert.deepEqual(manifest.scope.selectedFiles, ['main.py']);
        assert.deepEqual(manifest.scope.excludedFiles, ['old backup/main.py']);
        assert.deepEqual(manifest.scope.knownFiles, ['main.py', 'old backup/main.py']);
        assert.match(manifest.scope.scopeId, /^[a-f0-9]{64}$/);
        assert.deepEqual(manifest.discoveredFiles, ['main.py']);
        assert.equal(manifest.expectedTargets, 1);
        assert.deepEqual(manifest.statusCounts, { pending: 1 });
        assert.equal(manifest.allTargetsPassed, false);
        assert.match(fs.readFileSync(path.join(root, 'batch_workflow.md'), 'utf8'), /排除的 1 個來源不列入測試目標/);
        assert.doesNotMatch(fs.readFileSync(path.join(root, 'batch_summary.md'), 'utf8'), /old backup/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('batch rejects scope from another root or a modified selection hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-scope-root-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-scope-other-'));
    try {
        const batch = new BatchJournal(root, root, { model: 'fixture', buildTimestamp: 'build', python: 'python' });
        assert.throws(() => batch.selectScope(createBatchScopeSelection(other, ['main.py'], ['main.py'])), /invalid/);
        const selection = createBatchScopeSelection(root, ['main.py', 'other.py'], ['main.py']);
        assert.throws(() => batch.selectScope({ ...selection, scopeId: '0'.repeat(64) }), /invalid/);
        assert.throws(() => batch.selectScope({ ...selection, excludedFiles: [] }), /invalid/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'batch_manifest.json'), 'utf8')).scope, undefined);
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('batch revalidates AI review approval for the retained candidate and preserves legacy readers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-review-proof-'));
    try {
        const source = 'def target(value):\n    return value + 1\n';
        const sourcePath = path.join(root, 'sample.py'); fs.writeFileSync(sourcePath, source);
        const directory = path.join(root, 'result'); fs.mkdirSync(directory);
        const policy = createStrictQualityPolicy();
        const journal = new AnalysisJournal(directory, source, 'target', 'fixture', policy);
        const code = '# immutable reader fixture\n';
        const codeHash = evidenceHash(code), sourceHash = evidenceHash(source);
        const vectors = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../contracts/quality-policy-cases-v1.json'), 'utf8'));
        const evidence = structuredClone(vectors.cases.find((item: any) => item.name === 'strict-full-success').evidence);
        Object.assign(evidence.mutation, { sourcePath, sourceHash, testHash: codeHash });
        evidence.coverage.assessment.invocationEvidence.testHash = codeHash;
        const store = new CandidateCheckpointStore(directory, sourceHash, 'target', {
            policy, sourcePath, targetScope: { kind: 'function', qualifiedName: 'target' }
        });
        const executable = store.saveExecutable({ code, execution: 'Ran 1 test\nOK',
            coverage: { coverageText: '100%', missingLines: '', assessment: evidence.coverage.assessment },
            scenarios: [], qualityGaps: [], measuredQualityGaps: [], reviewWarnings: [], reviewStatus: 'completed',
            tier: 1, generationMode: 'llm-evidence-bound', dependencyEvidenceVersion: SOURCE_VERSIONS_VERSION,
            dependencyVersions: [{ file: sourcePath, hash: sourceHash }] });
        const checkpoint = store.saveQuality(executable, evidence.mutation);
        const approval = { workflowVersion: AI_WORKFLOW_VERSION, runId: journal.runId, sourceHash,
            target: 'target', testHash: codeHash };
        journal.knowledge({ ...checkpoint, terminalStatus: 'passed', acceptedTest: checkpoint.testFile,
            acceptedCodeHash: codeHash, resolvedTier: 1, workflowVersion: AI_WORKFLOW_VERSION, reviewApproval: approval });
        journal.record(1, 'reviewer', 'approved', { testHash: codeHash });
        journal.record(1, 'model-request', 'timing', { version: 'model-request-timing-v1', kind: 'transport',
            outcome: 'completed', ollama: { completionReason: 'stop', evalCount: 24, evalDurationMs: 600 } });
        fs.writeFileSync(path.join(directory, 'final_report.md'), 'reader fixture');
        const manifestPath = path.join(directory, 'run_manifest.json'), knowledgePath = path.join(directory, 'function_knowledge.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));
        const reread = (change: (artifacts: { manifest: any; knowledge: any }) => void = () => {}) => {
            const artifacts = structuredClone({ manifest, knowledge }); change(artifacts);
            fs.writeFileSync(manifestPath, JSON.stringify(artifacts.manifest));
            fs.writeFileSync(knowledgePath, JSON.stringify(artifacts.knowledge));
            const output = path.join(root, 'batch');
            fs.mkdirSync(output, { recursive: true });
            const batch = new BatchJournal(output, root, { model: 'fixture', buildTimestamp: 'fixture', python: 'python' });
            batch.discover(sourcePath, ['target']); batch.start(); batch.begin(0);
            // The reader permits report children only; copy the same fixture into its output.
            const reportPath = path.join(output, 'target'); fs.mkdirSync(reportPath, { recursive: true });
            for (const name of fs.readdirSync(directory)) { fs.copyFileSync(path.join(directory, name), path.join(reportPath, name)); }
            batch.attach(0, reportPath); batch.refresh(0); batch.finish('completed');
            return JSON.parse(fs.readFileSync(path.join(output, 'batch_manifest.json'), 'utf8'));
        };
        const verified = reread();
        assert.equal(verified.allTargetsPassed, true);
        assert.deepEqual(verified.modelCapabilitySummary, { version: 'model-capability-summary-v1', completedTransports: 1,
            timedOutTransports: 0, lengthStoppedTransports: 0, outputTokens: 24, outputEvalMs: 600 });
        assert.equal(reread(value => { delete value.knowledge.workflowVersion; }).allTargetsPassed, true,
            'the manifest alone identifies the new workflow');
        const corruptions: Array<(value: { manifest: any; knowledge: any }) => void> = [
            value => { delete value.knowledge.reviewApproval; },
            value => { delete value.knowledge.workflowVersion; delete value.knowledge.reviewApproval; },
            ...['workflowVersion', 'runId', 'sourceHash', 'target', 'testHash'].map(field =>
                (value: { manifest: any; knowledge: any }) => { value.knowledge.reviewApproval[field] = 'wrong-identity'; }),
            value => { value.manifest.workflowVersion = 'seed-expand-v1'; }
        ];
        for (const version of ['unknown-workflow-v1', ' ', '', null, 1]) {
            corruptions.push(value => {
                value.manifest.workflowVersion = value.knowledge.workflowVersion = version;
                delete value.knowledge.reviewApproval;
            });
        }
        for (const [index, corrupt] of corruptions.entries()) {
            const result = reread(corrupt);
            assert.equal(result.allTargetsPassed, false, String(index));
            assert.equal(result.targets[0].terminalStatus, 'incomplete-report', String(index));
        }
        assert.equal(reread(value => {
            value.manifest.workflowVersion = 'seed-expand-v1'; delete value.knowledge.workflowVersion;
            delete value.knowledge.reviewApproval;
        }).allTargetsPassed, true, 'valid historical quality evidence does not require the new proof');
        assert.equal(reread(value => {
            delete value.manifest.workflowVersion; delete value.knowledge.workflowVersion;
            delete value.knowledge.reviewApproval;
        }).allTargetsPassed, true, 'legacy evidence without workflow fields retains its existing validation');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('batch_failure_summary.json and .md separate quality-passed from usable, count stage x reasonCode and role usability, and sum to expectedTargets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-failure-summary-'));
    try {
        const sourcePath = path.join(root, 'sample.py');
        const sourceText = 'def f_pass(x):\n    return x + 1\ndef f_usable(x):\n    return x * 2\ndef f_fail(x):\n    return x - 1\n';
        fs.writeFileSync(sourcePath, sourceText);
        const sourceHash = evidenceHash(sourceText);
        const policy = createStrictQualityPolicy();

        const batchDir = path.join(root, 'batch_out');
        fs.mkdirSync(batchDir, { recursive: true });
        const batch = new BatchJournal(batchDir, root, { model: 'local/gpt-oss:20b', buildTimestamp: 'fixture', python: 'python' });
        batch.discover(sourcePath, ['f_pass', 'f_usable', 'f_fail', 'f_env']);
        batch.blockPreflightTargets([{
            id: 3,
            file: 'sample.py',
            target: 'f_env',
            stage: 'module-import',
            reason: 'module-blocked',
            environment: { kind: 'missing-dependency', issue: 'requests', advice: 'pip install requests' }
        }]);
        batch.start();

        // Target 0: quality-passed
        const passDir = path.join(batchDir, 't0');
        fs.mkdirSync(passDir, { recursive: true });
        const passTest = 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(2, 2)\n';
        const passCodeHash = evidenceHash(passTest);
        const vectors = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../contracts/quality-policy-cases-v1.json'), 'utf8'));
        const passEvidence = structuredClone(vectors.cases.find((item: any) => item.name === 'strict-full-success').evidence);
        Object.assign(passEvidence.mutation, { sourcePath, sourceHash, testHash: passCodeHash,
            targetScope: { kind: 'function', qualifiedName: 'f_pass' } });
        passEvidence.coverage.assessment.invocationEvidence.testHash = passCodeHash;
        const passJournal = new AnalysisJournal(passDir, sourceText, 'f_pass', 'local/gpt-oss:20b', policy);
        const passStore = new CandidateCheckpointStore(passDir, sourceHash, 'f_pass', {
            policy, sourcePath, targetScope: { kind: 'function', qualifiedName: 'f_pass' }
        });
        const passExec = passStore.saveExecutable({ code: passTest, execution: 'Ran 1 test\nOK',
            coverage: { coverageText: '100%', missingLines: '', assessment: passEvidence.coverage.assessment },
            scenarios: [], qualityGaps: [], measuredQualityGaps: [], reviewWarnings: [], reviewStatus: 'completed',
            tier: 1, generationMode: 'llm-evidence-bound', dependencyEvidenceVersion: SOURCE_VERSIONS_VERSION,
            dependencyVersions: [{ file: sourcePath, hash: sourceHash }] });
        const passQual = passStore.saveQuality(passExec, passEvidence.mutation);
        passJournal.knowledge({ ...passQual, terminalStatus: 'passed', acceptedTest: passQual.testFile,
            acceptedCodeHash: passCodeHash, resolvedTier: 1, workflowVersion: AI_WORKFLOW_VERSION,
            reviewApproval: { workflowVersion: AI_WORKFLOW_VERSION, runId: passJournal.runId, sourceHash, target: 'f_pass', testHash: passCodeHash } });
        passJournal.record(1, 'model-request', 'requested', { role: 'writer' });
        passJournal.record(1, 'model-request', 'completed', { role: 'writer' });
        passJournal.record(1, 'model-request', 'requested', { role: 'reviewer' });
        passJournal.record(1, 'model-request', 'completed', { role: 'reviewer' });
        fs.writeFileSync(path.join(passDir, 'final_report.md'), '# Passed');
        batch.begin(0); batch.attach(0, passDir); batch.refresh(0);

        // Target 1: usable (retained executable baseline with mutation measurement, stopped at reviewer)
        const usableDir = path.join(batchDir, 't1');
        fs.mkdirSync(usableDir, { recursive: true });
        const usableJournal = new AnalysisJournal(usableDir, sourceText, 'f_usable', 'local/gpt-oss:20b', policy);
        usableJournal.knowledge({
            target: 'f_usable',
            terminalStatus: 'review-blocked',
            failureStage: 'reviewer',
            failureCategory: 'validation',
            diagnostic: { reasonCode: 'review-unavailable' },
            acceptedTest: 'exec_usable.py',
            acceptedCodeHash: passCodeHash,
            execution: 'Ran 1 test in 0.002s\n\nOK',
            coverage: { targetExecuted: true, assessment: { targetExecuted: true } },
            mutationStatus: 'complete',
            mutationScore: 80,
            retainedScore: 80,
            reviewStatus: 'incomplete'
        });
        usableJournal.record(1, 'model-request', 'requested', { role: 'writer' });
        usableJournal.record(1, 'model-request', 'completed', { role: 'writer' });
        usableJournal.record(1, 'model-request', 'requested', { role: 'reviewer' });
        usableJournal.record(1, 'model-request', 'error', { role: 'reviewer', reasonCode: 'output-token-limit' });
        fs.writeFileSync(path.join(usableDir, 'final_report.md'), '# Usable Retained');
        batch.begin(1); batch.attach(1, usableDir); batch.refresh(1);

        // Target 2: failed (no executable baseline)
        const failDir = path.join(batchDir, 't2');
        fs.mkdirSync(failDir, { recursive: true });
        const failJournal = new AnalysisJournal(failDir, sourceText, 'f_fail', 'local/gpt-oss:20b', policy);
        failJournal.knowledge({
            target: 'f_fail',
            terminalStatus: 'failed',
            failureStage: 'writer',
            failureCategory: 'model-format',
            diagnostic: { reasonCode: 'response-not-extracted-python' },
            mutationScore: null
        });
        failJournal.record(1, 'model-request', 'requested', { role: 'writer' });
        failJournal.record(1, 'model-request', 'error', { role: 'writer', reasonCode: 'response-not-extracted-python' });
        fs.writeFileSync(path.join(failDir, 'final_report.md'), '# Failed');
        batch.begin(2); batch.attach(2, failDir); batch.refresh(2);

        batch.finish('completed');

        const summaryJson = JSON.parse(fs.readFileSync(path.join(batchDir, 'batch_failure_summary.json'), 'utf8'));
        const summaryMd = fs.readFileSync(path.join(batchDir, 'batch_failure_summary.md'), 'utf8');

        assert.equal(summaryJson.schemaVersion, 'batch-failure-summary-v1');
        assert.equal(summaryJson.expectedTargets, 4);
        assert.equal(summaryJson.totalCount, 4);
        assert.equal(summaryJson.specMismatchCount, 0);
        assert.deepEqual(summaryJson.tierCounts, {
            'quality-passed': 1,
            usable: 1,
            failed: 1,
            'environment-blocked': 1,
            'tool-blocked': 0
        });
        const tierSum = Object.values(summaryJson.tierCounts as Record<string, number>).reduce((a, b) => a + b, 0);
        assert.equal(tierSum, summaryJson.expectedTargets, 'tierCounts must sum to expectedTargets');
        const stageReasonSum = (summaryJson.byStageAndReason as Array<{ count: number }>).reduce((a, b) => a + b.count, 0);
        assert.equal(summaryJson.tierCounts['quality-passed'] + stageReasonSum, summaryJson.expectedTargets,
            'quality-passed + stageReason counts must equal expectedTargets');
        assert.deepEqual(summaryJson.roleUsability.writer, {
            requested: 3,
            completed: 2,
            error: 1,
            contractRejected: 0,
            usableResponses: 2,
            usableRate: 0.6667
        });
        assert.deepEqual(summaryJson.roleUsability.reviewer, {
            requested: 2,
            completed: 1,
            error: 1,
            contractRejected: 0,
            usableResponses: 1,
            usableRate: 0.5
        });
        assert.match(summaryMd, /quality-passed \| 1/);
        assert.match(summaryMd, /usable \| 1/);
        assert.match(summaryMd, /reviewer \| review-unavailable \| 1 \| 1 \| 0 \| 0/);
        assert.match(summaryMd, /writer \| response-not-extracted-python \| 1 \| 0 \| 1 \| 0/);
        assert.match(summaryMd, /module-import \| module-blocked \| 1 \| 0 \| 0 \| 1/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
