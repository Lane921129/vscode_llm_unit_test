import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitReviewPrompt, getTestReviewerSystemPrompt, parseTestReviewDetailed } from '../roles/testReviewer';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';

const code = 'import unittest\nfrom sample import advance\nclass Cases(unittest.TestCase):\n'
    + '    def test_advance(self):\n        self.assertEqual(advance(3), 4)\n'
    + '    def test_negative(self):\n        self.assertEqual(advance(-1), 0)\n';
const evidence = 'TARGET: sample.advance\nOBSERVATION case_1: exact typed input int(3), returned int(4).\n'
    + 'OBSERVATION case_2: exact typed input int(-1), returned int(0).\nNo independent business specification supplied.';

test('Reviewer requests a per-case input/expected audit with concrete evidence and refuses guessed oracles', () => {
    const system = getTestReviewerSystemPrompt();
    assert.match(system, /Audit every test case's actual target call, input and expected return\/exception/);
    assert.match(system, /constructor\/setup, argument types and keyword order/);
    assert.match(system, /reason must name the asserted input\/expected pair/);
    assert.match(system, /cite the relevant observation\/fact ID/);
    assert.match(system, /An unverified expected value is not a proven wrong value/);
    assert.match(system, /Never invent its replacement from model arithmetic, type annotations or a return expression/);
    assert.match(system, /request a controlled observation or explicit contract in action/);
    assert.match(system, /exactly: category, test_line, reason, action/);
});

test('formal Reviewer receives complete numbered cases and unchanged evidence, with an all-or-nothing prompt budget', async () => {
    const prompt = fitReviewPrompt({ tests: code, evidence, executionVerified: true }, 10000)!;
    assert.match(prompt, /CASE_AUDIT: Check every test input and expected return\/exception/);
    assert.ok(prompt.includes('[L5]         self.assertEqual(advance(3), 4)'));
    assert.ok(prompt.includes('[L7]         self.assertEqual(advance(-1), 0)'));
    assert.ok(prompt.includes(evidence));
    assert.equal(fitReviewPrompt({ tests: code, evidence, executionVerified: true }, prompt.length - 1), undefined);
    let requests = 0;
    const events: string[] = [];
    const review = await reviewWithContractRepair({ tests: code, prompt, deadlineAt: 1000, now: () => 100,
        constraints: { target: 'advance', methodKind: 'module', module: 'sample' }, checkCancelled: () => {},
        event: status => events.push(status),
        request: async (actual, deadline) => {
            requests++;
            assert.equal(actual, prompt);
            assert.equal(deadline, 1000);
            return '{"findings":[]}';
        } });
    assert.deepEqual(review, { issues: [] });
    assert.equal(requests, 1);
    assert.deepEqual(events, ['parsed']);
});

test('a concrete verification-gap finding retains its reason/evidence and cannot be converted into approval', () => {
    const reply = JSON.stringify({ findings: [{ category: 'assertion-quality', test_line: 'L7',
        reason: 'The advance(-1) assertion expects 0, but no supplied exact-input observation supports the negative boundary; correctness remains unverified.',
        action: 'Add a controlled observation for advance(-1) or an explicit boundary contract before changing its expected result.' }] });
    const parsed = parseTestReviewDetailed(reply, code, true, { target: 'advance', module: 'sample', methodKind: 'module' });
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.review?.issues.length, 1);
    assert.equal(parsed.review?.issues[0].testLine, 7);
    assert.equal(parsed.review?.issues[0].evidence.trim(), 'self.assertEqual(advance(-1), 0)');
    assert.match(parsed.review!.issues[0].reason, /correctness remains unverified/);
    assert.match(parsed.review!.issues[0].action, /controlled observation/);
});
