import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildReviewFacts, ReviewFacts, reviewFactsForPrompt } from '../roles/reviewFacts';
import { getTestReviewerSystemPrompt, parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';
import { scalarProbeInput, typedCallFields } from '../pipeline/probeInputs';
import { BehaviorObservations, TraceValueSnapshot } from '../pipeline/evidenceContracts';

const identity = { runId: 'exception-review-test', sourceHash: 'a'.repeat(64), target: 'score' };
const code = 'import unittest\nfrom sample import score\nclass Cases(unittest.TestCase):\n'
    + '    def test_value(self):\n        weight = 1\n        bmi, status = score(weight, 1)\n'
    + '        self.assertEqual(bmi, 10000.0)\n        self.assertEqual(status, "high")\n';
const result: TraceValueSnapshot = { schema_version: 'trace-value-v1', replayable: true,
    value: { type: 'tuple', items: [{ type: 'float', value: '10000.0' }, { type: 'str', value: 'high' }] } };
const options = (tests = code) => ({ ...identity, code: tests, module: 'sample', executionVerified: true,
    python: path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), env: process.env });
const ledger = (args: unknown[] = [1, 1], observed = result) => 'VERIFIED_NUMERIC_EVIDENCE_LEDGER_V1\n' + JSON.stringify({
    schemaVersion: 'numeric-evidence-ledger-v1', ...identity,
    segments: [{ observations: [{ call: scalarProbeInput({ args, kwargs: {} }).input, result_snapshot: observed }] }]
});
let cached: Promise<ReviewFacts> | undefined;
const facts = () => cached ||= buildReviewFacts({ ...options(), numericEvidencePrompt: ledger() });
const constraints = (value: ReviewFacts): ReviewConstraints => ({ target: identity.target,
    methodKind: 'module', module: 'sample', identity, facts: value });
const response = (reason: string, action: string, line = 7) => JSON.stringify({ findings: [{
    category: 'assertion-quality', test_line: `L${line}`, reason, action }] });
const actualReason = 'The assertion is not checking the expected exception, but rather the expected return value.';
const actualAction = 'Change the assertion to check for the expected exception instead of the expected return value.';

test('the saved BMI return-to-unnamed-exception finding requires a new assessment, never a Writer revision', async () => {
    const current = await facts();
    assert.equal(current.methods[0].calls[0].observationReturned, true);
    assert.equal(current.methods[0].assertions[0].targetCallLine, 6);
    const parsed = parseTestReviewDetailed(response(actualReason, actualAction), code, true, constraints(current));
    assert.equal(parsed.review, undefined);
    assert.deepEqual(parsed.diagnostics, ['exception-evidence-missing', 'expected-exception-contradiction']);
});

test('a concrete class does not make a same-input observed return become an exception', async () => {
    const current = await facts();
    for (const [reason, action] of [
        ['For score(1, 1), the Trace requires ZeroDivisionError.', 'Replace the assertion with self.assertRaises(ZeroDivisionError).'],
        ['The observation for score(1, 1) raises MissingInput.', 'Change the assertion to check the expected exception class MissingInput.'],
        ['The observed input raises ValueError.', 'Replace the assertion with assertRaises(ValueError) for score(1, 1).']
    ]) {
        assert.deepEqual(parseTestReviewDetailed(response(reason, action), code, true, constraints(current)).diagnostics,
            ['expected-exception-contradiction']);
    }
});

test('changed inputs, independent business requirements and evidence requests remain reviewable', async () => {
    const current = await facts();
    for (const [reason, action] of [
        ['A different input score(1, 0) has an observed ZeroDivisionError.', 'Add a separate input case using assertRaises(ZeroDivisionError).'],
        ['The observation raises ZeroDivisionError for zero height.', 'Replace the assertion with assertRaises(ZeroDivisionError) for score(1, 0).'],
        ['The documented business contract requires ValueError for score(1, 1), despite current behavior.', 'Change the assertion to assertRaises(ValueError) for score(1, 1).'],
        ['This separate callback has no verified exception class.', 'Request a controlled observation of that callback before adding its check.'],
        ['The source explicitly raises a custom exception on a new input.', 'Add an additional input case and establish the exact exception class.'],
        ['The expected exception class custom_failure is stated by the supplied contract.', 'Replace the assertion with self.assertRaises(custom_failure).']
    ]) {
        assert.ok(parseTestReviewDetailed(response(reason, action), code, true, constraints(current)).review, reason);
    }
});

