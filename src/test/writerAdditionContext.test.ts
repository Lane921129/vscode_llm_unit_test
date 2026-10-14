import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { test } from 'node:test';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { validatePassingTestPreservation } from '../pipeline/passingTestPreservation';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { mergeWriterTestAddition, projectWriterAdditionContext } from '../validation/testMerger';
import type { runSpawn } from '../utils/processRunner';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const baseline = 'import unittest\nfrom nonexistent_projection_target_987 import target\n'
    + 'class Cases(unittest.TestCase):\n'
    + '    def test_original(self): self.assertEqual(target(987.654, 123.456), "old-answer-987")\n'
    + '    def test_例外(self):\n'
    + '        with self.assertRaises(ZeroDivisionError): target(789, 0)\n';
const hash = (source: string): string => createHash('sha256').update(source, 'utf8').digest('hex');

test('simple Writer setup projection keeps imports and class metadata with no prior input or expected body', async () => {
    const result = await projectWriterAdditionContext({ baseline, python });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.baselineHash, hash(baseline));
    assert.deepEqual(result.methodIds, ['Cases.test_original', 'Cases.test_例外']);
    assert.equal(result.contextCode,
        'import unittest\nfrom nonexistent_projection_target_987 import target\n\nclass Cases(unittest.TestCase):\n    pass\n');
    for (const removed of ['987.654', '123.456', 'old-answer-987', 'assertEqual', 'test_original', 'ZeroDivisionError']) {
        assert.ok(!result.contextCode.includes(removed), removed);
    }
});

test('standard unittest aliases and exact optional main guard remain prompt-only setup', async () => {
    for (const code of [baseline.replace('import unittest', 'import unittest as standard').replace('unittest.TestCase', 'standard.TestCase')
        + '\nif __name__ == "__main__":\n    standard.main()\n',
    baseline.replace('import unittest', 'from unittest import TestCase as Standard').replace('unittest.TestCase', 'Standard')]) {
        const result = await projectWriterAdditionContext({ baseline: code, python });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.baselineHash, hash(code));
        assert.deepEqual(result.methodIds, ['Cases.test_original', 'Cases.test_例外']);
        assert.ok(!result.contextCode.includes('__main__'));
        assert.ok(!result.contextCode.includes('old-answer-987'));
    }
});

test('fixture, decorator, helper, reflection and ambiguous binding preserve the full-view fallback reason', async () => {
    const variants = [baseline.replace('    def test_original', '    def setUp(self): self.fixture = 1\n    def test_original'),
        baseline.replace('    def test_original', '    @classmethod\n    def test_original'),
        baseline.replace('    def test_original', '    def helper(self): pass\n    def test_original'),
        baseline.replace('target(987.654, 123.456)', 'getattr(self, "test_例外")()'),
        baseline.replace('target(987.654, 123.456)', 'self.test_例外()'),
        baseline + '\nclass Other(unittest.TestCase):\n    def test_other(self): pass\n',
        baseline.replace('test_例外(self)', 'test_original(self)'),
        'import unittest as controlled\nfrom unrelated import controlled\n' + baseline.replace('unittest.TestCase', 'controlled.TestCase'),
        ('import neutral_state as state\n' + baseline).replace('    def test_original(self):',
            '    def test_original(self):\n        state.options["groups"][0].options["mode"] = "changed"\n       '),
        ('from neutral_state import flags\n' + baseline).replace('    def test_original(self):',
            '    def test_original(self):\n        del flags["mode"]\n       '),
        baseline + '\nif __name__ == "__main__":\n    unittest.main(exit=False)\n'];
    for (const code of variants) {
        const result = await projectWriterAdditionContext({ baseline: code, python });
        assert.deepEqual(result, { ok: false, reasonCode: 'addition-context-unsupported' });
        assert.equal(code.includes('old-answer-987'), true, 'projection never mutates the caller baseline');
    }
});

