import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildReviewFacts, ReviewFacts } from '../roles/reviewFacts';
import { parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';

const identity = { runId: 'mechanical-review', sourceHash: 'a'.repeat(64), target: 'connect' };
const code = 'import unittest\nfrom unittest.mock import patch\nfrom sample import connect\n'
    + 'class Cases(unittest.TestCase):\n'
    + '    def setUp(self):\n        self.patcher = patch("sample.channel")\n'
    + '        self.channel = self.patcher.start()\n'
    + '    def tearDown(self):\n        self.patcher.stop()\n'
    + '    def test_value(self):\n        with patch("sample.value", 2):\n'
    + '            result = connect()\n            self.assertEqual(result, "mock_connection")\n';
const python = path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const facts = (tests = code) => buildReviewFacts({ ...identity, module: 'sample', code: tests,
    executionVerified: true, python, env: process.env });
const constraints = (value: ReviewFacts): ReviewConstraints => ({ ...identity, module: 'sample', methodKind: 'module', identity, facts: value });
const response = (line: number, category: string, reason: string, action: string) => JSON.stringify({ findings: [{ category, test_line: `L${line}`, reason, action }] });
const claims = [
    [1, 'setup-error', 'Importing unittest.mock.patch() without a target is not allowed.', 'Add a target to the patch() call, such as patch("sample.channel").', 'unrelated-test-line'],
    [1, 'setup-error', 'Import statement is not a valid unittest module.', "Replace 'unittest' with 'unittest.mock' in line 1.", 'existing-harness-contradiction'],
    [3, 'target-binding', 'Target binding is not a valid unittest module.', "Replace 'sample' with 'sample.connect' in line 3.", 'target-binding-contradiction'],
    [13, 'assertion-evidence', 'Assertion is not a valid unittest assertion.', "Replace 'self.assertEqual' with 'self.assertIs' in line 13.", 'existing-assertion-contradiction']
] as const;

test('executed candidate facts reject old vehicle mechanical claims without removing findings', async () => {
    const current = await facts();
    assert.deepEqual(current.methods[0].standardAssertions, [{ line: 13, kind: 'assertEqual' }]);
    assert.deepEqual(current.methods[0].assertions, [{ line: 13, kind: 'assertEqual', observationStatus: 'unknown' }],
        'method syntax has an explicit unknown state, without target-result or verified evidence');
    for (const [line, category, reason, action, diagnostic] of claims) {
        const parsed = parseTestReviewDetailed(response(line, category, reason, action), code, true, constraints(current));
        assert.equal(parsed.review, undefined, reason);
        assert.deepEqual(parsed.diagnostics, [diagnostic], reason);
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), code, true,
            constraints({ ...current, executionVerified: false })).review, 'unexecuted facts cannot deny a runtime claim');
    }
});

test('source requirements, unknown semantic failures and actual patch-call claims remain reviewable', async () => {
    const current = await facts();
    for (const [line, category, reason, action] of [
        [1, 'setup-error', 'Import statement is not a valid unittest module because the fixture replaces sys.modules.', 'Check the fixture import contract.'],
        [3, 'target-binding', 'Target binding is not a valid unittest module for the separate plugin discovery contract.', 'Use the documented plugin loader.'],
        [13, 'assertion-evidence', 'Equality does not satisfy the supplied identity requirement.', 'Replace self.assertEqual with self.assertIs for the explicit identity contract.'],
        [13, 'assertion-evidence', 'The expected value is not supported by a controlled observation.', 'Record the exact input and observed result before assigning an expected value.'],
        [13, 'assertion-quality', 'The documented contract also requires the returned object type.', 'Add assertIsInstance for the documented type.'],
        [6, 'setup-error', 'Importing unittest.mock.patch() without a target is not allowed.', 'Pass the dependency use point as the first argument.'],
    ] as const) {
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), code, true, constraints(current)).review, reason);
    }
    const identityCode = code.replace('self.assertEqual(result, "mock_connection")', 'self.assertIs(result, None)');
    const identityFacts = await facts(identityCode);
    assert.ok(parseTestReviewDetailed(response(13, 'assertion-evidence', 'Identity does not satisfy the explicit equality requirement.',
        'Replace self.assertIs with self.assertEqual for the documented value.'), identityCode, true, constraints(identityFacts)).review);
});

