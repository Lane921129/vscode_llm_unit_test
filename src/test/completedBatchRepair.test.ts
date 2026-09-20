import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fitReviewPrompt, parseTestReviewDetailed, reviewableLineIds } from '../roles/testReviewer';
import { parseFocusedQualityTask } from '../roles/qualityAnalyst';
import { canRepairTestMethod, getBugFixerSystemPrompt, mergeBugFixReplacement } from '../roles/bugFixer';
import { classifyExecutionFailure } from '../utils/executionFailureCategory';
import { pythonToolPath } from '../pipeline/pythonTools';
import { generatedUnittestArguments, resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const code = `import unittest
from sample import add

# Evidence comments do not receive line IDs.
class Cases(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 4)
`;
const failure = 'FAIL: test_add (Cases.test_add)\nAssertionError: 5 != 4';
const finding = { category: 'target-binding', test_line: 'L7', reason: 'The selected target binding is contradicted.',
    action: 'Call the real target with the declared inputs.' };

test('review IDs exclude blanks and comments while preserving their position and full context', () => {
    assert.deepEqual(reviewableLineIds(code), ['L1', 'L2', 'L5', 'L6', 'L7']);
    const prompt = fitReviewPrompt({ tests: code, evidence: 'complete context' }, 9000)!;
    assert.match(prompt, /VALID_TEST_LINE_IDS: L1, L2, L5, L6, L7/);
    assert.doesNotMatch(prompt, /\[L3\]|\[L4\]/);
    assert.match(prompt, /# Evidence comments/);
    for (const test_line of ['L3', 'L4']) {
        assert.equal(parseTestReviewDetailed(JSON.stringify({ findings: [{ ...finding, test_line }] }), code, true).review, undefined);
    }
});

test('review template echoes and unrelated import citations cannot send the Writer a fabricated defect', () => {
    for (const change of [
        { reason: 'identify a specific untested branch', action: 'describe the test improvement' },
        { action: 'describe the test improvement' },
        { test_line: 'L1' },
        { category: 'assertion-evidence', test_line: 'L6' }
    ]) {
        assert.equal(parseTestReviewDetailed(JSON.stringify({ findings: [{ ...finding, ...change }] }), code, true).review, undefined);
    }
});

test('quoted decorators and mocked target replacements are rejected for module functions', () => {
    for (const action of [
        "add the '@staticmethod' decorator to 'add'",
        "replace 'add' with a mocked 'add' method",
        'Replace `add` with a stubbed method to avoid changing its implementation.',
        'Apply “classmethod” to the target function.'
    ]) {
        const result = parseTestReviewDetailed(JSON.stringify({ findings: [{ ...finding, action }] }), code, true,
            { target: 'add', methodKind: 'module' });
        assert.equal(result.review, undefined, action);
        assert.ok(result.diagnostics.some(x => x === 'target-implementation-edit' || x === 'target-self-mock'));
    }
    for (const action of ["Do not mock 'add'; call the real function.", "Remove the patch on 'add'.",
        "Patch 'sample.read' before calling add."]) {
        assert.ok(parseTestReviewDetailed(JSON.stringify({ findings: [{ ...finding, action }] }), code, true,
            { target: 'add', methodKind: 'module' }).review, action);
    }
});

test('quality tasks reject copied instructions while allowing a concrete None-input experiment', () => {
    const focus = { id: 'E1234567890abcdef', kind: 'coverage' as const, evidence: 'line:7' };
    const task = { evidence_id: focus.id, hypothesis: 'The false branch has no observed scenario.',
        scenario: 'Call the target with value=None after arranging an empty local state.',
        verification: 'Measure whether line 7 executes and compare the return with the matching mutant.' };
    assert.equal(parseFocusedQualityTask(JSON.stringify({ tasks: [task] }), focus).tasks?.length, 1);
    for (const change of [{ hypothesis: 'suspected weakness' }, { scenario: 'None' },
        { verification: 'what to compare on original and mutant' }]) {
        assert.equal(parseFocusedQualityTask(JSON.stringify({ tasks: [{ ...task, ...change }] }), focus).tasks, undefined);
    }
});

test('native Python Bug Fixer fragments preserve other tests and execute through scope and isolation gates', () => {
    assert.match(getBugFixerSystemPrompt(), /real Python newlines/);
    const original = code + '\n    def test_keep(self):\n        self.assertEqual(add(0, 1), 1)\n';
    const repaired = mergeBugFixReplacement('```python\ndef test_add(self):\n    self.assertEqual(add(2, 3), 5)\n```', original, failure)!;
    assert.ok(repaired.includes('def test_keep'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const scope = spawnSync(python, [pythonToolPath('repairScope')], { encoding: 'utf8',
        input: JSON.stringify({ previous: original, candidate: repaired, failure }) });
    assert.equal(scope.status, 0, scope.stderr);
    assert.equal(JSON.parse(scope.stdout).valid, true);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bug-fix-'));
    try {
        fs.writeFileSync(path.join(directory, 'sample.py'), 'def add(a, b): return a + b\n');
        fs.writeFileSync(path.join(directory, 'generated.py'), repaired);
        const run = spawnSync(python, generatedUnittestArguments('generated', directory, true, true), {
            cwd: directory, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stderr, /Ran 2 tests/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('native repair rejects wrong methods, multiple fences and non-import setup before the method', () => {
    for (const fragment of [
        'def test_other(self):\n    pass', 'value = 2\ndef test_add(self):\n    pass',
        'def test_add(self):\n    pass\n```\n```python\ndef test_other(self):\n    pass'
    ]) { assert.equal(mergeBugFixReplacement('```python\n' + fragment + '\n```', code, failure), undefined); }
    assert.equal(canRepairTestMethod(code, failure + '\nTEST_ISOLATION_BLOCKED: file write'), false);
    assert.equal(classifyExecutionFailure('assertRaises(ValueError) 沒有目標原始碼、已驗證行為觀測或 mock side_effect 的例外事實依據。'), 'validation');
    assert.equal(classifyExecutionFailure('Dynamic trace worker failed'), 'ast-trace');
});
