import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { reviewWithContractRepair, ReviewContractEvent, ReviewContractRepairOptions } from '../roles/reviewContractRepair';
import { ReviewSession } from '../roles/reviewSession';
import { TargetBudget, runWithTargetBudget } from '../pipeline/targetBudget';
import { TargetStopPolicy, runWithStopPolicy } from '../pipeline/stopPolicy';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { evidenceHash } from '../pipeline/analysisJournal';
import { ReviewFacts } from '../roles/reviewFacts';
import { scalarProbeInput } from '../pipeline/probeInputs';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { testCodeBasis } from './reviewBasisFixture';

const tests = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
    + '    def test_target(self):\n        self.assertEqual(target(1), 2)\n';
const valid = JSON.stringify({ findings: [] });
const badLine = JSON.stringify({ findings: [{ category: 'assertion-evidence', test_line: 'L4', basis: testCodeBasis(4),
    reason: 'The expected result has no supporting observation.', action: 'Use the supplied exact observation for the assertion.' }] });
const events: () => Array<{ status: string; detail: ReviewContractEvent }> = () => [];
function options(request: ReviewContractRepairOptions['request'], recorded = events()): ReviewContractRepairOptions {
    return { tests, prompt: 'TEST_FILE and complete evidence', deadlineAt: 1_000, now: () => 100,
        constraints: { target: 'target', module: 'sample', methodKind: 'module' }, request,
        checkCancelled: () => {}, event: (status, detail) => recorded.push({ status, detail }) };
}

test('valid review uses one request and publishes parsed evidence without raw provider text', async () => {
    let calls = 0;
    const recorded = events();
    const review = await reviewWithContractRepair(options(async () => { calls++; return valid; }, recorded));
    assert.deepEqual(review, { issues: [] });
    assert.equal(calls, 1);
    assert.equal(recorded[0].status, 'parsed');
    assert.equal(recorded[0].detail.responseHash?.length, 64);
    assert.equal(recorded[0].detail.responseCharacters, valid.length);
    assert.equal('raw' in recorded[0].detail, false);
});

test('one contract correction preserves the absolute deadline and only sends diagnostic codes', async () => {
    const calls: Array<{ prompt: string; deadline: number }> = [];
    const recorded = events();
    const review = await reviewWithContractRepair(options(async (prompt, deadline) => {
        calls.push({ prompt, deadline });
        return calls.length === 1 ? badLine : valid;
    }, recorded));
    assert.deepEqual(review, { issues: [] });
    assert.deepEqual(calls.map(call => call.deadline), [1_000, 1_000]);
    assert.match(calls[1].prompt, /unrelated-test-line/);
    assert.match(calls[1].prompt, /^TEST_FILE and complete evidence/);
    assert.ok(!calls[1].prompt.includes(badLine));
    assert.deepEqual(recorded.map(event => event.status), ['invalid-response', 'repair-requested', 'parsed']);
    assert.ok(!JSON.stringify(recorded).includes(badLine));
});

test('a second malformed review stays unknown and is cached only after the bounded operation', async () => {
    const session = new ReviewSession();
    let calls = 0;
    const run = () => reviewWithContractRepair(options(async () => { calls++; return badLine; }));
    assert.equal(await session.review('same-evidence', run, () => {}), undefined);
    assert.equal(await session.review('same-evidence', run, () => {}), undefined);
    assert.equal(calls, 2);
});

test('transport, timeout and budget exceptions do not initiate contract correction', async () => {
    for (const failure of [new Error('transport failed'), new AnalysisStageError('timeout', 'model-request', 'deadline'),
        new AnalysisStageError('budget', 'target-budget', 'budget exhausted')]) {
        let calls = 0;
        const recorded = events();
        await assert.rejects(reviewWithContractRepair(options(async () => { calls++; throw failure; }, recorded)), error => error === failure);
        assert.equal(calls, 1);
        assert.deepEqual(recorded, []);
    }
});

test('cancellation after a response prevents parsing and retrying', async () => {
    let cancelled = false;
    let calls = 0;
    const recorded = events();
    const config = options(async () => { calls++; cancelled = true; return badLine; }, recorded);
    config.checkCancelled = () => { if (cancelled) { throw new Error('cancelled'); } };
    await assert.rejects(reviewWithContractRepair(config), /cancelled/);
    assert.equal(calls, 1);
    assert.deepEqual(recorded, []);
});

test('expired or elapsed original deadline never starts a replacement request', async () => {
    let now = 100;
    let calls = 0;
    const recorded = events();
    const config = options(async () => { calls++; now = 1_000; return valid; }, recorded);
    config.now = () => now;
    const timeout = (error: unknown) => error instanceof AnalysisStageError
        && error.category === 'timeout' && error.stage === 'reviewer';
    await assert.rejects(reviewWithContractRepair(config), timeout);
    assert.equal(calls, 1);
    assert.deepEqual(recorded.map(event => event.status), ['repair-skipped']);
    await assert.rejects(reviewWithContractRepair(config), timeout);
    assert.equal(calls, 1);
});