test('unknown harness, target or assertion bindings cannot reject a mechanical assessment', async () => {
    for (const [tests, line, category, reason, action] of [
        [code.replace('from sample import connect', 'from sample import connect\nconnect = other'), 3, 'target-binding', claims[2][2], claims[2][3]],
        [code.replace('    def test_value', '    def assertEqual(self, *args):\n        pass\n    def test_value'), 15, 'assertion-evidence', claims[3][2], claims[3][3]],
        [code.replace('self.assertEqual(result, "mock_connection")', 'self.assertNotAUnittestMethod(result)'), 13, 'assertion-evidence', claims[3][2], claims[3][3]],
    ] as const) {
        const current = await facts(tests);
        assert.ok(parseTestReviewDetailed(response(line, category, reason, action), tests, true, constraints(current)).review);
    }
});

test('repeated mechanical contradiction consumes one correction and never becomes an approval', async () => {
    const current = await facts();
    const bad = response(claims[3][0], claims[3][1], claims[3][2], claims[3][3]);
    const calls: number[] = [];
    const events: string[] = [];
    const review = await reviewWithContractRepair({ tests: code, prompt: 'same candidate and facts', constraints: constraints(current),
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: status => events.push(status),
        request: async (_prompt, deadline) => { calls.push(deadline); return bad; } });
    assert.equal(review, undefined);
    assert.deepEqual(calls, [1000, 1000]);
    assert.deepEqual(events, ['invalid-response', 'repair-requested', 'invalid-response']);
    assert.deepEqual(parseTestReviewDetailed('{"findings":[]}', code + '# changed\n', true, constraints(current)).diagnostics,
        ['review-facts-identity-mismatch'], 'new syntax fields retain exact candidate identity');
});

test('executed direct target imports contradict function-as-module claims, leaving causal requirements unknown', async () => {
    const tests = code.replace('        with patch("sample.value", 2):\n            result = connect()\n            self.assertEqual(result, "mock_connection")',
        '        result = connect()\n        self.assertEqual(result, "mock_connection")');
    const current = await facts(tests);
    const reason = 'The target binding is incorrect. The target is a function, but the binding is a module.';
    const action = "Change the target binding to 'sample.connect'.";
    assert.deepEqual(parseTestReviewDetailed(response(3, 'target-binding', reason, action), tests, true, constraints(current)).diagnostics,
        ['target-binding-contradiction']);
    for (const changed of [reason + ' The supplied plugin registry requires a module.',
        'The other callback expects a module instead of this function.']) {
        assert.ok(parseTestReviewDetailed(response(3, 'target-binding', changed, action), tests, true, constraints(current)).review);
    }
});

test('optional tool assertion metadata must have an exact supported shape and candidate identity', async t => {
    const original = await facts();
    const runner = require('../utils/processRunner') as typeof import('../utils/processRunner');
    const metadata: unknown[] = [
        'not-an-array', [{ line: '13', kind: 'assertEqual' }], [{ line: 99, kind: 'assertEqual' }],
        [{ line: 13, kind: 'not-an-assertion' }], [{ line: 13, kind: 'assertEqual', observationVerified: true }],
    ];
    for (const value of metadata) {
        const changed = { ...original, methods: original.methods.map(method => ({ ...method, standardAssertions: value })) };
        const mock = t.mock.method(runner, 'runSpawn', async () => ({ code: 0, stdout: JSON.stringify(changed), stderr: '' }));
        try { await assert.rejects(facts(), /bound to this candidate/); } finally { mock.mock.restore(); }
    }
});
