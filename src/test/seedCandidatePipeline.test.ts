import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { validateSeedThenCandidate } from '../pipeline/seedCandidatePipeline';
import { CandidatePipelineHooks } from '../pipeline/testCandidatePipeline';

function fixture() {
    const calls: string[] = [];
    const checkpoints: string[] = [];
    const hooks: CandidatePipelineHooks = {
        validate: async code => { calls.push('validate:' + code); return undefined; },
        review: async code => { calls.push('review:' + code); return { issues: [] }; },
        revise: async () => { throw Error('revision failed'); },
        execute: async code => {
            calls.push('execute:' + code);
            return { ok: true, out: 'Ran 1 test\nOK', qualityGaps: [],
                coverage: { available: true, targetExecuted: true, coverageText: '100%', missingLines: '' } };
        },
        executable: code => { checkpoints.push(code); },
        event: (stage, status) => { calls.push(stage + ':' + status); },
        checkCancelled: () => {}
    };
    return { calls, checkpoints, hooks };
}

test('model seed executes alone before augmentation and full review', async () => {
    const { calls, checkpoints, hooks } = fixture();
    const result = await validateSeedThenCandidate({ code: 'seed', seed: true, hooks,
        augment: async code => { calls.push('augment'); return code + '+trace'; } });
    assert.ok(calls.indexOf('execute:seed') < calls.indexOf('augment'));
    assert.ok(calls.indexOf('augment') < calls.indexOf('execute:seed+trace'));
    assert.deepEqual(calls.filter(call => call.startsWith('review:')), ['review:seed+trace']);
    assert.deepEqual(checkpoints, ['seed', 'seed+trace']);
    assert.equal(result.reviewStatus, 'completed');
});

test('failed model seed never appends trace or requests review', async () => {
    const { calls, hooks } = fixture();
    hooks.execute = async () => ({ ok: false, out: 'AssertionError: wrong', qualityGaps: [] });
    await assert.rejects(validateSeedThenCandidate({ code: 'bad', seed: true, hooks,
        augment: async () => { throw Error('must not augment'); } }), /revision failed/);
    assert.equal(calls.some(call => call.startsWith('review:')), false);
});

test('no real target invocation cannot become a seed checkpoint', async () => {
    const { checkpoints, hooks } = fixture();
    hooks.execute = async () => ({ ok: true, out: 'OK', qualityGaps: [] });
    await assert.rejects(validateSeedThenCandidate({ code: 'unrelated', seed: true, hooks,
        augment: async code => code }), /no verified execution/);
    assert.deepEqual(checkpoints, []);
});

test('augmentation failure leaves the independently verified seed checkpoint', async () => {
    const { checkpoints, hooks } = fixture();
    await assert.rejects(validateSeedThenCandidate({ code: 'seed', seed: true, hooks,
        augment: async () => { throw Error('trace baseline failed'); } }), /trace baseline failed/);
    assert.deepEqual(checkpoints, ['seed']);
});

test('repair after augmented structure failure cannot replace a passing seed with host tests only', async () => {
    const { checkpoints, calls, hooks } = fixture();
    const repairedFrom: string[] = [];
    hooks.validate = async code => code === 'seed+trace' ? 'combined import binding conflict' : undefined;
    hooks.revise = async code => { repairedFrom.push(code); return 'trace'; };
    hooks.execute = async code => ({ ok: true,
        out: code === 'seed'
            ? 'test_seed (SeedCases.test_seed) ... ok\nRan 1 test\nOK'
            : 'test_trace (HostCases.test_trace) ... ok\nRan 1 test\nOK',
        qualityGaps: [], coverage: { available: true, targetExecuted: true, coverageText: '100%', missingLines: '' } });
    await assert.rejects(validateSeedThenCandidate({ code: 'seed', seed: true, hooks,
        augment: async code => code + '+trace' }), /Previously passing tests failed, disappeared, or were skipped: SeedCases.test_seed/);
    assert.deepEqual(checkpoints, ['seed'], 'the host-only revision never replaces the executable seed');
    assert.ok(repairedFrom.every(code => code === 'seed'), 'repair always starts from the retained seed');
    assert.equal(calls.some(call => call.startsWith('review:')), false, 'a regressing repair never reaches review');
});

test('repair after augmented structure failure can keep the passing seed and add a host test', async () => {
    const { checkpoints, hooks } = fixture();
    hooks.validate = async code => code === 'seed+trace' ? 'combined import binding conflict' : undefined;
    hooks.revise = async () => 'seed+fixed-trace';
    hooks.execute = async code => ({ ok: true,
        out: 'test_seed (SeedCases.test_seed) ... ok\n'
            + (code === 'seed' ? '' : 'test_trace (HostCases.test_trace) ... ok\n')
            + `Ran ${code === 'seed' ? 1 : 2} tests\nOK`,
        qualityGaps: [], coverage: { available: true, targetExecuted: true, coverageText: '100%', missingLines: '' } });
    const result = await validateSeedThenCandidate({ code: 'seed', seed: true, hooks,
        augment: async code => code + '+trace' });
    assert.equal(result.code, 'seed+fixed-trace');
    assert.deepEqual(checkpoints, ['seed', 'seed+fixed-trace']);
});

test('subsequent candidates use the normal pipeline without a second seed', async () => {
    const { calls, hooks } = fixture();
    await validateSeedThenCandidate({ code: 'expanded', seed: false, hooks, augment: async code => code });
    assert.equal(calls.filter(call => call.startsWith('execute:')).length, 1);
    assert.equal(calls.some(call => call.startsWith('writer-seed:')), false);
});
