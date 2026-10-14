import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSystemPrompt } from '../roles/unittestWriter';
import { fitReviewPrompt, getTestReviewerSystemPrompt, parseTestReviewDetailed } from '../roles/testReviewer';
import { contextInputBudget, promptFits } from '../prompts/promptBudget';
import { roleRequestBudget } from '../prompts/roleRequestBudget';

test('Reviewer execution fact is explicit, optional and never truncated past the context budget', () => {
    const tests = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(target(1), 2)\n';
    const parts = { tests, evidence: 'COMPLETE_SOURCE_AND_EXACT_OBSERVATIONS' };
    const verified = fitReviewPrompt({ ...parts, executionVerified: true }, 10000)!;
    assert.match(verified, /ISOLATED_EXECUTION_PASSED/);
    assert.match(verified, /\[L2\] from sample import target/);
    assert.match(verified, /COMPLETE_SOURCE_AND_EXACT_OBSERVATIONS/);
    assert.doesNotMatch(fitReviewPrompt(parts, 10000)!, /ISOLATED_EXECUTION_PASSED/);
    assert.equal(fitReviewPrompt({ ...parts, executionVerified: true }, verified.length - 1), undefined);
    const reviewerBudget = roleRequestBudget({ envType: 'local', mode: 'full', role: 'reviewer', seedPending: true,
        contextWindow: 4096, inputBudget: contextInputBudget('', 4096) });
    assert.ok(promptFits(getTestReviewerSystemPrompt(), verified, reviewerBudget.inputBudget),
        'the complete Reviewer instructions and this evidence fit the actual 4096-token runtime input allowance');
    assert.match(getSystemPrompt(1, 'large'), /assertRaises\(ExceptionType\)/);
    assert.doesNotMatch(getSystemPrompt(1, 'large'), /ONLY.*assertRaises\(ValueError\)/);
    const invalid = parseTestReviewDetailed(JSON.stringify({ findings: [{ category: 'target-binding', test_line: 'L1',
        reason: 'The target import is incorrect; use a module import.', action: 'Replace with import sample.' }] }), tests, true);
    assert.equal(invalid.review, undefined);
    assert.deepEqual(invalid.diagnostics, ['unrelated-test-line']);
    assert.deepEqual(parseTestReviewDetailed('{"findings":[]}', tests, true).review?.issues, []);
});
