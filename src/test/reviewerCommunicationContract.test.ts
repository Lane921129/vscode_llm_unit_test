import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { evidenceHash } from '../pipeline/analysisJournal';
import { scalarProbeInput } from '../pipeline/probeInputs';
import { NumericEvidenceLedger } from '../pipeline/numericEvidenceLedger';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { getReviewEvidence } from '../roles/bugFixer';
import { buildReviewFacts, buildReviewerEvidenceDiagnostic, ReviewFacts, reviewAssertionObservationStatus, reviewFactsForPrompt } from '../roles/reviewFacts';
import { reviewWithContractRepair, ReviewContractEvent } from '../roles/reviewContractRepair';
import { fitReviewPrompt, getTestReviewerSystemPrompt, parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';

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

test('mechanical scalar type denials contradict only same-call verified literal facts', () => {
    for (const [type, name, value] of [['float', 'float', '10000.0'], ['str', 'string', 'stable'],
        ['int', 'integer', '2'], ['bool', 'boolean', true]] as const) {
        const current = facts();
        const assertion = current.methods[0].assertions[0];
        assertion.expectedType = type;
        assertion.expected = { schema_version: 'trace-value-v1', replayable: true, value: { type, value } } as any;
        const finding = { reason: `The expected result is not a valid ${name} value.`,
            action: `Change the expected result to a valid ${name} value.` };
        const parsed = parseTestReviewDetailed(response(finding), tests, true, constraints(current));
        assert.equal(parsed.review, undefined);
        assert.ok(parsed.diagnostics.includes('expected-literal-type-contradiction'));
        for (const variation of ['unknown', 'no-return', 'not-executed', 'different-type', 'requirement', 'replacement']) {
            const unknown = structuredClone(current);
            let changed = { ...finding };
            if (variation === 'unknown') { unknown.methods[0].assertions[0].observationVerified = false; }
            if (variation === 'no-return') { delete unknown.methods[0].calls[0].observationReturned; }
            if (variation === 'not-executed') { unknown.executionVerified = false; }
            if (variation === 'different-type') { unknown.methods[0].assertions[0].expected = undefined; }
            if (variation === 'requirement') { changed.reason += ' The documented requirement requires a positive value.'; }
            if (variation === 'replacement') {
                changed.reason = 'The documented independent specification requires a different expected value.';
                changed.action = 'Change the expected result to 3 using the independent specification.';
            }
            assert.ok(parseTestReviewDetailed(response(changed), tests, true, constraints(unknown)).review, variation);
        }
    }
});

test('native AST float and string projections reject both observed type denials from one unpacked call', async () => {
    const code = 'import unittest\nfrom sample import compute_score\nclass Cases(unittest.TestCase):\n'
        + '    def test_value(self):\n        amount, label = compute_score(2, 4)\n'
        + '        self.assertEqual(amount, 0.5)\n        self.assertEqual(label, "stable")\n';
    const ledger = new NumericEvidenceLedger(identity);
    ledger.add('VERIFIED NUMERIC OBSERVATIONS (evidence only; the AI must revise the test):\n' + JSON.stringify({
        schemaVersion: 'numeric-observation-handoff-v1', ...identity, testHash: 'b'.repeat(64),
        corrections: [{ method: 'test_value', line: 6, basis: {
            call: scalarProbeInput({ args: [2, 4], kwargs: {} }).input,
            result_snapshot: facts().methods[0].assertions[0].expected
        } }]
    }));
    const current = await buildReviewFacts({ ...identity, code, module: 'sample', executionVerified: true,
        python: path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        env: process.env, numericEvidencePrompt: ledger.prompt(10000) });
    assert.deepEqual(current.methods[0].assertions.map(value => value.expected?.value.type), ['float', 'str']);
    assert.ok(current.methods[0].assertions.every(value => value.observationStatus === 'verified'));
    const raw = JSON.stringify({ findings: ['float', 'string'].map((name, index) => ({ category: 'assertion-quality',
        test_line: `L${6 + index}`, reason: `The expected result is not a valid ${name} value.`,
        action: `Change the expected result to a valid ${name} value.` })) });
    const result = parseTestReviewDetailed(raw, code, true, constraints(current));
    assert.equal(result.review, undefined);
    assert.deepEqual(result.diagnostics, ['expected-literal-type-contradiction']);
});

test('review evidence uses current line identifiers and explains exact-input observation flags', () => {
    const evidence = getReviewEvidence('', '', 'compute_score', ['amount', 'scale'],
        'def compute_score(amount, scale):\n    return amount / scale\n', { args: ['amount', 'scale'] }, 'sample');
    assert.match(evidence, /Cite a VALID_TEST_LINE_IDS line from TEST_FILE in test_line/);
    assert.match(evidence, /Do not cite REVIEW_CONTEXT or add test_excerpt/);
    assert.doesNotMatch(evidence, /Every finding must quote TEST_FILE/);
    const system = getTestReviewerSystemPrompt();
    assert.equal(system.match(/observationStatus/g)?.length, 1);
    assert.doesNotMatch(system, /observationVerified/);
    assert.match(system, /verified execution and verified\+same-call observationReturned/);
    assert.match(system, /unknown=unverified\. An unverified expected value is not a proven wrong value/);
    assert.match(system, /literal\/tuple assertions need no recalculation/);
    assert.match(system, /Independent requirements remain reviewable/);
    const prompt = reviewFactsForPrompt(facts());
    const projected = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    assert.equal('observationVerificationMeaning' in projected, false);
    assert.equal(projected.methods[0].assertions[0].observationStatus, 'verified');
    assert.equal('observationVerified' in projected.methods[0].assertions[0], false);
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
        observationVerifiedCount: 1, observationContradictedCount: 0, observationUnknownCount: 0,
        returnedCallCount: 1, assertionDetailsComplete: true,
        assertions: [{ line: 5, kind: 'other', targetResult: true, observationVerified: true, observationStatus: 'verified' }] });
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
    assert.equal(diagnostic.observationUnknownCount, 150);
    assert.equal(diagnostic.observationContradictedCount, 0);
    assert.throws(() => buildReviewerEvidenceDiagnostic({ ...current, sourceHash: 'PRIVATE_HASH_TEXT' }),
        /^TypeError: Invalid reviewer evidence diagnostic input$/);
    current.methods[0].assertions[0].line = 0;
    assert.throws(() => buildReviewerEvidenceDiagnostic(current), /Invalid reviewer evidence diagnostic input/);
});

