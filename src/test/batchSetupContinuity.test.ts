import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AnalysisEnvironmentLease } from '../environment/analysisEnvironmentLease';
import { PythonEnvironmentActivity } from '../environment/pythonEnvironmentSetup';
import { ExecutionContext } from '../pipeline/executionContext';
import { captureBatchSetupScope } from '../pipeline/batchSetupContinuity';
import { createBatchScopeSelection } from '../pipeline/batchScope';
import type { ImportSetupResult } from '../environment/importSetupController';

test('analysis lends only its idle use lease, reacquires after failure, and does not resume after cancellation', async () => {
    const activity = new PythonEnvironmentActivity(), execution = new ExecutionContext({});
    const lease = AnalysisEnvironmentLease.acquire(activity)!;
    assert.equal(activity.acquire('setup'), undefined);
    await assert.rejects(lease.withSetup(execution, async () => {
        const release = activity.acquire('setup'); assert.ok(release);
        assert.equal(activity.acquire('use'), undefined);
        await assert.rejects(lease.withSetup(execution, async () => {}), /unavailable/);
        release(); throw new Error('setup-failed');
    }), /setup-failed/);
    assert.equal(activity.acquire('setup'), undefined, 'analysis reacquires use even on a setup failure');
    assert.equal(await lease.withSetup(execution, async () => {
        const release = activity.acquire('setup')!; release(); return 12;
    }), 12);
    await assert.rejects(lease.withSetup(execution, async () => { execution.cancel(); return 13; }));
    const released = activity.acquire('setup'); assert.ok(released); released();
    lease.release(); lease.release();
});

test('analysis cannot resume while another setup still owns the environment', async () => {
    const activity = new PythonEnvironmentActivity(), execution = new ExecutionContext({});
    const lease = AnalysisEnvironmentLease.acquire(activity)!;
    let release: (() => void) | undefined;
    await assert.rejects(lease.withSetup(execution, async () => { release = activity.acquire('setup'); }), /環境設定尚未釋放/);
    assert.equal(activity.acquire('use'), undefined); release!(); lease.release();
    const available = activity.acquire('setup'); assert.ok(available); available();
});

test('batch continuation requires the original files, target selectors, Python and complete loaded scope', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-continuity-'));
    try {
        const file = path.join(root, 'sample.py'); fs.writeFileSync(file, 'def target(): return 1\n');
        const scope = createBatchScopeSelection(root, ['sample.py', 'excluded.py'], ['sample.py']);
        const guard = captureBatchSetupScope(scope, 'python');
        const targets = [{ file, target: 'target' }];
        const result: ImportSetupResult = { status: 'ready', fixtureId: null, root, python: 'python', targets,
            rows: [{ file: 'sample.py', status: 'loaded' }], applied: false };
        guard.verify(result, targets, 'python');
        for (const changed of [
            { ...result, status: 'blocked' as const }, { ...result, python: 'other' },
            { ...result, targets: [{ file, target: 'different' }] }, { ...result, rows: [] },
            { ...result, rows: [{ file: 'sample.py', status: 'blocked' as const }] },
            { ...result, rows: [...result.rows, { file: 'excluded.py', status: 'loaded' as const }] }
        ]) { assert.throws(() => guard.verify(changed, targets, 'python'), /批次停止/); }
        assert.throws(() => guard.verify(result, targets, 'changed-python'), /批次停止/);
        fs.appendFileSync(file, '# changed\n');
        assert.throws(() => guard.verify(result, targets, 'python'), /批次停止/);
        fs.unlinkSync(file);
        assert.throws(() => guard.verify(result, targets, 'python'), /批次停止/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
