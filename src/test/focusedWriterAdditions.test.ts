import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeFocusedWriterAdditions, FocusedWriterAdditionOptions } from '../pipeline/focusedWriterAdditions';
import type { QualityTaskEvidence } from '../pipeline/qualityTaskEvidence';
import type { TraceValue, TraceValueSnapshot } from '../pipeline/evidenceContracts';
import type { WriterAdditionMergeResult } from '../validation/testMerger';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const baseline = 'ORIGINAL EXECUTED BASELINE';
const snapshot = (value: TraceValue): TraceValueSnapshot => ({ schema_version: 'trace-value-v1', replayable: true, value });
function evidence(count = 3): QualityTaskEvidence {
    return { schemaVersion: 'quality-task-evidence-v1', runId: 'focused-writer-test', sourceHash: 'a'.repeat(64),
        target: 'sample', focusId: 'E0123456789abcdef', scenarioId: 'observations:E0123456789abcdef',
        cases: Array.from({ length: count }, (_, index) => {
            const fields = { args: { type: 'list', items: [{ type: 'int', value: String(index) }] } as TraceValue,
                kwargs: { type: 'dict', items: [] } as TraceValue,
                constructor_args: { type: 'list', items: [] } as TraceValue,
                constructor_kwargs: { type: 'dict', items: [] } as TraceValue };
            return { caseId: `case-${index}`, args: [String(index)], kwargs: {}, observedResult: String(index),
                input: { replayable: true,
                    call_graph: snapshot({ type: 'dict', items: Object.entries(fields).map(([key, value]) => ({
                        key: { type: 'str', value: key }, value })) }),
                    args: snapshot(fields.args), kwargs: snapshot(fields.kwargs),
                    constructor_args: snapshot(fields.constructor_args), constructor_kwargs: snapshot(fields.constructor_kwargs) },
                result: snapshot({ type: 'int', value: String(index) }) };
        }) };
}
const merged = (previous: string, addition: string, addedMethodsCount = 1): WriterAdditionMergeResult => ({ ok: true,
    mergedCode: previous + '\n' + addition, totalMethodsCount: 1 + addedMethodsCount,
    addedMethodsCount, addedMethods: Array.from({ length: addedMethodsCount }, (_, index) => ({
        className: 'AIAddition', name: `test_${index}` })) });
const options = (current = evidence()): FocusedWriterAdditionOptions => ({ baseline, evidence: current,
    request: async (one, _draft, ordinal) => `AI AUTHORED ${ordinal}:${one.cases[0].caseId}`,
    merge: async (previous, addition) => merged(previous, addition), validate: async () => undefined });

test('single-case AI requests compose sequentially without treating the draft as executed or approved', async () => {
    const current = evidence(), before = JSON.stringify(current), order: string[] = [], drafts: string[] = [], events: any[] = [];
    const opts = options(current);
    opts.request = async (one, draft, ordinal, total, correction) => {
        assert.equal(one.cases.length, 1);
        assert.equal(one.cases[0].caseId, current.cases[ordinal - 1].caseId);
        assert.equal(one.sourceHash, current.sourceHash); assert.equal(one.scenarioId, current.scenarioId);
        assert.equal(total, 3); assert.equal(correction, undefined);
        drafts.push(draft); order.push(`request-${ordinal}`);
        return `AI ${ordinal}`;
    };
    opts.merge = async (draft, addition) => { order.push(`merge-${addition}`); return merged(draft, addition); };
    opts.validate = async (code, one, previous) => {
        order.push(`validate-${one.cases[0].caseId}`);
        assert.equal(previous, drafts.at(-1)); assert.ok(code.startsWith(previous + '\n'));
        return undefined;
    };
    opts.onEvent = (status, detail) => events.push({ status, detail });
    const result = await composeFocusedWriterAdditions(opts);
    assert.deepEqual(result, { ok: true, code: baseline + '\nAI 1\nAI 2\nAI 3' });
    assert.deepEqual(drafts, [baseline, baseline + '\nAI 1', baseline + '\nAI 1\nAI 2']);
    assert.deepEqual(order, ['request-1', 'merge-AI 1', 'validate-case-0', 'request-2', 'merge-AI 2',
        'validate-case-1', 'request-3', 'merge-AI 3', 'validate-case-2']);
    assert.equal(JSON.stringify(current), before);
    assert.ok(events.every(item => item.detail.executionStatus === 'not-run' && item.detail.reviewStatus === 'not-run'));
    assert.deepEqual(events.map(item => item.status), ['requested', 'composed', 'requested', 'composed', 'requested', 'composed', 'completed']);
});

