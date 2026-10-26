import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { NumericEvidenceLedger } from '../pipeline/numericEvidenceLedger';
import { TraceValueSnapshot } from '../pipeline/evidenceContracts';
import { scalarProbeInput } from '../pipeline/probeInputs';
import { buildReviewFacts, ReviewFacts, reviewFactsForPrompt } from '../roles/reviewFacts';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';
import { parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';
import { testCodeBasis } from './reviewBasisFixture';

const identity = { runId: 'fixed-expected-review', sourceHash: 'a'.repeat(64), target: 'transform' };
const python = path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const snapshot: TraceValueSnapshot = { schema_version: 'trace-value-v1', replayable: true,
    value: { type: 'tuple', items: [{ type: 'float', value: '49.0' }, { type: 'str', value: 'ready' }] } };
const code = 'import unittest\nfrom sample import transform\nclass Cases(unittest.TestCase):\n'
    + '    def test_value(self):\n        expected = 49.0\n        number, label = transform(7)\n'
    + '        self.assertEqual(number, expected)\n        self.assertEqual(label, "ready")\n';
const ledger = new NumericEvidenceLedger(identity);
ledger.add('VERIFIED NUMERIC OBSERVATIONS (evidence only; the AI must revise the test):\n' + JSON.stringify({
    schemaVersion: 'numeric-observation-handoff-v1', ...identity, testHash: 'b'.repeat(64),
    corrections: [{ method: 'test_value', line: 7,
        basis: { call: scalarProbeInput({ args: [7], kwargs: {} }).input, result_snapshot: snapshot } }]
}));
const facts = (tests = code) => buildReviewFacts({ ...identity, module: 'sample', code: tests, python,
    env: process.env, executionVerified: true, numericEvidencePrompt: ledger.prompt(10000) });
const constraints = (value: ReviewFacts): ReviewConstraints => ({ ...identity, module: 'sample', methodKind: 'module', identity, facts: value });
const reason = 'The expected result is not a fixed value, but rather a calculated value based on the input parameters. This could lead to false positives or false negatives in the test.';
const action = 'Replace the expected result with a fixed value that is calculated based on the input parameters.';
const response = (line = 7, explanation = reason, correction = action, category = 'assertion-quality') => JSON.stringify({
    findings: [{ category, test_line: `L${line}`, reason: explanation, action: correction, basis: testCodeBasis(line) }]
});

test('AST fixed literals and local aliases remain distinct from observation and requirement correctness', async () => {
    const current = await facts();
    assert.deepEqual(current.methods[0].assertions.map(item => [item.expectedOrigin, item.observationStatus]),
        [['static-literal', 'verified'], ['static-literal', 'verified']]);
    const projected = JSON.parse(reviewFactsForPrompt(current).split('\n')[1]);
    assert.equal(projected.methods[0].assertions[0].expectedOrigin, 'static-literal');
    for (const literal of ['None', 'True', 'b"ready"', '(49.0, "ready")', '[49.0]', '{"result": 49.0}', '-49.0']) {
        const tests = code.replace('expected = 49.0', `expected = ${literal}`);
        const value = await facts(tests);
        assert.equal(value.methods[0].assertions[0].expectedOrigin, 'static-literal', literal);
        assert.notEqual(value.methods[0].assertions[0].observationStatus, 'verified', literal);
        assert.ok(parseTestReviewDetailed(response(), tests, true, constraints(value)).review,
            'fixed syntax alone never denies an unverified or conflicting observation finding');
    }
});

test('complete fixed-value denial is rejected for the cited observed literal, never converted into approval', async () => {
    const current = await facts();
    for (const line of [7, 8]) {
        const parsed = parseTestReviewDetailed(response(line), code, true, constraints(current));
        assert.equal(parsed.review, undefined);
        assert.deepEqual(parsed.diagnostics, ['expected-fixed-value-contradiction']);
    }
    for (const changed of [
        { ...current, executionVerified: false },
        { ...current, methods: current.methods.map(method => ({ ...method,
            calls: method.calls.map(call => ({ ...call, observationReturned: undefined })) })) },
        { ...current, methods: current.methods.map(method => ({ ...method,
            assertions: method.assertions.map(({ expectedOrigin: _origin, ...item }) => item) })) },
    ]) {
        assert.ok(parseTestReviewDetailed(response(), code, true, constraints(changed)).review);
    }
    for (const [explanation, correction, category] of [
        [reason + ' The supplied requirement specifies rounding to a whole number.', 'Use the explicit requirement value 49.', 'assertion-quality'],
        ['The supplied requirement requires rejection for this input.', 'Replace this check with assertRaises(ValueError) for the explicit requirement.', 'assertion-evidence'],
        ['The boundary input 8 has no test case.', 'Add a separate controlled observation for input 8.', 'missing-scenario'],
        [reason, 'Add an independent contract assertion for a different input.', 'assertion-quality'],
    ]) {
        assert.ok(parseTestReviewDetailed(response(7, explanation, correction, category), code, true, constraints(current)).review);
    }
});

test('computed, helper-derived, result-derived and rebound expected expressions stay unknown without evaluation', async () => {
    for (const expected of ['7 * 7', 'compute_expected(7)', 'transform(7)', 'other.expected']) {
        const tests = code.replace('expected = 49.0', `expected = ${expected}`);
        const value = await facts(tests);
        assert.equal(value.methods[0].assertions[0]?.expectedOrigin, 'unknown', expected);
        assert.equal(value.methods[0].assertions[0]?.observationStatus, 'unknown', expected);
        assert.ok(parseTestReviewDetailed(response(), tests, true, constraints(value)).review);
    }
    for (const tests of [code.replace('expected = 49.0', 'expected = 49.0\n        expected = helper()'),
        code.replace('    def test_value', '    def assertEqual(self, *args):\n        pass\n    def test_value'),
        code.replace('        expected = 49.0', '        self.expected = 49.0').replace('number, expected)', 'number, self.expected)')]) {
        const value = await facts(tests);
        assert.notEqual(value.methods[0]?.assertions[0]?.expectedOrigin, 'static-literal');
    }
});

test('repeated contradiction uses only the original same-candidate correction and deadline', async () => {
    const current = await facts();
    const calls: number[] = [];
    const events: string[] = [];
    const review = await reviewWithContractRepair({ tests: code, prompt: 'same candidate and facts', constraints: constraints(current),
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: status => events.push(status),
        request: async (prompt, deadline) => { calls.push(deadline); assert.ok(prompt.includes('same candidate and facts')); return response(); } });
    assert.equal(review, undefined);
    assert.deepEqual(calls, [1000, 1000]);
    assert.deepEqual(events, ['invalid-response', 'repair-requested', 'invalid-response']);
    assert.deepEqual(parseTestReviewDetailed('{"findings":[]}', code + '# new candidate\n', true, constraints(current)).diagnostics,
        ['review-facts-identity-mismatch']);
});

test('malformed or contradictory expected provenance is a tool-contract error', async t => {
    const original = await facts();
    const runner = require('../utils/processRunner') as typeof import('../utils/processRunner');
    for (const patch of [
        { expectedOrigin: 'computed' }, { expectedOrigin: true }, { expectedOrigin: 'unknown' },
        { expectedOrigin: 'static-literal', expected: undefined },
        { expectedOrigin: 'static-literal', targetResult: false },
        { expectedOrigin: 'static-literal', expectedType: 'str' },
    ]) {
        const changed = { ...original, methods: original.methods.map(method => ({ ...method,
            assertions: method.assertions.map((item, index) => index === 0 ? { ...item, ...patch } : item) })) };
        const mock = t.mock.method(runner, 'runSpawn', async () => ({ code: 0, stdout: JSON.stringify(changed), stderr: '' }));
        try {
            await assert.rejects(facts(), /bound to this candidate/);
            assert.deepEqual(parseTestReviewDetailed('{"findings":[]}', code, true, constraints(changed as ReviewFacts)).diagnostics,
                ['review-facts-expected-origin-shape']);
        } finally { mock.mock.restore(); }
    }
});
