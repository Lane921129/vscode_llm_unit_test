import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { applyWriterMethodEdits, planWriterMethodEdits, planWriterNameBindingEdits } from '../validation/writerMethodEdits';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { validatePassingTestPreservation } from '../pipeline/passingTestPreservation';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const baseline = `# 完整原文
import unittest
from sample import choose

class First(unittest.TestCase):
    def setUp(self):
        self.control = "保留 fixture"

    def test_same(self):
        # preserve this passing method byte for byte
        self.assertEqual(choose(1), (1, "值"))

class Second(unittest.TestCase):
    def test_same(self):
        self.assertEqual(choose(1), (1, "值"))

# complete original footer
`;
const lineRefs = [15];
const response = '```python\nclass Second:\n    def test_same(self):\n        self.assertTupleEqual(choose(1), (1, "值"))\n```';
const toolFailure = (error: unknown) => error instanceof AnalysisStageError && error.stage === 'writer-method-edit-tool'
    && !error.message.includes('PRIVATE_SOURCE');

test('Checker class and AST line disambiguate same-named methods; missing or mismatched locations cannot widen scope', async () => {
    const validation = { reasonCode: 'writer-undefined-name', name: 'missing', method: 'test_same', className: 'Second', line: 15 };
    const plan = await planWriterNameBindingEdits({ baseline, validation, python });
    assert.ok(plan.ok);
    assert.equal(plan.methods[0].id, 'Second.test_same');
    for (const finding of [{ ...validation, line: undefined }, { ...validation, className: 'First' },
        { ...validation, reasonCode: 'unknown' }, { ...validation, line: 1 }]) {
        assert.equal((await planWriterNameBindingEdits({ baseline, validation: finding, python })).ok, false);
    }
});

test('host binds an AST method plan to exact UTF-8 bytes and independently composes a bounded model edit', async () => {
    const plan = await planWriterMethodEdits({ baseline, lineRefs, python });
    assert.ok(plan.ok);
    assert.equal(plan.methods[0].id, 'Second.test_same');
    assert.equal(Buffer.from(baseline).subarray(plan.methods[0].startByte, plan.methods[0].endByte).toString(), plan.methods[0].code);
    const result = await applyWriterMethodEdits({ baseline, lineRefs, plan, response, python });
    assert.ok(result.ok);
    assert.deepEqual(result.changedMethodIds, ['Second.test_same']);
    const originalPrefix = baseline.slice(0, baseline.indexOf('    def test_same', baseline.indexOf('class Second')));
    assert.ok(result.code.startsWith(originalPrefix), 'all imports, first TestCase and fixture bytes remain exact');
    assert.ok(result.code.endsWith('\n# complete original footer\n'));
    const preservation = await validatePassingTestPreservation({ previousCode: baseline, candidateCode: result.code,
        protectedMethods: 'all', python });
    assert.equal(preservation.valid, true, preservation.reason);
});

test('Unicode and CRLF offsets are byte offsets and never JavaScript character offsets', async () => {
    const code = baseline.replaceAll('\n', '\r\n');
    const plan = await planWriterMethodEdits({ baseline: code, lineRefs, python });
    assert.ok(plan.ok);
    const result = await applyWriterMethodEdits({ baseline: code, lineRefs, plan, response, python });
    assert.ok(result.ok);
    assert.ok(result.code.startsWith(code.slice(0, code.indexOf('class Second'))));
    assert.ok(result.code.endsWith('\r\n# complete original footer\r\n'));
});

test('complete suite replies, new methods and fixture edits are rejected rather than silently discarded', async () => {
    const plan = await planWriterMethodEdits({ baseline, lineRefs, python });
    assert.ok(plan.ok);
    for (const code of [baseline.replaceAll('assertEqual', 'assertTupleEqual'),
        'class Second:\n    def test_new(self):\n        self.assertTrue(True)',
        'class Second:\n    def setUp(self):\n        self.control = 9']) {
        const result = await applyWriterMethodEdits({ baseline, lineRefs, plan, response: '```python\n' + code + '\n```', python });
        assert.equal(result.ok, false);
    }
});

test('source drift, plan drift and malformed AST tool results stop as tool failures', async () => {
    const plan = await planWriterMethodEdits({ baseline, lineRefs, python });
    assert.ok(plan.ok);
    await assert.rejects(applyWriterMethodEdits({ baseline: baseline + '# drift', lineRefs, plan, response, python }), toolFailure);
    await assert.rejects(applyWriterMethodEdits({ baseline, lineRefs, plan: { ...plan, planHash: '0'.repeat(64) }, response, python }), toolFailure);
    const runner = require('../utils/processRunner') as typeof import('../utils/processRunner');
    const original = runner.runSpawn;
    try {
        for (const stdout of ['PRIVATE_SOURCE', JSON.stringify({ schemaVersion: 'writer-method-edit-plan-v1', ok: true }),
            JSON.stringify({ schemaVersion: 'writer-method-edit-plan-v1', ok: false, reasonCode: 'PRIVATE_SOURCE invalid' })]) {
            (runner as any).runSpawn = async () => ({ code: 0, stdout });
            await assert.rejects(planWriterMethodEdits({ baseline, lineRefs, python }), toolFailure);
        }
        (runner as any).runSpawn = async () => { throw new Error('PRIVATE_SOURCE provider text'); };
        await assert.rejects(planWriterMethodEdits({ baseline, lineRefs, python }), toolFailure);
        const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        (runner as any).runSpawn = async () => { throw cancelled; };
        await assert.rejects(planWriterMethodEdits({ baseline, lineRefs, python }), error => error === cancelled);
    } finally { (runner as any).runSpawn = original; }
});

test('a forged tool edit cannot change bytes outside the original planned spans', async () => {
    const plan = await planWriterMethodEdits({ baseline, lineRefs, python });
    assert.ok(plan.ok);
    const runner = require('../utils/processRunner') as typeof import('../utils/processRunner');
    const original = runner.runSpawn;
    try {
        (runner as any).runSpawn = async (...args: Parameters<typeof original>) => {
            const run = await original(...args);
            const value = JSON.parse(run.stdout);
            assert.equal(value.ok, true);
            value.edits[0].startByte = 0;
            return { ...run, stdout: JSON.stringify(value) };
        };
        await assert.rejects(applyWriterMethodEdits({ baseline, lineRefs, plan, response, python }), toolFailure);
    } finally { (runner as any).runSpawn = original; }
});

test('module and fixture findings remain explicitly unsupported instead of granting whole-file edits', async () => {
    for (const lines of [[1], [6], [], [0], [Number.NaN]]) {
        const plan = await planWriterMethodEdits({ baseline, lineRefs: lines, python });
        assert.equal(plan.ok, false);
    }
});
