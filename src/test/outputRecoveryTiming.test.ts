import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOutputRecoveryStage, outputRecoveryAttemptDeadline, outputRecoveryTokenLimit, planOutputRecoveryRetry } from '../llm/outputRecoveryTiming';
import { createTransportAttemptTiming } from '../llm/requestTiming';

const lengthTiming = (generationMs: number, outputTokens = 1536) => createTransportAttemptTiming({
    transportAttempt: 1, outcome: 'completed', startedAt: 0, finishedAt: generationMs + 2000,
    ollamaPayload: { done: true, done_reason: 'length', eval_count: outputTokens,
        eval_duration: generationMs * 1e6, prompt_eval_duration: 1e9, load_duration: 0,
        total_duration: (generationMs + 1000) * 1e6 }
});

test('length recovery reserves two request allowances before the first request without renewing its stage', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 60, recoveryAllowed: true, now: 0 });
    assert.equal(stage.deadlineAt, 120000);
    assert.equal(outputRecoveryAttemptDeadline(stage, 0, 0), 60000);
    assert.equal(outputRecoveryAttemptDeadline(stage, 1, 45900), 105900);
    assert.equal(outputRecoveryAttemptDeadline(stage, 1, 115000), 120000);
    assert.equal(stage.deadlineAt, 120000);
    assert.throws(() => outputRecoveryAttemptDeadline(stage, 2, 0));
});

test('explicit caller and target deadlines are hard caps, including retries', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 60, recoveryAllowed: true,
        sharedDeadlineAt: 60000, targetDeadlineAt: 55000, now: 0 });
    assert.equal(stage.deadlineAt, 55000);
    assert.equal(outputRecoveryAttemptDeadline(stage, 1, 45000), 55000);
    assert.equal(planOutputRecoveryRetry(stage, 2560, undefined, 45000).allowed, false);
});

test('a measured larger completion is rejected if it cannot fit the per-request allowance', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 60, recoveryAllowed: true, now: 0 });
    const decision = planOutputRecoveryRetry(stage, 2560, lengthTiming(45000), 47000);
    assert.equal(decision.estimatedRetryMs, 78000);
    assert.equal(decision.availableMs, 60000);
    assert.equal(decision.reasonCode, 'insufficient-output-retry-time');
    assert.equal(decision.allowed, false);
});

test('a larger completion uses a full reserved allowance when measured speed supports it', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 120, recoveryAllowed: true, now: 0 });
    const decision = planOutputRecoveryRetry(stage, 2560, lengthTiming(45000), 47000);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reasonCode, 'measured-output-fits');
    assert.equal(stage.deadlineAt, 240000);
});

test('slow generation is diagnosed instead of launching a doomed 300-second retry', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 300, recoveryAllowed: true,
        targetDeadlineAt: 570000, now: 0 });
    const decision = planOutputRecoveryRetry(stage, 2560, lengthTiming(270000), 272000);
    assert.equal(decision.estimatedRetryMs, 453000);
    assert.equal(decision.availableMs, 298000);
    assert.equal(decision.allowed, false);
});

test('missing, incomplete or invalid statistics never invent token speed', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 60, recoveryAllowed: true, now: 0 });
    for (const timing of [undefined, lengthTiming(0), lengthTiming(1000, 0),
        { ...lengthTiming(1000), outcome: 'timeout' as const }]) {
        const decision = planOutputRecoveryRetry(stage, 2560, timing, 45000);
        assert.equal(decision.estimatedRetryMs, null);
        assert.equal(decision.reasonCode, 'unmeasured-full-allowance');
        assert.equal(decision.allowed, true);
    }
    assert.equal(planOutputRecoveryRetry(stage, 2560, undefined, 70000).allowed, false);
});

test('non-recoverable roles get one allowance and invalid budgets do not create a stage', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 60, recoveryAllowed: false, now: 0 });
    assert.equal(stage.deadlineAt, 60000);
    assert.equal(planOutputRecoveryRetry(stage, 2560, lengthTiming(1000), 0).allowed, false);
    assert.throws(() => createOutputRecoveryStage({ timeoutSeconds: 0, recoveryAllowed: true, now: 0 }));
    assert.throws(() => createOutputRecoveryStage({ timeoutSeconds: 60, recoveryAllowed: true, sharedDeadlineAt: NaN, now: 0 }));
    assert.throws(() => planOutputRecoveryRetry(stage, Infinity));
});

test('same-prompt measured output is bounded by both the fixed request allowance and remaining stage', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 60, recoveryAllowed: true, now: 0 });
    const timing = lengthTiming(45000);
    const cap = outputRecoveryTokenLimit(stage, timing, 47000)!;
    assert.ok(cap > 1536 && cap < 2560);
    assert.equal(planOutputRecoveryRetry(stage, cap, timing, 47000).allowed, true);
    assert.equal(planOutputRecoveryRetry(stage, cap + 1, timing, 47000).allowed, false);
    assert.ok(outputRecoveryTokenLimit(stage, timing, 90000)! < cap);
    assert.equal(outputRecoveryTokenLimit(stage, timing, 120000), 0);
    assert.equal(outputRecoveryTokenLimit(stage, undefined), undefined);
});

test('provider residual processing time is retained when calculating a retry cap', () => {
    const stage = createOutputRecoveryStage({ timeoutSeconds: 60, recoveryAllowed: true, now: 0 });
    const timing = createTransportAttemptTiming({ transportAttempt: 1, outcome: 'completed', startedAt: 0, finishedAt: 46820,
        ollamaPayload: { done: true, done_reason: 'length', eval_count: 1536, prompt_eval_count: 5729,
            eval_duration: 39724791000, prompt_eval_duration: 2754897000, load_duration: 6796100, total_duration: 46769098800 } });
    const cap = outputRecoveryTokenLimit(stage, timing, 47000)!;
    assert.ok(cap > 1536 && cap < 2335, 'the BMI observation fits a bounded increase, not the full 2560 growth');
    assert.equal(planOutputRecoveryRetry(stage, cap, timing, 47000).allowed, true);
});
