import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { QualityTaskEvidence } from '../pipeline/qualityTaskEvidence';
import { TraceInputSnapshot, TraceValue, TraceValueSnapshot } from '../pipeline/evidenceContracts';
import { scalarProbeInput, typedCallFields } from '../pipeline/probeInputs';
import { validTraceInputSnapshot } from '../pipeline/traceValues';
import { requestFocusedQualityTask } from '../roles/qualityAnalyst';
import { qualityAnalystContractVersion, ROLE_CONTRACT_VERSIONS } from '../roles/roleContracts';

test('quality contracts distinguish proposed scenarios from already executed focus observations', async () => {
    assert.equal(ROLE_CONTRACT_VERSIONS.qualityAnalyst, 'quality-task-v3');
    assert.equal(ROLE_CONTRACT_VERSIONS.qualityAnalystGrounded, 'quality-task-v4');
    const identity = { runId: 'quality-contract-fixture', sourceHash: 'a'.repeat(64), target: 'score' };
    const focus = { id: 'E0123456789abcdef', kind: 'coverage' as const, evidence: 'line 4 not executed' };
    const call = scalarProbeInput({ args: [2], kwargs: {} }).input;
    const fields = typedCallFields(call)!;
    const snapshot = (value: TraceValue): TraceValueSnapshot => ({ schema_version: 'trace-value-v1', replayable: true, value });
    const constructorArgs: TraceValue = { type: 'list', items: [] };
    const constructorKwargs: TraceValue = { type: 'dict', items: [] };
    call.value.items!.push({ key: { type: 'str', value: 'constructor_args' }, value: constructorArgs },
        { key: { type: 'str', value: 'constructor_kwargs' }, value: constructorKwargs });
    const input: TraceInputSnapshot = { replayable: true, call_graph: call,
        args: snapshot(fields.args), kwargs: snapshot(fields.kwargs),
        constructor_args: snapshot(constructorArgs), constructor_kwargs: snapshot(constructorKwargs) };
    assert.equal(validTraceInputSnapshot(input), true);
    const observations: QualityTaskEvidence = { ...identity, schemaVersion: 'quality-task-evidence-v1',
        focusId: focus.id, scenarioId: `observations:${focus.id}`, cases: [{ caseId: 'case-1',
            input, args: ['2'], kwargs: {}, observedResult: '3',
            result: { schema_version: 'trace-value-v1', replayable: true, value: { type: 'int', value: '3' } } }] };
    for (const grounded of [false, true]) {
        const prompts: string[] = [];
        const recorded: Array<{ status: string; detail: unknown }> = [];
        const tasks = await requestFocusedQualityTask({ focus, context: 'complete current source and tests',
            deadlineAt: 1000, now: () => 100, checkCancelled: () => {},
            ...(grounded ? { observations, identity } : {}),
            request: async prompt => { prompts.push(prompt); return '{"tasks":[]}'; },
            event: (status, detail) => recorded.push({ status, detail }) });
        assert.deepEqual(tasks, []);
        assert.equal(prompts.length, 1);
        assert.ok(prompts[0].startsWith(grounded ? 'QUALITY_TASK_V4\n' : 'QUALITY_TASK_V3\n'));
        const parsed = recorded.find(item => item.status === 'parsed-hypotheses')!.detail as { contractVersion: string };
        assert.equal(parsed.contractVersion, qualityAnalystContractVersion(grounded));
        assert.equal(parsed.contractVersion, grounded ? 'quality-task-v4' : 'quality-task-v3');
    }
});
