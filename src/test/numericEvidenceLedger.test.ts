import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NumericEvidenceLedger } from '../pipeline/numericEvidenceLedger';
import { scalarProbeInput } from '../pipeline/probeInputs';
import { evidenceHash } from '../pipeline/analysisJournal';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const identity = { runId: 'test-run', sourceHash: evidenceHash('source'), target: 'target' };
const prefix = 'VERIFIED NUMERIC OBSERVATIONS (evidence only; the AI must revise the test):\n';
function correction(input: number | boolean | string, result = '2') {
    return { method: 'Cases.test_value', line: 5, previous: 999, calculated: Number(result),
        basis: { inputs: { value: input }, steps: ['calculator details'], result: Number(result),
            call: scalarProbeInput({ args: [input], kwargs: {} }).input,
            result_snapshot: { schema_version: 'trace-value-v1', replayable: true, value: { type: 'int', value: result } } } };
}
function handoff(corrections: unknown[], patch: Record<string, unknown> = {}) {
    return prefix + JSON.stringify({ schemaVersion: 'numeric-observation-handoff-v1', ...identity,
        testHash: evidenceHash('test'), corrections, limitation: 'Current behavior only.', ...patch });
}
function payload(prompt: string) { return JSON.parse(prompt.slice(prompt.indexOf('{'))); }

test('numeric observations persist across role calls and deduplicate the same typed call and outcome', () => {
    const ledger = new NumericEvidenceLedger(identity);
    assert.equal(ledger.hasEvidence, false); assert.equal(ledger.prompt(0), '');
    assert.equal(ledger.add(undefined).addedCases, 0);
    assert.equal(ledger.add(handoff([correction(1)])).addedCases, 1);
    assert.equal(ledger.add(handoff([{ ...correction(1), method: 'Cases.other', line: 99 }],
        { testHash: evidenceHash('new test') })).duplicateCases, 1);
    assert.equal(ledger.add(handoff([correction(2, '3')])).addedCases, 1);
    const writer = ledger.prompt(12000), reviewer = ledger.prompt(12000);
    assert.equal(writer, reviewer);
    const value = payload(writer);
    assert.equal(value.includedSegments, 2); assert.equal(value.includedCases, 2);
    assert.equal(value.omittedSegments, 0); assert.equal(value.omittedCases, 0);
    assert.equal(value.runId, identity.runId); assert.equal(value.sourceHash, identity.sourceHash);
    assert.equal(value.segments[0].observations[0].result_snapshot.value.value, '3');
    assert.doesNotMatch(writer, /calculator details|"calculated"|"previous"|"method"/);
    assert.equal(ledger.add(handoff([correction(true, '2'), correction('1', '2')])).addedCases, 2,
        'boolean, integer and string inputs are distinct typed evidence');
});

test('source, target and run identity mismatch cannot enter an existing evidence ledger', () => {
    const ledger = new NumericEvidenceLedger(identity);
    for (const patch of [{ sourceHash: evidenceHash('changed') }, { runId: 'other-run' }, { target: 'other' },
        { testHash: 'missing' }, { schemaVersion: 'invented' }]) {
        assert.throws(() => ledger.add(handoff([correction(1)], patch)),
            (error: unknown) => error instanceof AnalysisStageError && error.stage === 'numeric-evidence');
    }
    assert.equal(ledger.hasEvidence, false);
});

test('malformed, unassertable, and sensitive observations are rejected atomically', () => {
    const secret = 'PRIVATE_NUMERIC_VALUE_123456';
    const ledger = new NumericEvidenceLedger(identity, [secret]);
    const invalidCall = correction(1); invalidCall.basis.call.replayable = false;
    const invalidResult = correction(1); invalidResult.basis.result_snapshot.replayable = false;
    for (const value of [handoff([correction(1), invalidCall]), handoff([invalidResult]), prefix + '{',
        handoff([correction(secret)]), handoff([])]) {
        assert.throws(() => ledger.add(value), AnalysisStageError);
        assert.equal(ledger.hasEvidence, false);
    }
    const exceptional = correction(0) as any;
    delete exceptional.basis.result_snapshot;
    exceptional.basis.exception = { module: 'builtins', qualname: 'ZeroDivisionError' };
    ledger.add(handoff([exceptional]));
    assert.equal(payload(ledger.prompt(12000)).segments[0].observations[0].exception.qualname, 'ZeroDivisionError');
});

test('prompt projection omits whole observations and explicitly reports missing segments', () => {
    const ledger = new NumericEvidenceLedger(identity);
    ledger.add(handoff([correction('a'.repeat(500))]));
    ledger.add(handoff([correction('b'.repeat(500), '3')]));
    const full = ledger.prompt(12000);
    const partial = ledger.prompt(full.length - 100);
    const value = payload(partial);
    assert.ok(partial.length <= full.length - 100);
    assert.equal(value.includedSegments, 1); assert.equal(value.omittedSegments, 1);
    assert.equal(value.includedCases, 1); assert.equal(value.omittedCases, 1);
    assert.equal(value.segments[0].observations[0].result_snapshot.value.value, '3', 'newest complete segment has priority');
    assert.equal(value.segments[0].observations[0].call.value.items[0].value.items[0].value, 'b'.repeat(500));
    assert.throws(() => ledger.prompt(1), (error: unknown) => error instanceof AnalysisStageError
        && error.category === 'budget' && error.stage === 'prompt-budget');
    assert.equal(payload(ledger.prompt(12000)).includedCases, 2, 'projection never deletes retained facts');
});

test('retained observations stay bounded to eight complete segments and report eviction', () => {
    const ledger = new NumericEvidenceLedger(identity);
    for (let i = 0; i < 9; i++) { ledger.add(handoff([correction(i, String(i + 1))])); }
    const value = payload(ledger.prompt(50000));
    assert.equal(value.includedSegments, 8); assert.equal(value.omittedSegments, 1);
    assert.equal(value.includedCases, 8); assert.equal(value.omittedCases, 1);
    assert.equal(value.segments[0].observations[0].result_snapshot.value.value, '9');
    assert.equal(value.segments.at(-1).observations[0].result_snapshot.value.value, '2');
});
