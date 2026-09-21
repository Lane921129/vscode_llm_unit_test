import * as assert from 'assert';
import { test } from 'node:test';
import { TargetBudget, currentTargetBudget, runWithTargetBudget } from '../pipeline/targetBudget';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { AnalysisStageError, classifyExecutionFailure } from '../utils/executionFailureCategory';

test('target deadline is absolute and remains unchanged across nested roles and async retries', async () => {
    let now = 1_000;
    const budget = new TargetBudget({ timeoutMs: 100, now: () => now });
    await runWithTargetBudget(budget, async active => {
        active.consumeModelRequest();
        now += 60;
        await Promise.resolve();
        await runWithTargetBudget(new TargetBudget({ timeoutMs: 10_000, now: () => now }), async nested => {
            assert.equal(nested, budget);
            assert.equal(currentTargetBudget(), budget);
            assert.equal(nested.deadlineAt, 1_100);
            assert.equal(nested.remainingMs(), 40);
            nested.consumeTransportAttempt(50);
            now = 1_100;
            assert.throws(() => nested.consumeCandidateAttempt(), (error: unknown) => error instanceof AnalysisStageError
                && error.category === 'timeout' && error.stage === 'target-budget');
        });
    });
    assert.equal(currentTargetBudget(), undefined);
    assert.equal(budget.snapshot().used.candidateAttempts, 0);
});

test('transport retries and logical requests consume independent shared allowances', () => {
    const budget = new TargetBudget({ logicalRequests: 2, transportAttempts: 3, estimatedInputTokens: 100, candidateAttempts: 1 });
    budget.consumeModelRequest();
    budget.consumeTransportAttempt(40);
    budget.consumeTransportAttempt(30);
    budget.consumeModelRequest();
    budget.consumeTransportAttempt(30);
    budget.consumeCandidateAttempt();
    assert.deepEqual(budget.snapshot().used, { logicalRequests: 2, transportAttempts: 3, estimatedInputTokens: 100, candidateAttempts: 1 });
    assert.throws(() => budget.consumeTransportAttempt(), (error: unknown) => error instanceof AnalysisStageError
        && error.category === 'budget' && error.stage === 'target-budget'
        && (error.diagnostic as { exhausted: string }).exhausted === 'transportAttempts');
    assert.throws(() => budget.consumeModelRequest(), /logicalRequests/);
    assert.throws(() => budget.consumeCandidateAttempt(), /candidateAttempts/);
    assert.equal(budget.snapshot().used.transportAttempts, 3);
});

test('request admission is atomic and snapshots contain only detached numeric metrics', () => {
    const budget = new TargetBudget({ estimatedInputTokens: 5 });
    budget.consumeModelRequest();
    assert.throws(() => budget.consumeTransportAttempt(6), /estimatedInputTokens/);
    assert.equal(budget.snapshot().used.transportAttempts, 0);
    assert.equal(budget.snapshot().used.estimatedInputTokens, 0);
    budget.consumeTransportAttempt(5);
    const snapshot = budget.snapshot();
    snapshot.used.logicalRequests = 0;
    snapshot.limits.logicalRequests = 999;
    assert.equal(budget.snapshot().used.logicalRequests, 1);
    assert.equal(budget.limits.logicalRequests, 20);
    for (const amount of [-1, 0.5, Infinity, NaN]) { assert.throws(() => budget.consumeTransportAttempt(amount), TypeError); }
});

test('separate async targets have independent budgets while cancellation stays session-owned', async () => {
    const first = new TargetBudget({ logicalRequests: 1 });
    const second = new TargetBudget({ logicalRequests: 2 });
    const execution = new ExecutionContext(null);
    await Promise.all([
        runInExecution(execution, () => runWithTargetBudget(first, async active => {
            active.consumeModelRequest();
            await Promise.resolve();
            assert.equal(currentTargetBudget(), first);
            execution.cancel();
            assert.throws(() => active.consumeTransportAttempt(), /中止/);
        })),
        runWithTargetBudget(second, async active => {
            await Promise.resolve();
            assert.equal(currentTargetBudget(), second);
            active.consumeModelRequest();
            active.consumeModelRequest();
        })
    ]);
    assert.equal(first.snapshot().used.transportAttempts, 0);
    assert.equal(second.snapshot().used.logicalRequests, 2);
});

test('budget failures remain distinguishable from execution validation and success', () => {
    const budget = new TargetBudget({ candidateAttempts: 0 });
    assert.throws(() => budget.consumeCandidateAttempt(), (error: unknown) => error instanceof AnalysisStageError
        && classifyExecutionFailure(error.message) === 'budget');
    assert.equal(classifyExecutionFailure(budget.deadlineError().message), 'timeout');
    assert.throws(() => new TargetBudget({ transportAttempts: -1 }), TypeError);
});