test('a named exception without any evidence is a verification gap, not an executable correction', async () => {
    const unknown = await buildReviewFacts(options());
    const named = response('The input must raise ValueError.', 'Replace the assertion with self.assertRaises(ValueError).');
    assert.deepEqual(parseTestReviewDetailed(named, code, true, constraints(unknown)).diagnostics, ['exception-evidence-missing']);
    assert.ok(parseTestReviewDetailed(response('The source explicitly raises ValueError for this input.',
        'Replace the assertion with self.assertRaises(ValueError).'), code, true, constraints(unknown)).review);
    assert.ok(parseTestReviewDetailed(response('The Trace observed MissingInput for this input.',
        'Replace the assertion with self.assertRaises(MissingInput).'), code, true, constraints(unknown)).review);
    assert.ok(parseTestReviewDetailed(response('An exception hypothesis needs a controlled observation.',
        'Verify the concrete exception for score(1, 1) with a controlled observation.'), code, true, constraints(unknown)).review);
});

test('typed or conflicting inputs, unknown setup and unverified execution never prove a return contradiction', async () => {
    const changedType = await buildReviewFacts({ ...options(), numericEvidencePrompt: ledger([1, true]) });
    assert.equal(changedType.methods[0].calls[0].observationReturned, undefined);
    const conflicting = JSON.parse(ledger().split('\n')[1]);
    conflicting.segments[0].observations.push({ call: scalarProbeInput({ args: [1, 1], kwargs: {} }).input,
        result_snapshot: { ...result, value: { type: 'tuple', items: [{ type: 'float', value: '99.0' }] } } });
    const conflict = await buildReviewFacts({ ...options(), numericEvidencePrompt: 'VERIFIED_NUMERIC_EVIDENCE_LEDGER_V1\n' + JSON.stringify(conflicting) });
    assert.equal(conflict.methods[0].calls[0].observationReturned, undefined);
    const setupCode = code.replace('    def test_value', '    def setUp(self):\n        self.value = 3\n    def test_value');
    const setup = await buildReviewFacts({ ...options(setupCode), numericEvidencePrompt: ledger() });
    assert.equal(setup.methods[0].calls[0].observationReturned, undefined);
    const specific = response('The Trace observed ValueError for score(1, 1).', 'Replace the assertion with self.assertRaises(ValueError).');
    for (const current of [changedType, conflict, { ...await facts(), executionVerified: false }]) {
        assert.ok(parseTestReviewDetailed(specific, code, true, constraints(current)).review);
    }
});

test('literal call identity is per assertion and cannot borrow an observation from another input in the method', async () => {
    const tests = code.replace('        self.assertEqual(status, "high")',
        '        self.assertEqual(status, "high")\n        other, label = score(1, 0)\n        self.assertEqual(other, 0.0)');
    const current = await buildReviewFacts({ ...options(tests), numericEvidencePrompt: ledger() });
    assert.equal(current.methods[0].assertions[2].targetCallLine, 9);
    assert.equal(current.methods[0].calls.find(call => call.line === 9)?.observationReturned, undefined);
    const finding = response('The Trace observed ValueError for score(1, 0).',
        'Replace the assertion with self.assertRaises(ValueError).', 10);
    assert.ok(parseTestReviewDetailed(finding, tests, true, constraints(current)).review);
});

test('facts projection keeps exact-return flags without copying literal inputs or source spellings', async () => {
    const prompt = reviewFactsForPrompt(await facts());
    const json = JSON.parse(prompt.split('\n')[1]);
    assert.deepEqual(json.methods[0].calls, [{ line: 6, observationReturned: true }]);
    assert.equal(json.methods[0].assertions[0].targetCallLine, 6);
    assert.equal(json.methods[0].calls[0].call, undefined);
    assert.equal(json.methods[0].calls[0].spellings, undefined);
    assert.match(getTestReviewerSystemPrompt(), /exact input, a concrete exception class/);
});

