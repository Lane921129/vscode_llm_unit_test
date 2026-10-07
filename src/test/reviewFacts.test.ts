import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildReviewFacts, ReviewFacts } from '../roles/reviewFacts';
import { parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';
import { NumericEvidenceLedger } from '../pipeline/numericEvidenceLedger';
import { scalarProbeInput, typedCallFields } from '../pipeline/probeInputs';
import { BehaviorObservations, TraceValueSnapshot } from '../pipeline/evidenceContracts';

const identity = { runId: 'review-facts-test', sourceHash: 'a'.repeat(64), target: 'score' };
const code = 'import unittest\nfrom sample import score\nclass Cases(unittest.TestCase):\n'
    + '    def test_value(self):\n        value = 100\n        expected = 30.86\n'
    + '        number, label = score(value, 180)\n        self.assertEqual(number, expected)\n'
    + '        self.assertEqual(label, "high")\n'
    + '    def test_zero(self):\n        with self.assertRaises(ZeroDivisionError):\n            score(1, 0)\n';
const result: TraceValueSnapshot = { schema_version: 'trace-value-v1', replayable: true,
    value: { type: 'tuple', items: [{ type: 'float', value: '30.86' }, { type: 'str', value: 'high' }] } };
const ledger = new NumericEvidenceLedger(identity);
ledger.add('VERIFIED NUMERIC OBSERVATIONS (evidence only; the AI must revise the test):\n' + JSON.stringify({
    schemaVersion: 'numeric-observation-handoff-v1', ...identity, testHash: 'b'.repeat(64),
    corrections: [{ method: 'test_value', line: 8, basis: { call: scalarProbeInput({ args: [100, 180], kwargs: {} }).input, result_snapshot: result } }]
}));
let cached: Promise<ReviewFacts> | undefined;
const facts = () => cached ||= buildReviewFacts({ ...identity, code, module: 'sample',
    python: path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    env: process.env, executionVerified: true, numericEvidencePrompt: ledger.prompt(10000) });
const constraints = (value: ReviewFacts): ReviewConstraints => ({ target: identity.target, methodKind: 'module', module: 'sample', identity, facts: value });
const response = (line: number, category: string, reason: string, action: string) => JSON.stringify({ findings: [{ category,
    test_line: `L${line}`, reason, action }] });

test('AST and exact observation facts reject the actual hallucination shapes without changing code', async () => {
    const current = await facts();
    assert.equal(current.methods[0].assertions[0].observationVerified, true);
    const cases: Array<[number, string, string, string, string]> = [
        [3, 'target-binding', 'The target is bound to the class, but it should be bound to the module.', 'Change target binding to module.', 'target-binding-contradiction'],
        [8, 'assertion-quality', 'Expected number should be 30.857, not 30.86.', 'Change the expected value to 30.857.', 'observed-outcome-contradiction'],
        [9, 'assertion-quality', 'The expected classification should be low.', 'Change the expected label to "low".', 'observed-outcome-contradiction'],
        [9, 'assertion-quality', 'A specific string is too strict.', 'Use self.assertGreaterEqual() or self.assertIn() instead.', 'assertion-weakening'],
        [8, 'assertion-evidence', 'The value is not directly asserted in the test.', 'Add an assertion for the expected value.', 'existing-assertion-contradiction'],
        [12, 'assertion-evidence', 'assertRaises should be used to assert an exception.', 'Replace assertRaises with assertRaisesRegex.', 'expected-exception-contradiction'],
        [10, 'setup-error', 'The input will cause a division by zero error.', 'Use valid values instead.', 'expected-exception-contradiction'],
        [5, 'mock-isolation', 'The dependent input should be mocked.', 'Mock the value object.', 'scalar-mock-contradiction'],
        [1, 'setup-error', 'import unittest should be the first statement in the test file.', 'Move import unittest to the first line.', 'existing-import-contradiction'],
        [2, 'target-binding', 'Target binding should be module.', 'Change target binding to module.', 'target-binding-contradiction']
    ];
    for (const [line, category, reason, action, rejection] of cases) {
        const parsed = parseTestReviewDetailed(response(line, category, reason, action), code, true, constraints(current));
        assert.equal(parsed.review, undefined, reason);
        assert.ok(parsed.diagnostics.includes(rejection as any), `${reason}: ${parsed.diagnostics}`);
    }
});

test('genuine gaps, stronger assertions and unknown result claims remain reviewable', async () => {
    const current = await facts();
    for (const [line, category, reason, action] of [
        [8, 'missing-scenario', 'A measured branch still has no scenario.', 'Add a new input for the measured branch.'],
        [9, 'assertion-quality', 'The test lacks the neighboring category boundary.', 'Add the boundary input and verify its observed label.'],
        [12, 'assertion-quality', 'Only the exception type is checked; the supplied contract requires its message.', 'Add assertRaisesRegex for the documented message.'],
        [5, 'mock-isolation', 'The external dependency clock is uncontrolled.', 'Patch sample.clock at its use point.']
    ] as const) {
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), code, true, constraints(current)).review, reason);
    }
    for (const [line, category, reason, action] of [
        [3, 'target-binding', 'The class fixture imports a different target from the selected one.', 'Use the selected target in this fixture.'],
        [8, 'assertion-evidence', 'The documented requirement specifies 31 even though current implementation returns 30.86.', 'Change the expected value to 31.'],
        [8, 'missing-scenario', 'The other input path has no test.', 'Add a different input and update its expected value to 12.']
    ] as const) {
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), code, true, constraints(current)).review, reason);
    }
    const unknown = structuredClone(current);
    unknown.methods[0].assertions[0].observationVerified = undefined;
    assert.ok(parseTestReviewDetailed(response(8, 'assertion-evidence', 'The expected value has no controlled observation.',
        'Replace the expected value with a verified observation.'), code, true, constraints(unknown)).review);
});