test('new method composition retains the original baseline bytes, methods and preservation checks', async () => {
    const original = (baseline + '\nif __name__ == "__main__":\n    unittest.main()\n').replace(/\n/g, '\r\n');
    const result = await projectWriterAdditionContext({ baseline: original, python });
    assert.ok(result.ok);
    const merged = await mergeWriterTestAddition({ baseline: original,
        addition: 'def test_added(self): self.assertEqual(target(321, 654), "new-answer")\n', python });
    assert.ok(merged.ok, JSON.stringify(merged));
    assert.equal(merged.totalMethodsCount, 3);
    assert.equal(merged.addedMethodsCount, 1);
    assert.ok(merged.mergedCode.startsWith(baseline.replace(/\n/g, '\r\n')));
    assert.ok(merged.mergedCode.includes('old-answer-987'));
    assert.equal(result.baselineHash, hash(original));
    const preserved = await validatePassingTestPreservation({ previousCode: original, candidateCode: merged.mergedCode,
        protectedMethods: 'all', python, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    assert.equal(preserved.valid, true, preserved.reason);
    const changed = await mergeWriterTestAddition({ baseline: original,
        addition: baseline.replace('old-answer-987', 'wrong-answer'), python });
    assert.deepEqual(changed, { ok: false, reasonCode: 'existing-test-method-changed' });
});

test('invalid input, syntax, missing executable and malformed tool receipts have typed failures', async () => {
    assert.deepEqual(await projectWriterAdditionContext({ baseline: ' ', python }), { ok: false, reasonCode: 'invalid-baseline-input' });
    assert.deepEqual(await projectWriterAdditionContext({ baseline: 'class invalid !', python }), { ok: false, reasonCode: 'invalid-python-structure' });
    assert.deepEqual(await projectWriterAdditionContext({ baseline, python: path.join(__dirname, 'missing-projection-python.exe') }),
        { ok: false, reasonCode: 'projection-tool-error' });
    const runner = require('../utils/processRunner') as { runSpawn: typeof runSpawn };
    const original = runner.runSpawn;
    const valid = { schemaVersion: 'writer-addition-context-v1', ok: true, contextCode: 'import unittest\nclass Cases(unittest.TestCase):\n    pass\n',
        methodIds: ['Cases.test_original', 'Cases.test_例外'], baselineHash: hash(baseline) };
    try {
        for (const body of ['partial-json', JSON.stringify({ ...valid, baselineHash: hash('different-baseline') }),
            JSON.stringify({ ...valid, methodIds: ['Cases.test_original', 'Other.test_例外'] }),
            JSON.stringify({ ...valid, methodIds: ['Cases.test_original', 'Cases.test_original'] }),
            JSON.stringify({ schemaVersion: 'writer-addition-context-v1', ok: false, reasonCode: 'arbitrary-provider-text' }),
            JSON.stringify({ ...valid, schemaVersion: 'different-version' })]) {
            runner.runSpawn = async () => ({ code: 0, stdout: body, stderr: '' });
            assert.deepEqual(await projectWriterAdditionContext({ baseline, python }), { ok: false, reasonCode: 'projection-tool-error' });
        }
        runner.runSpawn = async () => ({ code: 1, stdout: JSON.stringify(valid), stderr: 'private tool detail' });
        assert.deepEqual(await projectWriterAdditionContext({ baseline, python }), { ok: false, reasonCode: 'projection-tool-error' });
    } finally { runner.runSpawn = original; }
});

test('projection does not swallow a fixed target deadline, budget failure or user cancellation', async () => {
    const runner = require('../utils/processRunner') as { runSpawn: typeof runSpawn };
    const original = runner.runSpawn;
    try {
        for (const category of ['timeout', 'budget'] as const) {
            const failure = new AnalysisStageError(category, 'target-budget', 'owned failure');
            runner.runSpawn = async () => { throw failure; };
            await assert.rejects(projectWriterAdditionContext({ baseline, python }), error => error === failure);
        }
        const execution = new ExecutionContext({});
        runner.runSpawn = async () => { execution.cancel(); throw new Error('worker cancelled'); };
        await assert.rejects(runInExecution(execution, () => projectWriterAdditionContext({ baseline, python })), /使用者強制中止|cancel/i);
    } finally { runner.runSpawn = original; }
});
