import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandidatePipelineHooks, validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { TargetBudget, runWithTargetBudget } from '../pipeline/targetBudget';

function hooks(overrides: Partial<CandidatePipelineHooks> = {}) {
    const output = 'test_keep (exec1.Cases.test_keep) ... ok\nFAIL: test_value (exec1.Cases.test_value)\nAssertionError: wrong constant';
    return {
        reviewRequired: false, checkCancelled() {}, event() {},
        validate: async () => undefined,
        execute: async (code: string) => ({ ok: code === 'fixed', out: code === 'fixed'
            ? 'test_keep (exec2.Cases.test_keep) ... ok\ntest_value (exec2.Cases.test_value) ... ok' : output,
            qualityGaps: [], testModule: code === 'fixed' ? 'exec2' : 'exec1' }),
        repairExpectations: async () => ({ code: 'fixed', evidence: { basis: 'source-derived-arithmetic-v1' } }),
        revise: async () => { throw Error('Unexpected model request'); },
        review: async () => { throw Error('Unexpected reviewer request'); }, ...overrides
    } satisfies CandidatePipelineHooks;
}

test('source corrections consume candidate budget and must pass structure, real execution and retention', async () => {
    let validations = 0;
    const events: string[] = [];
    const budget = new TargetBudget({ candidateAttempts: 2 });
    const result = await runWithTargetBudget(budget, () => validateTestCandidate('wrong', hooks({
        validate: async () => { validations++; return undefined; }, event: stage => events.push(stage)
    })));
    assert.equal(result.code, 'fixed');
    assert.equal(validations, 2);
    assert.equal(budget.snapshot().used.candidateAttempts, 2);
    assert.ok(events.includes('source-expectation-repair'));
    await assert.rejects(validateTestCandidate('wrong', hooks({
        validate: async code => code === 'fixed' ? 'target replaced' : undefined, revise: async () => 'fixed'
    }), 1), /target replaced/);
    await assert.rejects(validateTestCandidate('wrong', hooks({
        execute: async code => ({ ok: code === 'fixed', out: code === 'fixed' ? 'OK' : 'test_keep (exec.Cases.test_keep) ... ok\nFAIL: test_value (exec.Cases.test_value)', qualityGaps: [], testModule: 'exec' }), revise: async () => 'fixed'
    }), 1), /Previously passing tests/);
    await assert.rejects(validateTestCandidate('wrong', hooks({
        execute: async () => ({ ok: false, out: 'FAIL: test_value (exec.Cases.test_value)', qualityGaps: [] }), revise: async () => 'fixed'
    }), 1), /FAIL: test_value/);
});

test('two bounded tool attempts preserve both model revisions and cannot keep extending the loop', async () => {
    let tools = 0, models = 0;
    const budget = new TargetBudget({ candidateAttempts: 5 });
    const result = await runWithTargetBudget(budget, () => validateTestCandidate('wrong', hooks({
        repairRole: () => 'writer',
        repairExpectations: async () => ({ code: 'tool-' + ++tools, evidence: {} }),
        revise: async () => ++models === 2 ? 'fixed' : 'model-1'
    }), 2));
    assert.equal(result.code, 'fixed');
    assert.equal(tools, 2);
    assert.equal(models, 2);
    assert.equal(budget.snapshot().used.candidateAttempts, 5);
});

test('unsupported arithmetic returns to model; cancellation and exhausted budget cannot authorize correction', async () => {
    let revisions = 0, calculations = 0;
    const fallback = hooks({ repairExpectations: async () => undefined, revise: async () => { revisions++; return 'fixed'; } });
    assert.equal((await validateTestCandidate('wrong', fallback)).code, 'fixed');
    assert.equal(revisions, 1);
    const budget = new TargetBudget({ candidateAttempts: 1 });
    await assert.rejects(runWithTargetBudget(budget, () => validateTestCandidate('wrong', hooks({
        repairExpectations: async () => { calculations++; return undefined; }
    }))), /預算已耗盡/);
    assert.equal(calculations, 0);
    let cancelled = false;
    await assert.rejects(validateTestCandidate('wrong', hooks({
        checkCancelled() { if (cancelled) { throw Error('cancelled'); } },
        repairExpectations: async () => { cancelled = true; return { code: 'fixed', evidence: {} }; }
    })), /cancelled/);
});