test('three observation states preserve legacy unknown and keep diagnostic totals without artifact data', () => {
    const current = facts();
    const base = current.methods[0].assertions[0];
    current.methods[0].assertions = [
        { ...base, observationStatus: 'verified' },
        { ...base, line: 6, observationStatus: 'contradicted', observationVerified: undefined },
        { ...base, line: 7, observationStatus: 'unknown', observationVerified: false },
        { ...base, line: 8, observationVerified: undefined },
        { ...base, line: 9, observationVerified: false }
    ];
    assert.deepEqual(current.methods[0].assertions.map(reviewAssertionObservationStatus),
        ['verified', 'contradicted', 'unknown', 'unknown', 'unknown']);
    const diagnostic = buildReviewerEvidenceDiagnostic(current);
    assert.equal(diagnostic.observationVerifiedCount, 1);
    assert.equal(diagnostic.observationContradictedCount, 1);
    assert.equal(diagnostic.observationUnknownCount, 3);
    assert.deepEqual(diagnostic.assertions.map(item => item.observationVerified), [true, false, false, false, false]);
    assert.deepEqual(diagnostic.assertions.map(item => item.observationStatus),
        ['verified', 'contradicted', 'unknown', 'unknown', 'unknown']);
    const wire = JSON.parse(reviewFactsForPrompt(current).split('\n')[1]);
    assert.ok(wire.methods[0].assertions.every((item: object) => !('observationVerified' in item)));
    assert.equal(wire.methods[0].assertions[3].observationStatus, 'unknown', 'execution alone never verifies an assertion');
});

test('illegal or contradictory observation flags stop review instead of silently approving or downgrading evidence', () => {
    for (const fields of [
        { observationStatus: 'PRIVATE_STATUS_TEXT' },
        { observationStatus: false },
        { observationStatus: 'verified', observationVerified: false },
        { observationStatus: 'contradicted', observationVerified: true },
        { observationStatus: 'unknown', observationVerified: true },
        { observationStatus: undefined, observationVerified: 'PRIVATE_BOOL_TEXT' }
    ]) {
        const current = facts();
        Object.assign(current.methods[0].assertions[0], fields);
        assert.equal(reviewAssertionObservationStatus(current.methods[0].assertions[0]), undefined);
        assert.throws(() => buildReviewerEvidenceDiagnostic(current), /^TypeError: Invalid reviewer evidence diagnostic input$/);
        assert.throws(() => reviewFactsForPrompt(current), /could not be bound/);
        assert.deepEqual(parseTestReviewDetailed('{"findings":[]}', tests, true, constraints(current)),
            { diagnostics: ['review-facts-observation-shape'] });
    }
});

const containerTests = 'import unittest\nfrom sample import compute_score\nclass Cases(unittest.TestCase):\n'
    + '    def test_value(self):\n        result = compute_score(2, 4)\n        expected_value = 0.5\n'
    + "        expected_label = 'stable'\n        self.assertEqual(result, (expected_value, expected_label))\n";
const unobservedClaim = {
    category: 'assertion-evidence', test_line: 'L8',
    reason: 'The assertion `self.assertEqual(result, (expected_value, expected_label))` is based on the expected values `expected_value` and `expected_label` which are not verified observations.',
    action: 'Replace the assertion with a verified observation or a same-test dependency mock.'
};
const containerResponse = (overrides: Record<string, unknown> = {}) => JSON.stringify({ findings: [{ ...unobservedClaim, ...overrides }] });

