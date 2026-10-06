import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { validateSeedThenCandidate } from '../pipeline/seedCandidatePipeline';
import { CandidatePipelineHooks } from '../pipeline/testCandidatePipeline';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { repairHash } from '../pipeline/repairDiagnostics';

function fixture() {
    const calls: string[] = [];
    const checkpoints: string[] = [];
    const hooks: CandidatePipelineHooks = {
        validate: async code => { calls.push('validate:' + code); return undefined; },
        review: async code => { calls.push('review:' + code); return { issues: [] }; },
        revise: async () => { throw Error('revision failed'); },
        execute: async code => {
            calls.push('execute:' + code);
            return { ok: true, out: 'test_seed (SeedCases.test_seed) ... ok\nRan 1 test\nOK', qualityGaps: [],
                coverage: { available: true, targetExecuted: true, coverageText: '100%', missingLines: '' } };
        },
        executable: code => { checkpoints.push(code); calls.push('checkpoint:' + code); },
        event: (stage, status) => { calls.push(stage + ':' + status); },
        checkCancelled: () => {}
    };
    return { calls, checkpoints, hooks };
}

test('model seed executes and checkpoints once before a review of that exact code', async () => {
    const { calls, checkpoints, hooks } = fixture();
    const result = await validateSeedThenCandidate({ code: 'seed', seed: true, hooks,
        seedAccepted: code => { calls.push('accepted:' + code); } });
    assert.deepEqual(calls.filter(call => /^(?:execute|review|checkpoint|accepted):/.test(call)),
        ['execute:seed', 'checkpoint:seed', 'accepted:seed', 'review:seed']);
    assert.deepEqual(checkpoints, ['seed']);
    assert.equal(result.reviewStatus, 'completed');
    assert.equal(result.approvedCodeHash, repairHash('seed'));
});

test('failed model seed never creates a checkpoint or requests review', async () => {
    const { calls, checkpoints, hooks } = fixture();
    hooks.execute = async () => ({ ok: false, out: 'AssertionError: wrong', qualityGaps: [] });
    await assert.rejects(validateSeedThenCandidate({ code: 'bad', seed: true, hooks }), /revision failed/);
    assert.equal(calls.some(call => call.startsWith('review:')), false);
    assert.deepEqual(checkpoints, []);
});

test('no real target invocation cannot become a seed checkpoint', async () => {
    const { checkpoints, hooks } = fixture();
    hooks.execute = async () => ({ ok: true, out: 'OK', qualityGaps: [] });
    await assert.rejects(validateSeedThenCandidate({ code: 'unrelated', seed: true, hooks }), /no verified execution/);
    assert.deepEqual(checkpoints, []);
});

test('an unavailable review preserves the verified seed but never returns an accepted result', async () => {
    const { checkpoints, hooks } = fixture();
    hooks.review = async () => undefined;
    await assert.rejects(validateSeedThenCandidate({ code: 'seed', seed: true, hooks }),
        (error: unknown) => error instanceof AnalysisStageError && error.stage === 'reviewer');
    assert.deepEqual(checkpoints, ['seed']);
});

test('a failed checkpoint never emits seed acceptance or requests review', async () => {
    const { calls, hooks } = fixture();
    hooks.executable = () => { throw Error('checkpoint failed'); };
    await assert.rejects(validateSeedThenCandidate({ code: 'seed', seed: true, hooks,
        seedAccepted: () => { throw Error('must not accept'); } }), /checkpoint failed/);
    assert.equal(calls.includes('writer-seed:accepted'), false);
    assert.equal(calls.some(call => call.startsWith('review:')), false);
});

test('a Reviewer revision cannot replace a passing seed with unrelated tests', async () => {
    const { checkpoints, hooks } = fixture();
    const repairedFrom: string[] = [];
    let reviews = 0;
    hooks.review = async () => { reviews++; return { issues: [{ id: 'Q1', severity: 'quality', evidence: 'seed',
        reason: 'empty input is absent', action: 'add the verified empty input case' }] }; };
    hooks.revise = async code => { repairedFrom.push(code); return 'unrelated'; };
    hooks.execute = async code => ({ ok: true,
        out: code === 'seed'
            ? 'test_seed (SeedCases.test_seed) ... ok\nRan 1 test\nOK'
            : 'test_other (OtherCases.test_other) ... ok\nRan 1 test\nOK',
        qualityGaps: [], coverage: { available: true, targetExecuted: true, coverageText: '100%', missingLines: '' } });
    await assert.rejects(validateSeedThenCandidate({ code: 'seed', seed: true, hooks }), /Previously passing tests/);
    assert.deepEqual(checkpoints, ['seed']);
    assert.ok(repairedFrom.every(code => code === 'seed'));
    assert.equal(reviews, 1, 'a regressing repair never reaches review');
});

test('Writer expansion preserves the seed and re-executes before new Reviewer approval', async () => {
    const { calls, checkpoints, hooks } = fixture();
    let accepted = 0;
    hooks.review = async code => { calls.push('review:' + code); return { issues: code === 'seed' ? [{
        id: 'Q1', severity: 'quality', evidence: 'seed', reason: 'empty input is absent', action: 'add the verified empty input case'
    }] : [] }; };
    hooks.revise = async (_code, _feedback, role) => { assert.equal(role, 'writer'); return 'seed+expanded'; };
    const result = await validateSeedThenCandidate({ code: 'seed', seed: true, hooks, seedAccepted: () => { accepted++; } });
    assert.equal(result.code, 'seed+expanded');
    assert.deepEqual(checkpoints, ['seed', 'seed+expanded']);
    assert.equal(accepted, 1);
    assert.deepEqual(calls.filter(call => /^(?:execute|review):/.test(call)),
        ['execute:seed', 'review:seed', 'execute:seed+expanded', 'review:seed+expanded']);
    assert.equal(result.approvedCodeHash, repairHash('seed+expanded'));
});

test('subsequent candidates use the normal pipeline without a second seed', async () => {
    const { calls, hooks } = fixture();
    await validateSeedThenCandidate({ code: 'expanded', seed: false, hooks });
    assert.equal(calls.filter(call => call.startsWith('execute:')).length, 1);
    assert.equal(calls.some(call => call.startsWith('writer-seed:')), false);
});
