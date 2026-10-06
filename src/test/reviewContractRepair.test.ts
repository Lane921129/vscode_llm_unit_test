import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewWithContractRepair, ReviewContractEvent, ReviewContractRepairOptions } from '../roles/reviewContractRepair';
import { ReviewSession } from '../roles/reviewSession';
import { TargetBudget, runWithTargetBudget } from '../pipeline/targetBudget';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const tests = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
    + '    def test_target(self):\n        self.assertEqual(target(1), 2)\n';
const valid = JSON.stringify({ findings: [] });
const badLine = JSON.stringify({ findings: [{ category: 'assertion-evidence', test_line: 'L4',
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
    const config = options(async () => { calls++; now = 1_000; return badLine; }, recorded);
    config.now = () => now;
    assert.equal(await reviewWithContractRepair(config), undefined);
    assert.equal(calls, 1);
    assert.deepEqual(recorded.map(event => event.status), ['repair-skipped']);
    assert.equal(await reviewWithContractRepair(config), undefined);
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
    const response = JSON.stringify({ findings: [{ category: 'mock-isolation', test_line: 'L5',
        reason: 'The selected target should be isolated.', action: 'Mock the target function and assert its result.' }] });
    const recorded = events();
    assert.equal(await reviewWithContractRepair(options(async () => response, recorded)), undefined);
    assert.deepEqual(recorded.filter(event => event.status === 'invalid-response').map(event => event.detail.diagnostics),
        [['target-self-mock'], ['target-self-mock']]);
});
