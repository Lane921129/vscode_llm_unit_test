import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceHash } from '../pipeline/analysisJournal';
import { scalarProbeInput } from '../pipeline/probeInputs';
import { getReviewEvidence } from '../roles/bugFixer';
import { buildReviewerEvidenceDiagnostic, ReviewFacts, reviewFactsForPrompt } from '../roles/reviewFacts';
import { reviewWithContractRepair, ReviewContractEvent } from '../roles/reviewContractRepair';
import { getTestReviewerSystemPrompt, parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';

const tests = 'import unittest\nfrom sample import compute_score\nclass Cases(unittest.TestCase):\n'
    + "    def test_value(self):\n        self.assertEqual(compute_score(2, 4), (0.5, 'stable'))\n";
const identity = { runId: 'review-communication-fixture', sourceHash: 'a'.repeat(64), target: 'compute_score' };
function facts(): ReviewFacts {
    return { ...identity, schemaVersion: 'review-test-facts-v1', module: 'sample', testHash: evidenceHash(tests),
        executionVerified: true, imports: [], classes: [], limitations: 'AST and controlled observations only',
        methods: [{ line: 4, endLine: 5, name: 'test_value',
            assertions: [{ line: 5, kind: 'assertEqual', targetResult: true, expectedType: 'tuple',
                observationVerified: true, targetCallLine: 5, expected: { schema_version: 'trace-value-v1', replayable: true,
                    value: { type: 'tuple', items: [{ type: 'float', value: '0.5' }, { type: 'str', value: 'stable' }] } } }],
            calls: [{ line: 5, observationReturned: true, call: scalarProbeInput({ args: [2, 4], kwargs: {} }).input,
                spellings: ['compute_score(2, 4)'] }], exceptionGuards: [], scalarBindings: [] }] };
}
const reason = "The test case asserts the result of compute_score(2, 4) to be (0.5, 'stable') without verifying the actual ratio calculation or the corresponding result label. The assertion should be based on the actual calculation and the expected result label for the given input.";
const action = 'Modify the test case to verify the actual ratio calculation and the corresponding result label.';
const response = (overrides: Record<string, unknown> = {}) => JSON.stringify({ findings: [{ category: 'assertion-quality',
    test_line: 'L5', reason, action, ...overrides }] });
const constraints = (current: ReviewFacts): ReviewConstraints => ({ ...identity, module: 'sample', methodKind: 'module',
    identity, facts: current });

test('review evidence uses current line identifiers and explains exact-input observation flags', () => {
    const evidence = getReviewEvidence('', '', 'compute_score', ['amount', 'scale'],
        'def compute_score(amount, scale):\n    return amount / scale\n', { args: ['amount', 'scale'] }, 'sample');
    assert.match(evidence, /Cite a VALID_TEST_LINE_IDS line from TEST_FILE in test_line/);
    assert.match(evidence, /Do not cite REVIEW_CONTEXT or add test_excerpt/);
    assert.doesNotMatch(evidence, /Every finding must quote TEST_FILE/);
    const system = getTestReviewerSystemPrompt();
    assert.equal(system.match(/observationVerified/g)?.length, 1);
    assert.match(system, /verified execution and observationVerified\+same-call observationReturned/);
    assert.match(system, /literal\/tuple assertions need no recalculation/);
    assert.match(system, /Independent requirements remain reviewable/);
    const prompt = reviewFactsForPrompt(facts());
    const projected = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    assert.equal('observationVerificationMeaning' in projected, false);
    assert.equal(projected.methods[0].assertions[0].observationVerified, true);
    assert.equal(projected.methods[0].assertions[0].line, 5);
});

test('an observed tuple assertion cannot be rejected solely for not duplicating its calculation', () => {
    const parsed = parseTestReviewDetailed(response(), tests, true, constraints(facts()));
    assert.equal(parsed.review, undefined);
    assert.deepEqual(parsed.diagnostics, ['observed-assertion-verification-contradiction']);
});

test('assertion verification alone cannot authorize a contradiction without its same-method returned call', () => {
    const falseCall = facts();
    // Simulate stale/hand-built facts that bypassed the current producer's true-only field.
    Reflect.set(falseCall.methods[0].calls[0], 'observationReturned', false);
    const missingReturnedFlag = facts();
    delete missingReturnedFlag.methods[0].calls[0].observationReturned;
    const missingCallLine = facts();
    delete missingCallLine.methods[0].assertions[0].targetCallLine;
    const mismatchedCallLine = facts();
    mismatchedCallLine.methods[0].assertions[0].targetCallLine = 6;
    const otherMethodOnly = facts();
    otherMethodOnly.methods.push({ ...structuredClone(otherMethodOnly.methods[0]), line: 7, endLine: 9, name: 'test_other' });
    otherMethodOnly.methods[0].calls = [];
    for (const current of [falseCall, missingReturnedFlag, missingCallLine, mismatchedCallLine, otherMethodOnly]) {
        const parsed = parseTestReviewDetailed(response(), tests, true, constraints(current));
        assert.ok(parsed.review, 'unbound or unverified calls remain unknown and reviewable');
        assert.ok(!parsed.diagnostics.includes('observed-assertion-verification-contradiction'));
    }
});

test('unknown observations and substantive independent requirements remain reviewable', () => {
    for (const flag of ['executionVerified', 'targetResult', 'observationVerified'] as const) {
        const current = facts();
        if (flag === 'executionVerified') { current.executionVerified = false; }
        else { current.methods[0].assertions[0][flag] = false; }
        assert.ok(parseTestReviewDetailed(response(), tests, true, constraints(current)).review, flag);
    }
    for (const overrides of [
        { reason: reason + ' An independent business requirement specifies a different label.' },
        { action: action + ' Verify the independent specification before changing the expected label.' },
        { action: 'Modify the test case to verify the actual ratio calculation and the corresponding label 2.' },
        { action: 'Modify the test case to verify the actual ratio calculation and the corresponding compute_label(2).' },
        { action: 'Modify the test case to verify the actual ratio calculation and the corresponding `stable` label.' },
        { action: 'Modify the test case to verify the actual ratio calculation and the corresponding amount / scale label.' },
        { action: "Use self.assertEqual(compute_score(2, 4), (0.5, 'stable')) together with a separate documented expectation." },
        { action: 'Add a new input case with amount 0 and scale 4; verify its observed return separately.' },
        { reason: 'The independent contract specifies rounding precision of four places for input (2, 4).',
            action: 'Add the documented precision case and assert the full returned decimal value.' },
        { reason: 'The returned label is undocumented for this input.', action: 'Request the missing business rule for the label.' }
    ]) {
        assert.ok(parseTestReviewDetailed(response(overrides), tests, true, constraints(facts())).review);
    }
});

test('contradictory review remains unknown after its single bounded correction, never becomes approval', async () => {
    const recorded: Array<{ status: string; detail: ReviewContractEvent }> = [];
    const deadlines: number[] = [];
    const parsed = await reviewWithContractRepair({ tests, prompt: 'Complete candidate and controlled evidence',
        constraints: constraints(facts()), deadlineAt: 1000, now: () => 100, checkCancelled: () => {},
        request: async (_prompt, deadline) => { deadlines.push(deadline); return response(); },
        event: (status, detail) => recorded.push({ status, detail }) });
    assert.equal(parsed, undefined);
    assert.deepEqual(deadlines, [1000, 1000]);
    assert.deepEqual(recorded.map(item => item.status), ['invalid-response', 'repair-requested', 'invalid-response']);
    assert.ok(recorded.filter(item => item.status === 'invalid-response')
        .every(item => item.detail.diagnostics?.includes('observed-assertion-verification-contradiction')));
});

test('reviewer evidence diagnostics contain only safe hashes, counts and per-line fixed fields', () => {
    const current = facts();
    current.runId = 'PRIVATE_RUN_TEXT'; current.target = 'PRIVATE_TARGET_TEXT'; current.module = 'PRIVATE_MODULE_TEXT';
    current.limitations = 'PRIVATE_LIMITATION_TEXT'; current.methods[0].name = 'PRIVATE_METHOD_TEXT';
    current.methods[0].assertions[0].kind = 'PRIVATE_ASSERTION_TEXT';
    const before = structuredClone(current);
    const diagnostic = buildReviewerEvidenceDiagnostic(current);
    assert.deepEqual(diagnostic, { schemaVersion: 'reviewer-evidence-v1', contractVersion: 'review-v7',
        factsVersion: 'review-test-facts-v1', sourceHash: identity.sourceHash, testHash: evidenceHash(tests),
        executionVerified: true, methodCount: 1, assertionCount: 1, targetAssertionCount: 1,
        observationVerifiedCount: 1, returnedCallCount: 1, assertionDetailsComplete: true,
        assertions: [{ line: 5, kind: 'other', targetResult: true, observationVerified: true }] });
    const json = JSON.stringify(diagnostic);
    for (const privateText of ['PRIVATE_', 'compute_score', 'stable', '0.5', 'expected', 'spellings', 'runId', 'module']) {
        assert.ok(!json.includes(privateText), privateText);
    }
    assert.deepEqual(current, before);
});

test('diagnostic row bounds preserve total counts and never accept arbitrary hash or line values', () => {
    const current = facts();
    current.methods[0].assertions = Array.from({ length: 300 }, (_, index) => ({ line: index + 1,
        kind: 'assertEqual', targetResult: true, observationVerified: index % 2 === 0 }));
    const diagnostic = buildReviewerEvidenceDiagnostic(current);
    assert.equal(diagnostic.assertions.length, 256);
    assert.equal(diagnostic.assertionDetailsComplete, false);
    assert.equal(diagnostic.assertionCount, 300);
    assert.equal(diagnostic.targetAssertionCount, 300);
    assert.equal(diagnostic.observationVerifiedCount, 150);
    assert.throws(() => buildReviewerEvidenceDiagnostic({ ...current, sourceHash: 'PRIVATE_HASH_TEXT' }),
        /^TypeError: Invalid reviewer evidence diagnostic input$/);
    current.methods[0].assertions[0].line = 0;
    assert.throws(() => buildReviewerEvidenceDiagnostic(current), /Invalid reviewer evidence diagnostic input/);
});