test('same-source/run/target and exact test hash are mandatory even for an empty approval', async () => {
    const original = await facts();
    for (const changed of [{ runId: 'other' }, { sourceHash: 'c'.repeat(64) }, { target: 'other' }, { testHash: 'd'.repeat(64) }]) {
        const parsed = parseTestReviewDetailed('{"findings":[]}', code, true, constraints({ ...original, ...changed }));
        assert.deepEqual(parsed.diagnostics, ['review-facts-identity-mismatch']);
    }
    const parsed = parseTestReviewDetailed('{"findings":[]}', code + '# changed\n', true, constraints(original));
    assert.equal(parsed.review, undefined);
});

test('a contradicted review gets one bounded reassessment and cannot silently approve', async () => {
    const current = await facts();
    const bad = response(8, 'assertion-quality', 'Expected number should be different.', 'Change the expected value to 50.');
    let calls = 0;
    const prompts: string[] = [];
    const assessed = await reviewWithContractRepair({ tests: code, prompt: 'same complete facts', constraints: constraints(current),
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async prompt => { calls++; prompts.push(prompt); return bad; } });
    assert.equal(assessed, undefined);
    assert.equal(calls, 2);
    assert.match(prompts[1], /observed-outcome-contradiction/);
    assert.match(prompts[1], /guessed calculations/);
    const ambiguous = parseTestReviewDetailed(bad + '\n{"findings":[]}', code, true, constraints(current));
    assert.deepEqual(ambiguous.diagnostics, ['invalid-envelope'], 'a second empty object cannot erase rejected findings');
    calls = 0;
    const corrected = await reviewWithContractRepair({ tests: code, prompt: 'same complete facts', constraints: constraints(current),
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: () => {},
        request: async () => ++calls === 1 ? bad : '{"findings":[]}' });
    assert.deepEqual(corrected, { issues: [] });
    assert.equal(calls, 2);
});

test('wrong numeric evidence identity and credentials are rejected before the AST tool', async () => {
    const options = { ...identity, code, module: 'sample', python: 'must-not-run', env: process.env, executionVerified: true };
    await assert.rejects(buildReviewFacts({ ...options, numericEvidencePrompt: ledger.prompt(10000).replace(identity.runId, 'other') }), /bound to this candidate/);
    await assert.rejects(buildReviewFacts({ ...options, code: code + '\n# confidential-test-value', knownSecrets: ['confidential-test-value'] }), /bound to this candidate/);
});

test('only completed same-identity assertable Trace outcomes protect an expected value', async () => {
    const call = scalarProbeInput({ args: [100, 180], kwargs: {} }).input;
    const fields = typedCallFields(call)!;
    const input = { replayable: true, args: { schema_version: 'trace-value-v1' as const, replayable: true, value: fields.args },
        kwargs: { schema_version: 'trace-value-v1' as const, replayable: true, value: fields.kwargs },
        constructor_args: { schema_version: 'trace-value-v1' as const, replayable: true, value: { type: 'list', items: [] } },
        constructor_kwargs: { schema_version: 'trace-value-v1' as const, replayable: true, value: { type: 'dict', items: [] } },
        call_graph: {} as TraceValueSnapshot };
    input.call_graph = { schema_version: 'trace-value-v1', replayable: true, value: { type: 'dict',
        items: (['args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const).map(key => ({ key: { type: 'str', value: key }, value: input[key].value })) } };
    const trace: BehaviorObservations = { schema_version: 'behavior-observations-v2', run_id: 'trace-worker', func_name: 'score',
        args: ['value', 'height'], complete: true, isolation: 'fresh-process-per-case', load_error: null, errors: [],
        examples: [{ case_id: 'c1', args: ['100', '180'], result: '(30.86, "high")', call_assertable: true, result_assertable: true }],
        cases: [{ case_id: 'c1', source: { kind: 'caller_literals' }, status: 'returned', duration_ms: 1,
            input_before: input, input_after: structuredClone(input), result_snapshot: result } as any] };
    const options = { ...identity, code, module: 'sample', executionVerified: true,
        python: path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), env: process.env };
    const actual = await buildReviewFacts({ ...options, observations: { ...identity, value: trace } });
    assert.equal(actual.methods[0].assertions[0].observationVerified, true);
    for (const change of [(value: BehaviorObservations) => { value.complete = false; },
        (value: BehaviorObservations) => { value.examples[0].result_assertable = false; },
        (value: BehaviorObservations) => { value.cases![0].inputs_mutated = true; },
        (value: BehaviorObservations) => { value.examples[0].oracle_reason = 'uncontrolled-ambient-read'; }]) {
        const invalid = structuredClone(trace); change(invalid);
        const rejected = await buildReviewFacts({ ...options, observations: { ...identity, value: invalid } });
        assert.equal(rejected.methods[0].assertions[0].observationVerified, undefined);
    }
    await assert.rejects(buildReviewFacts({ ...options, observations: { ...identity, sourceHash: 'f'.repeat(64), value: trace } }), /bound to this candidate/);
});
