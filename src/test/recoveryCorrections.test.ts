import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { mergeBugFixReplacementDetailed } from '../roles/bugFixer';
import { parseTestReviewDetailed } from '../roles/testReviewer';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';

const original = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
    + '    def setUp(self):\n        self.value = 2\n'
    + '    def test_value(self):\n        self.assertEqual(target(self.value), 999)\n'
    + '    def test_keep(self):\n        self.assertEqual(target(0), 1)\n';
const method = 'def test_value(self):\n    self.assertEqual(target(self.value), 3)';
const failure = 'FAIL: test_value (Cases.test_value)\nAssertionError: 3 != 999';
const fence = (code: string) => '```python\n' + code + '\n```';

test('repair normalizes one code block and one unchanged class wrapper, then requires AST scope validation', () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const wrapper = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
        + method.split('\n').map(line => '    ' + line).join('\n');
    for (const reply of ['Explanation\n' + fence(method), fence(method) + '\nExplanation',
        fence(wrapper), 'Explanation\n' + fence(wrapper) + '\nEnd']) {
        const result = mergeBugFixReplacementDetailed(reply, original, failure);
        assert.ok(result.normalization);
        assert.equal(result.code, original.trimEnd().replace('999', '3'));
        const scoped = spawnSync(python, [pythonToolPath('repairScope')], { encoding: 'utf8',
            input: JSON.stringify({ previous: original, candidate: result.code, failure }) });
        assert.equal(scoped.status, 0, scoped.stderr);
        assert.equal(JSON.parse(scoped.stdout).valid, true);
    }
    for (const code of [wrapper.replace('Cases(unittest.TestCase)', 'Other(unittest.TestCase)'),
        wrapper + '\n    def test_extra(self):\n        pass',
        wrapper.replace('    def test_value', '    def setUp(self):\n        self.value = 9\n    def test_value'),
        wrapper.replace('    def test_value', '    @unittest.skip("skip")\n    def test_value')]) {
        assert.equal(mergeBugFixReplacementDetailed(fence(code), original, failure).code, undefined, code);
    }
    assert.equal(mergeBugFixReplacementDetailed(fence(method) + fence(method), original, failure).code, undefined);
    const legacy = JSON.stringify({ method: 'test_value', replacement: method, imports: [] });
    assert.equal(mergeBugFixReplacementDetailed('```json\n' + legacy + '\n```\n' + fence('pass'), original, failure).code,
        undefined, 'legacy JSON cannot bypass the multiple-block rejection');
    const changedSignature = mergeBugFixReplacementDetailed('Explanation\n' + fence(method.replace('(self)', '(self, extra)')), original, failure).code;
    const rejected = spawnSync(python, [pythonToolPath('repairScope')], { encoding: 'utf8',
        input: JSON.stringify({ previous: original, candidate: changedSignature, failure }) });
    assert.equal(JSON.parse(rejected.stdout).valid, false, 'normalization must not bypass the real scope gate');
});

test('review cannot mistake a source dependency patch or its standard import for target replacement', async () => {
    const code = 'from unittest.mock import patch\n@patch("sample.helper")\ndef test_value(): pass';
    const constraints = { target: 'target', module: 'sample', methodKind: 'module', dependencyUsePoints: ['sample.helper'] };
    const raw = (category: string, test_line: string, reason: string) => JSON.stringify({ findings: [
        { category, test_line, reason, action: 'Remove the patch decorator.' }
    ] });
    const wrong = raw('target-binding', 'L2', 'Patching the target function is not allowed.');
    assert.deepEqual(parseTestReviewDetailed(wrong, code, true, constraints).diagnostics, ['target-binding-contradiction']);
    assert.equal(parseTestReviewDetailed(raw('setup-error', 'L1', 'Patching the database module is not allowed.'), code, true, constraints).review, undefined);
    assert.ok(parseTestReviewDetailed(wrong, code.replace('sample.helper', 'sample.target'), true, constraints).review);
    assert.ok(parseTestReviewDetailed(raw('mock-isolation', 'L2', 'This dependency patch is not cleaned up after the test.'), code, true, constraints).review);
    let revisions = 0;
    const result = await validateTestCandidate(code, {
        validate: async () => undefined, execute: async () => ({ ok: true, out: 'Ran 1 test\nOK', qualityGaps: [] }),
        review: async () => parseTestReviewDetailed(wrong, code, true, constraints).review,
        revise: async () => { revisions++; return code; }, event: () => {}, checkCancelled: () => {}
    });
    assert.equal(revisions, 0);
    assert.equal(result.reviewStatus, 'incomplete');
});