test('correction requests consume the existing target budget and use its earlier deadline', async () => {
    let now = 100;
    const budget = new TargetBudget({ timeoutMs: 500, logicalRequests: 1, now: () => now });
    const deadlines: number[] = [];
    await runWithTargetBudget(budget, async () => {
        const config = options(async (_prompt, deadline) => {
            budget.consumeModelRequest();
            budget.consumeTransportAttempt(7);
            deadlines.push(deadline);
            now += 20;
            return badLine;
        });
        config.now = () => now;
        await assert.rejects(reviewWithContractRepair(config), /logicalRequests/);
    });
    assert.deepEqual(deadlines, [600]);
    assert.equal(budget.snapshot().used.logicalRequests, 1);
    assert.equal(budget.snapshot().used.transportAttempts, 1);
});

test('target self-mock proposals remain invalid even after correction', async () => {
    const response = JSON.stringify({ findings: [{ category: 'mock-isolation', test_line: 'L5', basis: testCodeBasis(5),
        reason: 'The selected target should be isolated.', action: 'Mock the target function and assert its result.' }] });
    const recorded = events();
    assert.equal(await reviewWithContractRepair(options(async () => response, recorded)), undefined);
    assert.deepEqual(recorded.filter(event => event.status === 'invalid-response').map(event => event.detail.diagnostics),
        [['target-self-mock'], ['target-self-mock']]);
});

test('gpt_oss20b html_escape regression: basis reference format issues become Writer suggestions without deducting failure budget', async () => {
    const fixturePath = path.resolve(__dirname, '../../test/fixtures/eval_screening/gpt_oss20b/bottle_utils_9e53c6fc/html_escape_6d4c4a8f/reviewer_response_fixture.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const identity = { runId: fixture.runId as string, sourceHash: fixture.sourceHash as string, target: fixture.target as string };
    const seedFacts: ReviewFacts = {
        schemaVersion: 'review-test-facts-v1',
        ...identity,
        module: fixture.module,
        testHash: evidenceHash(fixture.seedCode),
        executionVerified: true,
        imports: [{ line: 1, binding: 'unittest', origin: 'unittest', harnessUseLines: [4] },
            { line: 2, binding: 'html_escape', origin: 'bottle_utils.html_escape', targetUseLines: [6] }],
        classes: [{ name: 'GeneratedSeedTests', line: 4, kind: 'unittest-harness' }],
        methods: [{
            name: 'test_seed',
            line: 5,
            endLine: 7,
            calls: [{ line: 6, call: scalarProbeInput({ args: [''], kwargs: {} }).input, observationReturned: true }],
            assertions: [{ line: 7, kind: 'assertEqual', targetResult: true, targetCallLine: 6,
                expectedType: 'str',
                expected: { schema_version: 'trace-value-v1', replayable: true, value: { type: 'str', value: '' } },
                expectedOrigin: 'static-literal', observationVerified: true, observationStatus: 'verified' }],
            exceptionGuards: [],
            scalarBindings: [],
            mockAssertions: []
        }],
        limitations: ''
    };

    const policy = new TargetStopPolicy({ failureLimit: 5 });
    let reviewerCalls = 0;
    let writerFeedbackReceived = '';
    const recorded = events();

    const candidateResult = await runWithStopPolicy(policy, async () =>
        validateTestCandidate(fixture.seedCode, {
            reviewRequired: true,
            validate: async () => undefined,
            execute: async code => ({
                ok: true,
                out: 'Ran 1 test in 0.001s\n\nOK',
                qualityGaps: [],
                coverage: {
                    available: true,
                    evidenceVersion: 'coverage-evidence-v1',
                    scopeStatus: 'verified',
                    executableTargetLines: [25],
                    coverageText: '100.00%',
                    missingLines: '',
                    targetExecuted: true,
                    missingTargetLines: [],
                    targetFullyCovered: true,
                    missingTargetBranches: [],
                    targetBranchesCovered: true
                }
            }),
            review: async code => {
                reviewerCalls++;
                if (reviewerCalls === 1) {
                    return reviewWithContractRepair({
                        tests: code,
                        prompt: 'REVIEW_REQUEST_V8 html_escape seed',
                        deadlineAt: 10_000,
                        now: () => 100,
                        constraints: { target: fixture.target, module: fixture.module, methodKind: 'module', identity, facts: seedFacts },
                        request: async () => JSON.stringify(fixture.reviewerResponse),
                        checkCancelled: () => {},
                        event: (status, detail) => recorded.push({ status, detail })
                    });
                }
                return { issues: [] };
            },
            revise: async (_code, feedback, role) => {
                assert.equal(role, 'writer');
                writerFeedbackReceived = feedback;
                return fixture.writerRevisedCode;
            },
            event: () => {},
            checkCancelled: () => {}
        })
    );

    assert.equal(reviewerCalls, 2, 'Reviewer is not repeatedly retried on basis format mismatch; second call approves revised candidate');
    assert.equal(policy.failureCount, 0, 'basis format fallback must not deduct target failure budget');
    assert.equal(policy.remainingFailures, 5);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].status, 'parsed');
    assert.deepEqual(recorded[0].detail.diagnostics, ['evidence-reference-unrelated']);
    assert.match(writerFeedbackReceived, /missing scenario for non-empty string with special characters/);
    assert.equal(candidateResult.code, fixture.writerRevisedCode);
    assert.equal(candidateResult.reviewStatus, 'completed');
});

