import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExecutionTimingSettings, snapshotExecutionTargetBudget } from '../pipeline/executionTimingSettings';
import { planAnalysisTargetBudget, runWithTargetBudget, TargetBudget } from '../pipeline/targetBudget';

test('long shared-server waits keep API and target units distinct and freeze one target snapshot', async () => {
    const settings = parseExecutionTimingSettings(1800, 3600);
    const saved = { timeoutMs: 600000, logicalRequests: 31, candidateAttempts: 0 };
    const snapshot = snapshotExecutionTargetBudget(saved, settings.targetTimeoutSeconds);
    assert.deepEqual(snapshot, { timeoutMs: 3600000, logicalRequests: 31, candidateAttempts: 0 });
    assert.deepEqual(saved, { timeoutMs: 600000, logicalRequests: 31, candidateAttempts: 0 });
    assert.equal(Object.isFrozen(snapshot), true);
    saved.timeoutMs = 1000;
    assert.equal(snapshot.timeoutMs, 3600000);
    let now = 1000;
    const budget = new TargetBudget({ ...planAnalysisTargetBudget(5, snapshot), now: () => now });
    await runWithTargetBudget(budget, async () => {
        now += 1800000;
        await runWithTargetBudget(new TargetBudget({ timeoutMs: 86400000, now: () => now }), active => {
            assert.equal(active, budget);
            assert.equal(active.remainingMs(), 1800000, 'retry shares the original function deadline');
        });
    });
    assert.equal(snapshotExecutionTargetBudget({}).timeoutMs, 600000, 'the existing default remains ten minutes');
    assert.equal(snapshotExecutionTargetBudget({ timeoutMs: 1501 }).timeoutMs, 1501);
    assert.equal(snapshotExecutionTargetBudget({}, 1.501).timeoutMs, 1501, 'the UI never rounds an existing millisecond setting');
});

test('invalid time units or counters fail visibly instead of silently restoring short defaults', () => {
    for (const seconds of [0, -1, 1.5, 60000000, Infinity, NaN, '1800', undefined]) {
        assert.throws(() => parseExecutionTimingSettings(seconds, 3600), TypeError);
    }
    for (const seconds of [0, -1, 0.0001, 1.00001, 86401, Infinity, NaN, '3600']) {
        assert.throws(() => parseExecutionTimingSettings(1800, seconds), TypeError);
    }
    assert.deepEqual(parseExecutionTimingSettings(86400, 86400), { timeoutSeconds: 86400, targetTimeoutSeconds: 86400 });
    for (const value of [null, [], { timeoutMs: 86400001 }, { logicalRequests: -1 }, { candidateAttempts: 0.1 }, { unknownLimit: 1 }]) {
        assert.throws(() => snapshotExecutionTargetBudget(value), TypeError);
    }
});
