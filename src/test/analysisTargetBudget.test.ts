import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TARGET_BUDGET, planAnalysisTargetBudget, TargetBudget,
    currentTargetBudget, runWithTargetBudget, TargetBudgetLimits } from '../pipeline/targetBudget';
import { normalizeExecutionSettings } from '../pipeline/executionSettings';
import { AnalysisStageError } from '../utils/executionFailureCategory';

test('five-round analysis reserves all formal revisions, review corrections and capacity probes up front', () => {
    let now = 1_000;
    const maxLoops = normalizeExecutionSettings({}).maxLoops;
    const plan = planAnalysisTargetBudget(maxLoops);
    assert.deepEqual(plan, { timeoutMs: 600_000, logicalRequests: 44, transportAttempts: 88,
        estimatedInputTokens: 440_000, candidateAttempts: 20 });
    const budget = new TargetBudget({ ...plan, now: () => now });
    const legacy = new TargetBudget({ now: () => now });
    const completed: string[] = [];
    const request = (role: string) => {
        budget.consumeModelRequest();
        budget.consumeTransportAttempt(4_000);
        budget.consumeTransportAttempt(6_000);
        now += 8_000;
        completed.push(role);
    };
    for (const role of ['capacity-writer', 'capacity-reviewer', 'capacity-bug-fixer', 'capacity-writer-retry']) { request(role); }
    const roundRoles = ['analyst', 'writer', 'writer-revision', 'bug-fixer', 'writer-recovery',
        'reviewer', 'reviewer-contract-correction', 'writer-output-recovery'];
    for (let round = 1; round <= maxLoops; round++) {
        for (const role of roundRoles) { request(`${round}:${role}`); }
        for (let attempt = 0; attempt < 4; attempt++) { budget.consumeCandidateAttempt(); }
        assert.equal(budget.deadlineAt, 601_000, 'each later round shares the original ten-minute deadline');
        if (round === 2) {
            assert.equal(completed.length, 20, 'replay the former 16-formal plus four-probe exhaustion point');
            for (let count = 0; count < completed.length; count++) { legacy.consumeModelRequest(); }
            assert.throws(() => legacy.consumeModelRequest(), /logicalRequests/,
                'the unchanged low-level default demonstrates the original bottleneck');
        }
    }
    assert.equal(completed.length, 44);
    assert.deepEqual(budget.snapshot().used, { logicalRequests: 44, transportAttempts: 88,
        estimatedInputTokens: 440_000, candidateAttempts: 20 });
    assert.throws(() => budget.consumeModelRequest(), /logicalRequests/);
    assert.equal(budget.snapshot().used.logicalRequests, 44, 'failed admission never resets or increments exhausted counters');
});

test('loop planning preserves all explicit per-key limits, zero counters and the original time cap', () => {
    const overrides = { timeoutMs: 1_250, logicalRequests: 0, transportAttempts: 0,
        estimatedInputTokens: 0, candidateAttempts: 0 };
    const original = { ...overrides };
    const plan = planAnalysisTargetBudget(5, overrides);
    assert.deepEqual(plan, original);
    assert.deepEqual(overrides, original, 'planning cannot rewrite user configuration');
    const budget = new TargetBudget({ ...plan, now: () => 100 });
    assert.equal(budget.deadlineAt, 1_350);
    for (const counter of ['logicalRequests', 'transportAttempts', 'estimatedInputTokens', 'candidateAttempts'] as const) {
        assert.throws(() => budget.consume({ [counter]: 1 }), (error: unknown) => error instanceof AnalysisStageError
            && (error.diagnostic as { exhausted: string }).exhausted === counter);
    }
    const partial = planAnalysisTargetBudget(5, { logicalRequests: 3, estimatedInputTokens: undefined });
    assert.equal(partial.logicalRequests, 3);
    assert.equal(partial.transportAttempts, 88, 'a per-key override does not silently rewrite unrelated limits');
    assert.equal(partial.estimatedInputTokens, 440_000);
    assert.equal(partial.timeoutMs, DEFAULT_TARGET_BUDGET.timeoutMs);
    plan.logicalRequests = 99;
    assert.equal(planAnalysisTargetBudget(5, overrides).logicalRequests, 0, 'plans are detached from overrides and one another');
    assert.equal(DEFAULT_TARGET_BUDGET.logicalRequests, 20, 'low-level callers keep their existing default');
});

test('analysis count planning is bounded for huge normalized loop settings and rejects invalid input', () => {
    assert.deepEqual(planAnalysisTargetBudget(1), { ...DEFAULT_TARGET_BUDGET });
    assert.equal(planAnalysisTargetBudget(2).logicalRequests, 20);
    assert.equal(planAnalysisTargetBudget(3).logicalRequests, 28);
    const huge = planAnalysisTargetBudget(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(huge, { timeoutMs: 600_000, logicalRequests: 64, transportAttempts: 128,
        estimatedInputTokens: 640_000, candidateAttempts: 40 });
    assert.deepEqual(planAnalysisTargetBudget(10), huge);
    for (const loops of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => planAnalysisTargetBudget(loops), TypeError);
    }
    for (const key of ['timeoutMs', 'logicalRequests', 'transportAttempts', 'estimatedInputTokens', 'candidateAttempts'] as const) {
        for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => planAnalysisTargetBudget(5, { [key]: value } as Partial<TargetBudgetLimits>), TypeError);
        }
    }
    assert.throws(() => planAnalysisTargetBudget(5, { timeoutMs: 0 }), TypeError);
});

test('nested retries cannot replace an existing analysis plan, renew its deadline or reset any usage', async () => {
    let now = 1_000;
    const budget = new TargetBudget({ ...planAnalysisTargetBudget(5), now: () => now });
    await runWithTargetBudget(budget, async active => {
        active.consume({ logicalRequests: 20, transportAttempts: 30, estimatedInputTokens: 123_456, candidateAttempts: 9 });
        now += 30_000;
        await Promise.resolve();
        const nested = new TargetBudget({ ...planAnalysisTargetBudget(10), now: () => now });
        await runWithTargetBudget(nested, async current => {
            assert.equal(current, budget);
            assert.equal(currentTargetBudget(), budget);
            assert.equal(current.deadlineAt, 601_000);
            assert.deepEqual(current.snapshot().used, { logicalRequests: 20, transportAttempts: 30,
                estimatedInputTokens: 123_456, candidateAttempts: 9 });
            current.consumeModelRequest();
            assert.equal(current.snapshot().used.logicalRequests, 21);
            assert.equal(current.limits.logicalRequests, 44);
            now = current.deadlineAt;
            assert.throws(() => current.consumeModelRequest(), (error: unknown) => error instanceof AnalysisStageError
                && error.category === 'timeout' && error.stage === 'target-budget');
        });
        assert.equal(nested.snapshot().used.logicalRequests, 0, 'the ignored nested instance never takes ownership');
    });
    assert.equal(currentTargetBudget(), undefined);
    assert.equal(budget.snapshot().used.logicalRequests, 21);
    assert.equal(budget.deadlineAt, 601_000);
});