test('actual AST container-name observations cause one Reviewer contract correction, never a Writer rewrite or automatic approval', async () => {
    const ledger = new NumericEvidenceLedger(identity);
    ledger.add('VERIFIED NUMERIC OBSERVATIONS (evidence only; the AI must revise the test):\n' + JSON.stringify({
        schemaVersion: 'numeric-observation-handoff-v1', ...identity, testHash: 'b'.repeat(64),
        corrections: [{ method: 'test_value', line: 8, basis: {
            call: scalarProbeInput({ args: [2, 4], kwargs: {} }).input,
            result_snapshot: facts().methods[0].assertions[0].expected
        } }]
    }));
    const current = await buildReviewFacts({ ...identity, code: containerTests, module: 'sample', executionVerified: true,
        python: path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        env: process.env, numericEvidencePrompt: ledger.prompt(10000) });
    assert.equal(current.methods[0].assertions[0].observationStatus, 'verified');
    assert.equal(current.methods[0].assertions[0].observationVerified, true);
    const context = constraints(current);
    for (const initial of [containerResponse(), containerResponse({ reason: unobservedClaim.reason.replaceAll('`', '') })]) {
        assert.deepEqual(parseTestReviewDetailed(initial, containerTests, true, context).diagnostics,
            ['observed-assertion-verification-contradiction'], JSON.stringify(current.methods));
        let requests = 0;
        const events: string[] = [];
        const corrected = await reviewWithContractRepair({ tests: containerTests, prompt: 'Complete source, tests and facts',
            constraints: context, deadlineAt: 1000, now: () => 10, checkCancelled: () => {},
            event: status => events.push(status), request: async () => ++requests === 1 ? initial : '{"findings":[]}' });
        assert.equal(requests, 2, 'only one bounded Reviewer correction is requested');
        assert.deepEqual(corrected?.issues, [], 'approval requires the second actual Reviewer assessment');
        assert.deepEqual(events, ['invalid-response', 'repair-requested', 'parsed']);
    }
    const unknown = structuredClone(current);
    unknown.methods[0].assertions[0].observationStatus = 'unknown';
    delete unknown.methods[0].assertions[0].observationVerified;
    assert.equal(parseTestReviewDetailed(containerResponse(), containerTests, true, constraints(unknown)).review?.issues.length, 1);
    for (const overrides of [
        { category: 'missing-scenario', reason: 'No test covers a different controlled input.', action: 'Add another observed input case.' },
        { reason: unobservedClaim.reason + ' The independent business requirement specifies a different status.' },
        { action: unobservedClaim.action + ' Add a different input case.' },
        { action: 'Replace the assertion with self.assertEqual(result, (0.6, "changed")) using the explicit documented contract.' },
        { reason: unobservedClaim.reason.replace('expected_value` and `expected_label', 'unrelated_value` and `expected_label') }
    ]) {
        assert.equal(parseTestReviewDetailed(containerResponse(overrides), containerTests, true, context).review?.issues.length, 1);
    }
});

test('complete Reviewer envelope uses one compact tri-state projection without enlarging its earlier explanation', () => {
    const current = facts();
    const system = getTestReviewerSystemPrompt();
    const prompt = fitReviewPrompt({ tests, evidence: 'Exact-input observations and complete source.', executionVerified: true, facts: current }, 30000)!;
    const previousSystem = system.replace(/^observationStatus:.*$/m,
        'An unverified expected value is not a proven wrong value. Never invent its replacement from model arithmetic, type annotations or a return expression. For a concrete verification gap, name missing evidence and request a controlled observation or explicit contract in action; unknown is not a contradiction.')
        .replace('verified execution and verified+same-call', 'verified execution and observationVerified+same-call')
        .replace('HOST_VERIFIED_REVIEW_FACTS binds supplied test facts.', 'HOST_VERIFIED_REVIEW_FACTS binds harness/imports/assertions/observations.')
        .replace('Inspect tests; never replace code.', 'Inspect tests; never write replacement code.')
        .replace('line showing the TEST_FILE defect', 'line demonstrating the defect in TEST_FILE')
        .replace('for that call. New inputs and explicit business requirements stay separate findings; request missing evidence, never invent exceptions.',
            'for that same call. New inputs and explicit business requirements remain separate findings; request missing evidence instead of inventing an exception.')
        .replace('Passed imports need no pip install.', 'Passed imports need no pip installation.')
        .replace('Keep observed values and exact strings', 'Keep observed expected values and exact strings');
    const legacyProjection = 'HOST_VERIFIED_REVIEW_FACTS_V1\n' + JSON.stringify({ ...current,
        methods: current.methods.map(method => ({ ...method,
            calls: method.calls.map(({ line, observationReturned }) => ({ line, observationReturned })) })) });
    const previousPrompt = prompt.replace(reviewFactsForPrompt(current), legacyProjection);
    assert.ok(estimatePromptTokens(system + '\n' + prompt) <= estimatePromptTokens(previousSystem + '\n' + previousPrompt),
        'all source and execution evidence remains; replacing the redundant boolean does not grow the complete role request');
    assert.equal(prompt.split('<TEST_FILE>').length, 2);
    assert.equal(prompt.split('HOST_VERIFIED_REVIEW_FACTS_V1').length, 2);
});