test('basis format variants convert to quality suggestions while fact and outcome contradictions remain blocked', async () => {
    const identity = { runId: 'run-basis-check', sourceHash: 'a'.repeat(64), target: 'target' };
    const facts: ReviewFacts = {
        schemaVersion: 'review-test-facts-v1',
        ...identity,
        module: 'sample',
        testHash: evidenceHash(tests),
        executionVerified: true,
        imports: [{ line: 1, binding: 'unittest', origin: 'unittest', harnessUseLines: [3] },
            { line: 2, binding: 'target', origin: 'sample.target', targetUseLines: [5] }],
        classes: [{ name: 'Cases', line: 3, kind: 'unittest-harness' }],
        methods: [{
            name: 'test_target',
            line: 4,
            endLine: 5,
            calls: [{ line: 5, call: scalarProbeInput({ args: [1], kwargs: {} }).input, observationReturned: true }],
            assertions: [{ line: 5, kind: 'assertEqual', targetResult: true, targetCallLine: 5,
                expectedType: 'int',
                expectedOrigin: 'static-literal', observationVerified: true, observationStatus: 'verified',
                expected: { schema_version: 'trace-value-v1', replayable: true, value: { type: 'int', value: '2' } } }],
            exceptionGuards: [],
            scalarBindings: [],
            mockAssertions: []
        }],
        limitations: ''
    };
    const constraints = { target: 'target', module: 'sample', methodKind: 'module' as const, identity, facts };

    for (const basis of [
        undefined,
        { kind: 'test-code', ref: 'L4', field: 'judgment', value: 'unverified' },
        { kind: 'host-fact', ref: 'A9.9', field: 'observationStatus', value: 'verified' },
        { kind: 'host-fact', ref: 'I1', field: 'origin', value: 'unittest' }
    ]) {
        const policy = new TargetStopPolicy({ failureLimit: 3 });
        let calls = 0;
        const reply = JSON.stringify({
            findings: [{
                category: 'missing-scenario',
                test_line: 'L5',
                reason: 'Test only covers positive input; add negative input scenario.',
                action: 'Add a negative input test case for target(-1).',
                ...(basis === undefined ? {} : { basis })
            }]
        });
        const review = await runWithStopPolicy(policy, () =>
            reviewWithContractRepair({
                tests,
                prompt: 'TEST_FILE and complete evidence',
                deadlineAt: 1_000,
                now: () => 100,
                constraints,
                request: async () => { calls++; return reply; },
                checkCancelled: () => {},
                event: () => {}
            })
        );
        assert.equal(calls, 1, 'basis format issues should not trigger Reviewer retry');
        assert.equal(policy.failureCount, 0, 'basis format issues should not deduct failure budget');
        assert.equal(review?.issues.length, 1);
        assert.equal(review?.issues[0].severity, 'quality');
        assert.deepEqual(review?.issues[0].basis, testCodeBasis(5));
    }

    for (const contradicted of [
        {
            category: 'assertion-quality',
            test_line: 'L5',
            reason: 'The observation status is contradicted.',
            action: 'Add a separate negative case.',
            basis: { kind: 'host-fact', ref: 'A1.1', field: 'observationStatus', value: 'contradicted' }
        },
        {
            category: 'assertion-quality',
            test_line: 'L5',
            reason: 'Observed outcome differs from expected.',
            action: 'Change the expected value to 99.',
            basis: { kind: 'test-code', ref: 'L4', field: 'judgment', value: 'unverified' }
        },
        {
            category: 'mock-isolation',
            test_line: 'L5',
            reason: 'Target should be isolated with a mock.',
            action: 'Mock the target function with unittest.mock.patch.',
            basis: { kind: 'host-fact', ref: 'A9.9', field: 'observationStatus', value: 'verified' }
        }
    ]) {
        let calls = 0;
        const review = await reviewWithContractRepair({
            tests,
            prompt: 'TEST_FILE and complete evidence',
            deadlineAt: 1_000,
            now: () => 100,
            constraints,
            request: async () => { calls++; return JSON.stringify({ findings: [contradicted] }); },
            checkCancelled: () => {},
            event: () => {}
        });
        assert.equal(review, undefined, 'contradictions must still be rejected even when combined with basis format issues');
        assert.equal(calls, 2);
    }
});