test('a failed later case returns its last addition and no partially composed candidate', async () => {
    const opts = options(); const drafts: string[] = [], ordinals: number[] = [], corrections: Array<string | undefined> = [];
    opts.request = async (_one, draft, ordinal, _total, correction) => {
        drafts.push(draft); ordinals.push(ordinal); corrections.push(correction); return `AI ${ordinal}`;
    };
    opts.validate = async (_code, one) => one.cases[0].caseId === 'case-0' ? undefined : 'focused-writer-case-unknown';
    const result = await composeFocusedWriterAdditions(opts);
    assert.deepEqual(result, { ok: false, reasonCode: 'focused-writer-case-unknown', addition: 'AI 2' });
    assert.ok(!('code' in result));
    assert.deepEqual(ordinals, [1, 2, 2, 2]);
    assert.deepEqual(drafts, [baseline, baseline + '\nAI 1', baseline + '\nAI 1', baseline + '\nAI 1']);
    assert.equal(corrections[1], undefined);
    assert.match(corrections[2]!, /focused-writer-case-unknown/);
    assert.match(corrections[3]!, /not yet executed or reviewed/);
});

test('contract correction retries the same exact case without admitting a failed draft', async () => {
    const opts = options(evidence(1)); let requests = 0;
    opts.request = async (one, draft, _ordinal, _total, correction) => {
        assert.equal(one.cases[0].caseId, 'case-0'); assert.equal(draft, baseline);
        assert.equal(correction === undefined, requests === 0);
        return ++requests === 1 ? 'WRONG AI INPUT' : 'CORRECT AI INPUT';
    };
    opts.validate = async code => code.includes('WRONG AI INPUT') ? 'quality-focus-input-mismatch' : undefined;
    assert.deepEqual(await composeFocusedWriterAdditions(opts), { ok: true, code: baseline + '\nCORRECT AI INPUT' });
    assert.equal(requests, 2);
});

test('contract correction incorporates specific mismatch feedback into correction prompt', async () => {
    const opts = options(evidence(1)); let requests = 0;
    let receivedCorrection = '';
    opts.request = async (one, draft, _ordinal, _total, correction) => {
        if (correction) { receivedCorrection = correction; }
        return ++requests === 1 ? 'WRONG AI INPUT' : 'CORRECT AI INPUT';
    };
    opts.validate = async code => code.includes('WRONG AI INPUT')
        ? { reasonCode: 'quality-focus-input-mismatch', detail: 'Expected target call: target(1, 2), but actual written call was: target(3, 4).' }
        : undefined;
    assert.deepEqual(await composeFocusedWriterAdditions(opts), { ok: true, code: baseline + '\nCORRECT AI INPUT' });
    assert.equal(requests, 2);
    assert.match(receivedCorrection, /quality-focus-input-mismatch/);
    assert.match(receivedCorrection, /Expected target call: target\(1, 2\), but actual written call was: target\(3, 4\)\./);
});

test('no-op and multi-method additions cannot complete a single-case microtask', async () => {
    for (const [count, reason] of [[0, 'focused-writer-no-new-methods'], [2, 'focused-writer-case-method-count']] as const) {
        const opts = options(evidence(1)); let requests = 0, validations = 0;
        opts.request = async () => { requests++; return 'AI ADDITION'; };
        opts.merge = async (draft, addition) => merged(draft, addition, count);
        opts.validate = async () => { validations++; return undefined; };
        assert.deepEqual(await composeFocusedWriterAdditions(opts), { ok: false, reasonCode: reason, addition: 'AI ADDITION' });
        assert.equal(requests, 3); assert.equal(validations, 0);
    }
});

