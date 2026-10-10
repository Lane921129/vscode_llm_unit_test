import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticWithContractRepair } from '../roles/semanticContractRepair';
import { AnalysisStageError } from '../utils/executionFailureCategory';

test('semantic format correction preserves complete evidence and shares one deadline without logging raw output', async () => {
    const prompt = 'complete source\nexact observations\nall dependency facts';
    const requests: string[] = [], events: unknown[] = [];
    let clock = 5;
    const result = await semanticWithContractRepair({ prompt, deadlineAt: 100, now: () => clock,
        checkCurrent: () => {}, event: (status, detail) => events.push({ status, detail }),
        request: async (text, deadline) => {
            assert.equal(deadline, 100); requests.push(text); clock += 10;
            return requests.length === 1 ? 'PRIVATE_RESPONSE_NOT_JSON' : '{"test_strategy":{"approach":"verify observed boundary","input_hints":[]}}';
        } });
    assert.equal(result?.test_strategy.approach, 'verify observed boundary');
    assert.equal(requests.length, 2);
    assert.ok(requests[1].startsWith(prompt + '\n\nSEMANTIC_CONTRACT_REPAIR_V1'));
    assert.doesNotMatch(requests[1] + JSON.stringify(events), /PRIVATE_RESPONSE_NOT_JSON/);
    assert.match(JSON.stringify(events), /responseHash/);
});

test('invalid semantic output has only one correction and never becomes an empty successful plan', async () => {
    let calls = 0;
    const result = await semanticWithContractRepair({ prompt: 'evidence', deadlineAt: 100, now: () => 0,
        checkCurrent: () => {}, event: () => {}, request: async () => { calls++; return '{"error":"invalid"}'; } });
    assert.equal(calls, 2); assert.equal(result, undefined);
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
