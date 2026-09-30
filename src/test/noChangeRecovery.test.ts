import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandidatePipelineHooks, validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { TargetBudget, runWithTargetBudget } from '../pipeline/targetBudget';
import { RepairFeedback } from '../validation/repairFeedback';
import { formatRepairRouting } from '../pipeline/repairDiagnostics';
import { getBugFixerSystemPrompt } from '../roles/bugFixer';

const failure = 'FAIL: test_value (exec1_test.Cases.test_value)\nAssertionError: 19.53 != 18.5';
function setup(overrides: Partial<CandidatePipelineHooks> = {}) {
    const roles: string[] = [], events: any[] = [];
    const hooks: CandidatePipelineHooks = {
        reviewRequired: false, checkCancelled() {},
        validate: async code => code === 'initial' ? 'target mocked' : undefined,
        execute: async code => ({ ok: code === 'corrected', out: code === 'corrected' ? 'OK' : failure, qualityGaps: [] }),
        review: async () => { throw Error('review must remain deferred'); },
        revise: async (code, feedback, role, attempt) => {
            roles.push(role);
            if (attempt === 1) { return 'wrong'; }
            if (role === 'bug-fixer') { return 'wrong\n'; }
            assert.equal(code, 'wrong');
            assert.match(feedback, /19.53 != 18.5/);
            assert.match(feedback, /actual output alone is not an oracle/);
            return 'corrected';
        },
        event: (stage, status, detail) => events.push({ stage, status, detail }),
        ...overrides
    };
    return { hooks, roles, events };
}

test('last-slot duplicate repair reserves one bounded Writer request with the original failure', async () => {
    const { hooks, roles, events } = setup();
    const result = await validateTestCandidate('initial', hooks);
    assert.equal(result.code, 'corrected');
    assert.equal(result.reviewStatus, 'not-required');
    assert.deepEqual(roles, ['writer', 'bug-fixer', 'writer']);
    const route = events.find(e => e.detail?.action === 'writer-recovery');
    assert.equal(route.detail.revisionLimit, 3);
    assert.match(formatRepairRouting(route.detail), /接手一次/);
});

test('AST no-method-change uses the same recovery while other scope violations never grant it', async () => {
    for (const reasonCode of ['no-method-change', 'import-conflict', 'scope-tool-error']) {
        const context = setup({
            revise: async (_code, _failure, role, attempt) => attempt === 1 ? 'wrong' : role === 'bug-fixer' ? 'cosmetic-change' : 'corrected',
            validateRevision: async (_a, _b, _c, role) => role === 'bug-fixer' ? { reason: reasonCode, reasonCode } : undefined
        });
        if (reasonCode === 'no-method-change') {
            assert.equal((await validateTestCandidate('initial', context.hooks)).code, 'corrected');
        } else {
            await assert.rejects(validateTestCandidate('initial', context.hooks), /修訂上限/);
            assert.equal(context.events.some(e => e.detail?.action === 'writer-recovery'), false);
        }
    }
});

test('Writer recovery cannot bypass remaining candidate budget or cancellation', async () => {
    const { hooks, roles } = setup();
    const budget = new TargetBudget({ candidateAttempts: 3 });
    await assert.rejects(runWithTargetBudget(budget, () => validateTestCandidate('initial', hooks)), /預算已耗盡/);
    assert.deepEqual(roles, ['writer', 'bug-fixer']);
    assert.equal(budget.snapshot().used.candidateAttempts, 3);
    let cancelled = false;
    const cancelledRun = setup({ event: (_s, _t, detail: any) => { if (detail?.action === 'writer-recovery') { cancelled = true; } },
        checkCancelled: () => { if (cancelled) { throw Error('cancelled'); } } });
    await assert.rejects(validateTestCandidate('initial', cancelledRun.hooks), /cancelled/);
    assert.deepEqual(cancelledRun.roles, ['writer', 'bug-fixer']);
});

test('failed or invalid reserved Writer candidate stops even when ordinary revisions remain', async () => {
    for (const invalid of [false, true]) {
        let calls = 0;
        const { hooks, events } = setup({
            validate: async code => code === 'bad-recovery' && invalid ? 'target mocked' : undefined,
            revise: async (_code, _failure, role) => { calls++; return role === 'bug-fixer' ? 'wrong' : 'bad-recovery'; }
        });
        await assert.rejects(validateTestCandidate('wrong', hooks, 5), /已使用一次 Writer 接手/);
        assert.equal(calls, 2);
        assert.equal(events.filter(e => e.detail?.action === 'writer-recovery').length, 1);
    }
});

test('candidate filenames do not hide retained, dropped or failed passing cases', () => {
    const feedback = new RepairFeedback('draft', '');
    assert.equal(feedback.record('test_keep (exec1_test.Cases.test_keep) ... ok', 'exec1_test').accepted, true);
    assert.equal(feedback.record('test_keep (exec2_test.Cases.test_keep) ... ok', 'exec2_test').accepted, true);
    assert.equal(feedback.record('test_other (exec3_test.Other.test_keep) ... ok', 'exec3_test').accepted, false);
    assert.equal(feedback.record('test_keep (exec4_test.Cases.test_keep) ... FAIL', 'exec4_test').accepted, false);
    assert.match(getBugFixerSystemPrompt(), /simple source-supported deterministic relationships/);
    assert.match(getBugFixerSystemPrompt(), /actual output alone is not proof/);
});