test('repeated exception hallucinations cannot erase findings, approve the candidate or extend the deadline', async () => {
    const current = await facts();
    const bad = response(actualReason, actualAction);
    const requests: Array<{ prompt: string; deadline: number }> = [];
    const reviewed = await reviewWithContractRepair({ tests: code, prompt: 'same complete candidate and evidence',
        constraints: constraints(current), deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async (prompt, deadline) => { requests.push({ prompt, deadline }); return bad; } });
    assert.equal(reviewed, undefined);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(item => item.deadline), [1000, 1000]);
    assert.match(requests[1].prompt, /exception-evidence-missing/);
    assert.match(requests[1].prompt, /expected-exception-contradiction/);
    let count = 0;
    const valid = await reviewWithContractRepair({ tests: code, prompt: 'same complete candidate and evidence',
        constraints: constraints(current), deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async () => ++count === 1 ? bad : '{"findings":[]}' });
    assert.deepEqual(valid, { issues: [] });
    assert.equal(count, 2, 'only a fresh Reviewer response can approve');
});

test('an incomplete Trace cannot become exact-return evidence even if its diagnostic example looks correct', async () => {
    const trace: BehaviorObservations = { schema_version: 'behavior-observations-v2', run_id: 'worker', func_name: 'score',
        args: ['weight', 'height'], complete: false, isolation: 'fresh-process-per-case', load_error: null, errors: [],
        examples: [{ case_id: 'c1', args: ['1', '1'], result: '(10000.0, "high")', call_assertable: true, result_assertable: true }], cases: [] };
    const current = await buildReviewFacts({ ...options(), observations: { ...identity, value: trace } });
    assert.equal(current.methods[0].calls[0].observationReturned, undefined);
});

test('only completed controlled same-input Trace returns can contradict an exception proposal', async () => {
    const fields = typedCallFields(scalarProbeInput({ args: [1, 1], kwargs: {} }).input)!;
    const input = { replayable: true,
        args: { schema_version: 'trace-value-v1' as const, replayable: true, value: fields.args },
        kwargs: { schema_version: 'trace-value-v1' as const, replayable: true, value: fields.kwargs },
        constructor_args: { schema_version: 'trace-value-v1' as const, replayable: true, value: { type: 'list', items: [] } },
        constructor_kwargs: { schema_version: 'trace-value-v1' as const, replayable: true, value: { type: 'dict', items: [] } },
        call_graph: {} as TraceValueSnapshot };
    input.call_graph = { schema_version: 'trace-value-v1', replayable: true, value: { type: 'dict',
        items: (['args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const)
            .map(key => ({ key: { type: 'str', value: key }, value: input[key].value })) } };
    const trace: BehaviorObservations = { schema_version: 'behavior-observations-v2', run_id: 'worker', func_name: 'score',
        args: ['weight', 'height'], complete: true, isolation: 'fresh-process-per-case', load_error: null, errors: [],
        examples: [{ case_id: 'c1', args: ['1', '1'], result: '(10000.0, "high")', call_assertable: true, result_assertable: true }],
        cases: [{ case_id: 'c1', source: { kind: 'caller_literals' }, status: 'returned', duration_ms: 1,
            input_before: input, input_after: structuredClone(input), result_snapshot: result } as any] };
    const current = await buildReviewFacts({ ...options(), observations: { ...identity, value: trace } });
    assert.equal(current.methods[0].calls[0].observationReturned, true);
    assert.ok(parseTestReviewDetailed(response(actualReason, actualAction), code, true, constraints(current)).diagnostics
        .includes('expected-exception-contradiction'));
    for (const change of [(value: BehaviorObservations) => { value.complete = false; },
        (value: BehaviorObservations) => { value.examples[0].result_assertable = false; },
        (value: BehaviorObservations) => { value.cases![0].inputs_mutated = true; },
        (value: BehaviorObservations) => { value.examples[0].oracle_reason = 'uncontrolled-ambient-read'; }]) {
        const invalid = structuredClone(trace); change(invalid);
        const unknown = await buildReviewFacts({ ...options(), observations: { ...identity, value: invalid } });
        assert.equal(unknown.methods[0].calls[0].observationReturned, undefined);
    }
    await assert.rejects(buildReviewFacts({ ...options(), observations: { ...identity, sourceHash: 'b'.repeat(64), value: trace } }), /bound to this candidate/);
});