test('empty replies are bounded and never reach AST composition', async () => {
    const opts = options(evidence(1)); let requests = 0, merges = 0;
    opts.request = async () => { requests++; return '  '; };
    opts.merge = async () => { merges++; return { ok: false, reasonCode: 'unexpected' }; };
    assert.deepEqual(await composeFocusedWriterAdditions(opts), { ok: false, reasonCode: 'focused-writer-empty-addition', addition: '  ' });
    assert.equal(requests, 3); assert.equal(merges, 0);
});

test('API timeout and validation tool exceptions propagate unchanged after any earlier draft', async () => {
    const timeout = new Error('fixture timeout'); timeout.name = 'AbortError';
    const opts = options(); const ordinals: number[] = [];
    opts.request = async (_one, _draft, ordinal) => { ordinals.push(ordinal); if (ordinal === 2) { throw timeout; } return 'AI 1'; };
    await assert.rejects(composeFocusedWriterAdditions(opts), error => error === timeout);
    assert.deepEqual(ordinals, [1, 2]);
    const tool = new AnalysisStageError('validation', 'facts-tool', 'fixture unavailable', { reasonCode: 'scope-tool-error' });
    const invalid = options(evidence(1)); let requests = 0;
    invalid.request = async () => { requests++; return 'AI'; };
    invalid.validate = async () => { throw tool; };
    await assert.rejects(composeFocusedWriterAdditions(invalid), error => error === tool);
    assert.equal(requests, 1);
});

test('merge tool failure or malformed success stops instead of asking the model to repair a tool', async () => {
    for (const result of [{ ok: false, reasonCode: 'merge-tool-error' },
        { ok: true, mergedCode: 'AI', totalMethodsCount: 1, addedMethodsCount: 1, addedMethods: [] }] as const) {
        const opts = options(evidence(1)); let requests = 0;
        opts.request = async () => { requests++; return 'AI'; };
        opts.merge = async () => result as unknown as WriterAdditionMergeResult;
        await assert.rejects(composeFocusedWriterAdditions(opts), error => error instanceof AnalysisStageError && error.category === 'validation');
        assert.equal(requests, 1);
    }
});

test('case projections are deeply immutable and the global evidence stays complete and unchanged', async () => {
    const current = evidence(), before = JSON.stringify(current), opts = options(current);
    opts.request = async one => {
        assert.ok(Object.isFrozen(one) && Object.isFrozen(one.cases) && Object.isFrozen(one.cases[0].input.args!.value.items));
        assert.throws(() => one.cases.push(current.cases[1]), TypeError);
        assert.throws(() => { one.cases[0].result.value.value = 'wrong'; }, TypeError);
        return 'AI';
    };
    opts.validate = async (_code, one) => { assert.equal(one.cases.length, 1); assert.ok(Object.isFrozen(one)); return undefined; };
    assert.equal((await composeFocusedWriterAdditions(opts)).ok, true);
    assert.equal(JSON.stringify(current), before); assert.equal(current.cases.length, 3);
});

test('invalid or over-limit evidence is refused before any model request', async () => {
    const duplicate = evidence(); duplicate.cases[1].caseId = duplicate.cases[0].caseId;
    const broken = evidence(); broken.cases[0].input.args!.value = { type: 'int', value: '2' };
    for (const current of [evidence(0), evidence(13), duplicate, broken, { ...evidence(), sourceHash: 'bad' }]) {
        const opts = options(current); let requests = 0;
        opts.request = async () => { requests++; return 'AI'; };
        assert.deepEqual(await composeFocusedWriterAdditions(opts), { ok: false, reasonCode: 'focused-writer-evidence-invalid' });
        assert.equal(requests, 0);
    }
});

test('twelve cases share a strict maximum of thirty-six contract attempts', async () => {
    const opts = options(evidence(12)), attempts = new Map<string, number>(); let requests = 0;
    opts.request = async one => { requests++; return `AI ${one.cases[0].caseId}`; };
    opts.validate = async (_code, one) => {
        const id = one.cases[0].caseId, count = (attempts.get(id) || 0) + 1;
        attempts.set(id, count); return count < 3 ? 'quality-focus-input-mismatch' : undefined;
    };
    const result = await composeFocusedWriterAdditions(opts);
    assert.equal(result.ok, true); assert.equal(requests, 36);
    assert.deepEqual([...attempts.values()], Array(12).fill(3));
});
