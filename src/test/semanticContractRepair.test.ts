import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticWithContractRepair, SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE, SEMANTIC_CONTRACT_REPAIR_SUFFIX } from '../roles/semanticContractRepair';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { runWithTargetBudget, TargetBudget } from '../pipeline/targetBudget';

test('semantic format correction preserves complete evidence and shares one deadline without logging raw output', async () => {
    const prompt = 'complete source\nexact observations\nall dependency facts';
    const requests: string[] = [], events: unknown[] = [];
    let clock = 5;
    const result = await semanticWithContractRepair({ prompt, deadlineAt: 100, now: () => clock,
        checkCurrent: () => {}, event: (status, detail) => events.push({ status, detail }),
        request: async (text, deadline, reserve) => {
            assert.equal(deadline, 100); requests.push(text); clock += 10;
            assert.equal(reserve, requests.length === 1 ? SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE : 0);
            return requests.length === 1 ? 'PRIVATE_RESPONSE_NOT_JSON' : '{"test_strategy":{"approach":"verify observed boundary","input_hints":[]}}';
        } });
    assert.equal(result?.test_strategy.approach, 'verify observed boundary');
    assert.equal(requests.length, 2);
    assert.ok(requests[1].startsWith(prompt + '\n\nSEMANTIC_CONTRACT_REPAIR_V1'));
    assert.equal(requests[1], prompt + SEMANTIC_CONTRACT_REPAIR_SUFFIX);
    assert.doesNotMatch(requests[1] + JSON.stringify(events), /PRIVATE_RESPONSE_NOT_JSON/);
    assert.match(JSON.stringify(events), /responseHash/);
});

test('invalid semantic output has only one correction and never becomes an empty successful plan', async () => {
    let calls = 0;
    const result = await semanticWithContractRepair({ prompt: 'evidence', deadlineAt: 100, now: () => 0,
        checkCurrent: () => {}, event: () => {}, request: async () => { calls++; return calls === 1 ? '{"dependency_behaviors":[]}' : '{"test_strategy":{}}'; } });
    assert.equal(calls, 2); assert.equal(result, undefined);
});

test('fixed correction reserve fits the same complete prompt and host envelope without relying on rounding', async () => {
    for (const evidence of ['source', 'source\r\n證據\n', '完整來源' + 'a'.repeat(3001)]) {
        const system = 'Role and output contract\n';
        const resources = '\nHost-approved setup and schema';
        const ceiling = estimatePromptTokens(system + evidence + resources) + SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE;
        let sent = 0;
        await semanticWithContractRepair({ prompt: evidence, deadlineAt: 100, now: () => 0, checkCurrent: () => {}, event: () => {},
            request: async (prompt, _deadline, reserve) => {
                assert.ok(estimatePromptTokens(system + prompt + resources) + reserve <= ceiling);
                sent++; return sent === 1 ? '{}' : '{"test_strategy":{"approach":"Exercise the exact observed call."}}';
            } });
        assert.equal(sent, 2);
    }
});

test('required evidence that cannot leave repair room is rejected before model transport', async () => {
    const prompt = 'Complete source and required setup';
    const ceiling = estimatePromptTokens(prompt) + SEMANTIC_CONTRACT_REPAIR_INPUT_RESERVE - 1;
    let transports = 0;
    await assert.rejects(semanticWithContractRepair({ prompt, deadlineAt: 100, now: () => 0,
        checkCurrent: () => {}, event: () => {}, request: async (text, _deadline, reserve) => {
            if (estimatePromptTokens(text) + reserve > ceiling) { throw new AnalysisStageError('validation', 'prompt-budget', 'required evidence does not fit'); }
            transports++; return '{}';
        } }), (error: unknown) => error instanceof AnalysisStageError && error.stage === 'prompt-budget');
    assert.equal(transports, 0);
});

test('semantic transport, budget, cancellation, source drift and expired deadlines never start another request', async () => {
    for (const kind of ['transport', 'budget', 'cancelled', 'source-changed', 'deadline'] as const) {
        let calls = 0, checks = 0, clock = 0;
        const error = kind === 'budget' ? new AnalysisStageError('budget', 'prompt-budget', 'oversize') : new Error(kind);
        await assert.rejects(semanticWithContractRepair({ prompt: 'evidence', deadlineAt: 100, now: () => clock,
            checkCurrent: () => { if (++checks === 2 && ['cancelled', 'source-changed'].includes(kind)) { throw error; } },
            event: () => {}, request: async () => {
                calls++;
                if (['transport', 'budget'].includes(kind)) { throw error; }
                if (kind === 'deadline') { clock = 100; }
                return 'invalid';
            } }), failure => kind === 'deadline'
            ? failure instanceof AnalysisStageError && failure.category === 'timeout' : failure === error);
        assert.equal(calls, 1, kind);
    }
});

test('format correction cannot reset the enclosing target deadline', async () => {
    let clock = 10, calls = 0;
    const budget = new TargetBudget({ now: () => clock, timeoutMs: 30 });
    await assert.rejects(runWithTargetBudget(budget, () => semanticWithContractRepair({
        prompt: 'Complete source and exact observations', deadlineAt: 100, now: () => clock,
        checkCurrent: () => {}, event: () => {}, request: async (_prompt, deadline) => {
            assert.equal(deadline, 40);
            calls++; clock = 40;
            return '{}';
        }
    })), (failure: unknown) => failure instanceof AnalysisStageError && failure.category === 'timeout');
    assert.equal(calls, 1);
});

test('target parameter filtering cannot convert an irrelevant hint into a successful empty plan', async () => {
    for (const repairWithPlan of [false, true]) {
        let calls = 0;
        const statuses: string[] = [];
        const result = await semanticWithContractRepair({ prompt: 'def selected(): return None', deadlineAt: 100,
            targetParameters: [], now: () => 0, checkCurrent: () => {}, event: status => statuses.push(status),
            request: async (_prompt, deadline) => {
                assert.equal(deadline, 100);
                return ++calls === 2 && repairWithPlan
                    ? '{"test_strategy":{"approach":"Call the zero-parameter target and verify the same controlled observation."}}'
                    : '{"test_strategy":{"input_hints":[{"param_name":"invented","strategy":"Exercise the neutral branch.","boundary_inputs":["0"]}]}}';
            } });
        assert.equal(calls, 2);
        assert.deepEqual(statuses, ['invalid-response', 'repair-requested', repairWithPlan ? 'parsed' : 'invalid-response']);
        if (repairWithPlan) { assert.ok(result); assert.deepEqual(result.test_strategy.input_hints, []); }
        else { assert.equal(result, undefined); }
    }
});
