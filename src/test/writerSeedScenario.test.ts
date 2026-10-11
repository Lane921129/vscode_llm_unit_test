import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectWriterScenario, selectWriterSeedCaseIds, buildWriterRevisionContext } from '../prompts/compactWriterContext';
import { BehaviorObservations, TraceInputSnapshot, TraceValue, TraceValueSnapshot, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { parseBehaviorObservations } from '../pipeline/behaviorObservations';

const snap = (value: TraceValue): TraceValueSnapshot => ({ schema_version: 'trace-value-v1', replayable: true, value });
function input(value: string, state = '0'): TraceInputSnapshot {
    const fields = { args: snap({ type: 'tuple', items: [{ type: 'int', value }] }),
        kwargs: snap({ type: 'dict', items: [] }),
        constructor_args: snap({ type: 'tuple', items: [{ type: 'int', value: state }] }),
        constructor_kwargs: snap({ type: 'dict', items: [] }) };
    return { ...fields, replayable: true, call_graph: snap({ type: 'dict', items: Object.entries(fields)
        .map(([key, child]) => ({ key: { type: 'str', value: key }, value: child.value })) }) };
}
function observations(): BehaviorObservations {
    return { func_name: 'read', args: ['value'], run_id: 'neutral-run', complete: true, load_error: null,
        examples: ['1', '2'].map((value, index) => ({ case_id: `case-${index}`, args: [value], constructor_args: ['0'],
            result: value, call_assertable: true, result_assertable: true, inputs_mutated: false })), errors: [],
        cases: ['1', '2'].map((value, index) => ({ case_id: `case-${index}`, status: 'returned', source: { kind: 'caller_literals' },
            input_before: input(value), input_after: input(value), call_assertable: true, inputs_mutated: false, duration_ms: 1,
            result_snapshot: snap({ type: 'int', value }) })) };
}

test('seed selects one complete exact scenario without mutating full evidence or affecting revision context', () => {
    const all = observations(), before = JSON.stringify(all);
    const selected = selectWriterSeedCaseIds(all);
    assert.deepEqual(selected, ['case-0']);
    const projected = selectWriterScenario(all, selected);
    assert.equal(projected.observations?.examples.length, 1);
    assert.deepEqual(projected.observations?.examples[0], all.examples[0]);
    assert.deepEqual(projected.observations?.cases, [all.cases![0]]);
    assert.match(projected.note!, /Other cases remain in the artifact/);
    assert.equal(JSON.stringify(all), before);
    const evidence: WriterEvidenceBundleV3 = { schemaVersion: 'writer-evidence-v3', sourceHash: 'a'.repeat(64), semanticGuidance: '',
        ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'a'.repeat(64), ids: [], selectedRules: [],
            guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
        evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };
    const revision = buildWriterRevisionContext({ module: 'neutral', name: 'read', source: 'def read(value): return value',
        context: { traceResult: all }, scenarioCaseIds: selected, evidence });
    assert.match(revision, /case-0/); assert.match(revision, /case-1/);
});

test('unknown, incomplete, ambiguous and unassertable seed evidence retains all scenarios', () => {
    const changes: Array<(value: any) => void> = [
        value => { value.complete = false; }, value => { value.complete = 'true'; }, value => { value.complete = 1; },
        value => { delete value.run_id; },
        value => { value.load_error = 'load diagnostic'; }, value => { value.blocked_operations = ['network']; },
        value => { delete value.examples[0].case_id; }, value => { value.cases[1].case_id = value.cases[0].case_id; },
        value => { value.cases[1].input_before.replayable = false; },
        value => { delete value.cases[1].input_before.args; },
        value => { for (const item of value.examples) { item.call_assertable = false; } },
        value => { for (const item of value.examples) { item.result_assertable = false; } },
        value => { for (const item of value.examples) { item.result_truncated = true; } },
        value => { for (const item of value.examples) { item.oracle_reason = 'uncontrolled-ambient-read'; } },
        value => { for (const item of value.examples) { item.non_deterministic_operations = ['clock']; } },
        value => { for (const item of value.cases) { item.inputs_mutated = true; } },
        value => { for (const item of value.cases) { item.input_after = input('99'); } },
        value => { for (const item of value.cases) { delete item.result_snapshot; } }
    ];
    for (const change of changes) {
        const all = observations(); change(all);
        assert.equal(selectWriterSeedCaseIds(all), undefined, change.toString());
        assert.equal(selectWriterScenario(all, undefined).observations, all);
    }
    const all = observations();
    assert.equal(selectWriterScenario(all, ['stale-id']).observations, all);
});

test('live v2 optional assertion flags retain safe complete calls without fabricating flags', () => {
    const all = observations();
    all.schema_version = 'behavior-observations-v2'; all.isolation = 'fresh-process-per-case';
    for (const item of all.examples) { delete item.call_assertable; delete item.result_assertable; }
    for (const item of all.cases!) { delete item.call_assertable; }
    const parsed = parseBehaviorObservations(JSON.stringify(all), 'read');
    const before = JSON.stringify(parsed);
    assert.deepEqual(selectWriterSeedCaseIds(parsed), ['case-0']);
    assert.equal(JSON.stringify(parsed), before, 'selection never upgrades or rewrites the producer evidence');
    parsed.cases![1].input_before = input('1'); parsed.cases![1].input_after = input('1');
    (parsed.cases![1] as any).result_snapshot = snap({ type: 'int', value: '1' });
    parsed.examples[1].args = ['1']; parsed.examples[1].result = '1';
    assert.deepEqual(selectWriterSeedCaseIds(parsed), ['case-0'], 'identical complete same-call evidence uses the same optional-boolean contract');
});

test('false and malformed assertion flags never supply seed or same-call proof', () => {
    for (const field of ['call_assertable', 'result_assertable']) {
        for (const value of [false, null, 0, 1, 'true', 'false', {}]) {
            const all = observations();
            for (const item of all.examples) { (item as any)[field] = value; }
            assert.equal(selectWriterSeedCaseIds(all), undefined, `${field}=${JSON.stringify(value)}`);
            const same = observations();
            same.cases![1].input_before = input('1'); same.cases![1].input_after = input('1');
            (same.cases![1] as any).result_snapshot = snap({ type: 'int', value: '1' });
            same.examples[1].args = ['1']; same.examples[1].result = '1';
            (same.examples[1] as any)[field] = value;
            assert.equal(selectWriterSeedCaseIds(same), undefined, `same call: ${field}=${JSON.stringify(value)}`);
        }
    }
});

test('same-call conflict prevents selection while a different constructor remains a separate exact scenario', () => {
    const conflict = observations();
    conflict.cases![1].input_before = input('1'); conflict.cases![1].input_after = input('1');
    conflict.examples[1].args = ['1'];
    assert.equal(selectWriterSeedCaseIds(conflict), undefined, 'different results for the same typed input are not a seed oracle');
    const distinct = structuredClone(conflict);
    distinct.cases![1].input_before = input('1', '9'); distinct.cases![1].input_after = input('1', '9');
    distinct.examples[1].constructor_args = ['9'];
    assert.deepEqual(selectWriterSeedCaseIds(distinct), ['case-0']);
    assert.equal(selectWriterScenario(distinct, ['case-0']).observations!.examples[0].constructor_args![0], '0');
    const ambiguous = structuredClone(conflict);
    ambiguous.cases![1].status = 'timeout';
    assert.equal(selectWriterSeedCaseIds(ambiguous), undefined, 'unknown same-call outcome stays full evidence');
    const raised = structuredClone(conflict);
    raised.cases![1].status = 'raised';
    raised.errors.push({ ...raised.examples.pop()!, exception: 'ValueError' });
    assert.equal(selectWriterSeedCaseIds(raised), undefined, 'same call with a raised outcome cannot supply a return oracle');
    const ambient = structuredClone(conflict);
    (ambient.cases![1] as any).result_snapshot = (ambient.cases![0] as any).result_snapshot;
    ambient.examples[1].result = ambient.examples[0].result;
    ambient.examples[1].oracle_reason = 'uncontrolled-ambient-read';
    assert.equal(selectWriterSeedCaseIds(ambient), undefined, 'a matching result with an unsafe same-call observation is not proof');
});
