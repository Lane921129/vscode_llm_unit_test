import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectRejectedReviewFindings, parseTestReviewDetailed } from '../roles/testReviewer';
import { reviewWithContractRepair, ReviewContractEvent } from '../roles/reviewContractRepair';
import { WITHHELD_SENSITIVE_CONTENT } from '../pipeline/artifactSafety';

const tests = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
    + '    def test_value(self):\n        self.assertEqual(target(1), 2)\n';
const finding = { category: 'target-binding', test_line: 'L2',
    reason: 'The target function must be a static method.', action: 'Replace this test with a static method case.' };

test('rejected review projection retains bounded exact fields and cited test lines without provider prose or unknown keys', () => {
    const unknown = 'PROVIDER_EXTRA_FIELD_NOT_RETAINED';
    const raw = 'PROVIDER_PROSE_NOT_RETAINED\n' + JSON.stringify({ findings: [finding], extra: unknown });
    const projected = projectRejectedReviewFindings(raw, tests);
    assert.deepEqual(projected, [{ ...finding, excerpt: 'from sample import target' }]);
    assert.equal(JSON.stringify(projected).includes(unknown), false);
    assert.equal(JSON.stringify(projected).includes('PROVIDER_PROSE_NOT_RETAINED'), false);
    assert.equal(parseTestReviewDetailed(raw, tests, true, { target: 'target', methodKind: 'module' }).review, undefined);
});

test('projection caps five findings and text lengths, withholding secrets before any truncation', () => {
    const secret = 'private-known-secret-value-for-fixture';
    const raw = JSON.stringify({ findings: Array.from({ length: 9 }, (_, i) => ({
        category: 'unsupported'.repeat(30), test_line: 'L' + '1'.repeat(60),
        reason: i === 0 ? 'x'.repeat(590) + secret : 'r'.repeat(1000),
        action: i === 1 ? 'Bearer ' + 'A'.repeat(32) : 'a'.repeat(1000),
        excerpt: i === 2 ? 'prefix ' + secret : 'e'.repeat(1000)
    })) });
    const projected = projectRejectedReviewFindings(raw, tests, [secret]);
    assert.equal(projected.length, 5);
    assert.ok(projected.every(item => (item.category?.length ?? 0) <= 80 && (item.test_line?.length ?? 0) <= 32
        && (item.reason?.length ?? 0) <= 600 && (item.action?.length ?? 0) <= 600 && (item.excerpt?.length ?? 0) <= 400));
    assert.equal(projected[0].reason, WITHHELD_SENSITIVE_CONTENT);
    assert.equal(projected[1].action, WITHHELD_SENSITIVE_CONTENT);
    assert.equal(projected[2].excerpt, WITHHELD_SENSITIVE_CONTENT);
    assert.equal(JSON.stringify(projected).includes(secret), false);
    assert.equal(JSON.stringify(projected).includes('A'.repeat(32)), false);
});

test('non-JSON responses and unrelated JSON shapes cannot become reconstructed provider content', () => {
    for (const raw of ['not JSON with private prose', '{"findings":[bad}', '{"unrelated":"private prose"}',
        '{"findings":["private scalar",null,42]}']) {
        assert.deepEqual(projectRejectedReviewFindings(raw, tests), []);
    }
});

test('two contradicted assessments retain safe diagnostic claims, then remain unavailable with no third request or approval', async () => {
    const events: Array<{ status: string; detail: ReviewContractEvent }> = [];
    let requests = 0;
    const secret = 'fixture-private-key-value-retained-nowhere';
    const result = await reviewWithContractRepair({ tests, prompt: 'complete evidence prompt', deadlineAt: Date.now() + 30000,
        constraints: { target: 'target', methodKind: 'module' }, knownSecrets: [secret], checkCancelled() {},
        request: async () => { requests++; return JSON.stringify({ findings: [{ ...finding,
            action: finding.action + ' ' + secret }] }); }, event: (status, detail) => events.push({ status, detail }) });
    assert.equal(result, undefined);
    assert.equal(requests, 2);
    const rejected = events.filter(event => event.status === 'invalid-response');
    assert.equal(rejected.length, 2);
    assert.deepEqual(rejected[0].detail.diagnostics, ['target-binding-contradiction']);
    assert.equal(rejected[0].detail.rejectedFindings?.[0].reason, finding.reason);
    assert.equal(rejected[0].detail.rejectedFindings?.[0].action, WITHHELD_SENSITIVE_CONTENT);
    assert.match(rejected[0].detail.responseHash!, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.ok(events.every(event => !Object.hasOwn(event.detail, 'raw')));
});

test('unknown semantic findings remain usable review suggestions rather than being erased by diagnostic projection', async () => {
    const semantic = { category: 'missing-scenario', test_line: 'L5',
        reason: 'The specified account cancellation behavior lacks an independent case.',
        action: 'Add an independent cancellation scenario from the supplied requirements.' };
    const result = await reviewWithContractRepair({ tests, prompt: 'requirements and test', deadlineAt: Date.now() + 30000,
        constraints: { target: 'target', methodKind: 'module' }, request: async () => JSON.stringify({ findings: [semantic] }),
        checkCancelled() {}, event() {} });
    assert.equal(result?.issues.length, 1);
    assert.equal(result?.issues[0].reason, semantic.reason);
    assert.equal(result?.issues[0].severity, 'quality');
});
