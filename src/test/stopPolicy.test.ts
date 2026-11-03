import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeStopPolicy, TargetStopPolicy, runWithStopPolicy } from '../pipeline/stopPolicy';
import { CandidatePipelineHooks, validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { runWithTargetBudget, TargetBudget } from '../pipeline/targetBudget';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { QualityProgress } from '../pipeline/analysisJournal';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';
import { semanticWithContractRepair } from '../roles/semanticContractRepair';
import { QualityAnalystSession } from '../roles/qualityAnalyst';

function hooks(overrides: Partial<CandidatePipelineHooks> = {}): CandidatePipelineHooks {
    return { reviewRequired: false, checkCancelled() {}, event() {},
        validate: async () => undefined, review: async () => undefined,
        revise: async (_code, _failure, _role, attempt) => 'candidate-' + attempt,
        execute: async () => ({ ok: true, out: 'OK', qualityGaps: [] }), ...overrides };
}

test('invalid stop settings are rejected rather than silently replaced', () => {
    assert.deepEqual(normalizeStopPolicy(undefined), { failureLimit: 5, qualityNoImprovementLimit: 3, batchFailureLimit: 0 });
    for (const input of [null, [], '5', { failureLimit: 0 }, { failureLimit: 1.5 },
        { qualityNoImprovementLimit: -1 }, { batchFailureLimit: Infinity }, { unknown: 2 }]) {
        assert.throws(() => normalizeStopPolicy(input), TypeError);
    }
});

for (const limit of [1, 3, 5]) {
    test(`shared failure policy stops at exactly ${limit} rejected candidates`, async () => {
        const policy = new TargetStopPolicy({ failureLimit: limit });
        let validations = 0;
        await assert.rejects(runWithStopPolicy(policy, () => validateTestCandidate('initial', hooks({
            validate: async () => { validations++; return 'bad structure'; }
        }))), error => error instanceof AnalysisStageError && error.stage === 'target-failure-policy');
        assert.equal(validations, limit);
        assert.equal(policy.failureCount, limit);
        assert.equal(policy.snapshot().stopReason, 'failure-limit');
    });
    test(`candidate ${limit} may succeed after ${limit - 1} failures`, async () => {
        const policy = new TargetStopPolicy({ failureLimit: limit });
        let validations = 0;
        const result = await runWithStopPolicy(policy, () => validateTestCandidate('initial', hooks({
            validate: async () => ++validations < limit ? 'bad structure' : undefined
        })));
        assert.equal(result.execution.ok, true);
        assert.equal(validations, limit);
        assert.equal(policy.failureCount, limit - 1);
    });
}

test('writer, revision format, execution and reviewer failures share an allowance without double charging', async () => {
    const policy = new TargetStopPolicy({ failureLimit: 5 });
    let revisions = 0, executions = 0, reviews = 0;
    const result = await runWithStopPolicy(policy, () => validateTestCandidate('initial', hooks({
        reviewRequired: true,
        validate: async code => code === 'initial' ? 'structure rejected' : undefined,
        revise: async () => {
            if (++revisions === 1) { throw new AnalysisStageError('model-format', 'writer-method-edit-scope', 'syntax'); }
            return 'candidate-' + revisions;
        },
        execute: async () => ({ ok: ++executions > 1, out: executions === 1 ? 'failure' : 'OK', qualityGaps: [] }),
        review: async () => ++reviews === 1 ? { issues: [{ severity: 'blocking', reason: 'incorrect case' }] } as any : { issues: [] },
        rejectedCandidate: async (_code, _attempt, _gate, reason) => { policy.reject(reason); }
    })));
    assert.equal(result.execution.ok, true);
    assert.equal(policy.failureCount, 4);
});

test('environment and validation tool errors do not charge model failures', async () => {
    for (const category of ['environment', 'tool'] as const) {
        const policy = new TargetStopPolicy({ failureLimit: 1 });
        await assert.rejects(runWithStopPolicy(policy, () => validateTestCandidate('initial', hooks({
            execute: async () => { throw new AnalysisStageError(category, 'tool', 'blocked'); }
        }))));
        assert.equal(policy.failureCount, 0);
    }
});

test('deadline takes precedence over remaining model failures', async () => {
    let now = 0;
    const budget = new TargetBudget({ timeoutMs: 10, now: () => now });
    const policy = new TargetStopPolicy({ failureLimit: 5 });
    await assert.rejects(runWithTargetBudget(budget, () => runWithStopPolicy(policy,
        () => validateTestCandidate('initial', hooks({ validate: async () => { now = 10; return 'bad'; } })))),
    error => error instanceof AnalysisStageError && error.stage === 'target-budget');
    assert.equal(policy.failureCount, 0);
});

test('repeated candidates consume failures without repeated native execution', async () => {
    const policy = new TargetStopPolicy({ failureLimit: 3 });
    let executions = 0;
    await assert.rejects(runWithStopPolicy(policy, () => validateTestCandidate('initial', hooks({
        revise: async () => 'initial',
        execute: async () => { executions++; return { ok: false, out: 'bad result', qualityGaps: [] }; }
    }))));
    assert.equal(executions, 1);
    assert.equal(policy.failureCount, 3);
});

test('quality stagnation can be disabled', () => {
    const progress = new QualityProgress(0);
    for (let round = 0; round < 12; round++) { assert.equal(progress.observe(['survivor'], ['gap']), false); }
});

test('Reviewer and both analysts use the target allowance beyond two invalid responses', async () => {
    const operations = [
        (request: () => Promise<string>) => reviewWithContractRepair({ tests: '', prompt: '', deadlineAt: Date.now() + 10000,
            request, checkCancelled() {}, event() {} }),
        (request: () => Promise<string>) => semanticWithContractRepair({ prompt: '', deadlineAt: Date.now() + 10000,
            request, checkCurrent() {}, event() {} }),
        (request: () => Promise<string>) => new QualityAnalystSession().request({
            focus: { id: 'E0123456789abcdef', kind: 'coverage', evidence: 'line 4 missing' }, context: '',
            deadlineAt: Date.now() + 10000, request, checkCancelled() {}, event() {} })
    ];
    for (const operation of operations) {
        const policy = new TargetStopPolicy({ failureLimit: 3 });
        let requests = 0;
        await assert.rejects(runWithStopPolicy(policy, () => operation(async () => { requests++; return 'invalid'; })),
            error => error instanceof AnalysisStageError && error.stage === 'target-failure-policy');
        assert.equal(requests, 3);
        assert.equal(policy.failureCount, 3);
    }
});
