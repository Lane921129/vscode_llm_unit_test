import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validatePassingTestPreservation } from '../pipeline/passingTestPreservation';
import { extractWriterAdditionCode, mergeWriterTestAddition } from '../validation/testMerger';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const baseline = 'import unittest\nfrom neutral_source import target\nclass Cases(unittest.TestCase):\n'
    + '    def setUp(self): self.value = 1\n'
    + '    def test_passed(self): self.assertEqual(target(self.value), 2)\n';

test('a complete new method inherits the preserved fixture and remains subject to preservation', async () => {
    const result = await mergeWriterTestAddition({ baseline, addition: 'def test_added(self): self.assertEqual(target(2), 3)\n', python });
    assert.ok(result.ok);
    assert.equal(result.addedMethodsCount, 1);
    assert.deepEqual(result.addedMethods, [{ className: 'Cases', name: 'test_added' }]);
    assert.equal(result.totalMethodsCount, 2);
    assert.ok(result.mergedCode.startsWith(baseline));
    const preservation = await validatePassingTestPreservation({ previousCode: baseline, candidateCode: result.mergedCode,
        protectedMethods: 'all', python });
    assert.equal(preservation.valid, true, preservation.reason);
});

test('a full single method fence is transport markup, not a missing unittest import', async () => {
    const code = 'def test_added(self):\n    self.assertEqual(target(2), 3)';
    const result = await mergeWriterTestAddition({ baseline, addition: `\`\`\`python\n${code}\n\`\`\``, python });
    assert.ok(result.ok);
    assert.equal(result.addedMethodsCount, 1);
    assert.equal(extractWriterAdditionCode(JSON.stringify({ code: `\`\`\`py\n${code}\n\`\`\`` })), code);
    assert.equal(extractWriterAdditionCode(`\`\`\`json\n${JSON.stringify({ code })}\n\`\`\``), code);
    assert.equal(extractWriterAdditionCode(`[PYTHON]\n${code}\n[/PYTHON]`), code);
});

test('ambiguous multiple fences and prose are never shortened to an executable prefix', async () => {
    const code = 'def test_added(self): self.assertEqual(target(2), 3)';
    for (const addition of [`\`\`\`python\n${code}\n\`\`\`\n\`\`\`python\n${code}\n\`\`\``,
        `Explanation\n\`\`\`python\n${code}\n\`\`\``]) {
        const result = await mergeWriterTestAddition({ baseline, addition, python });
        assert.deepEqual(result, { ok: false, reasonCode: 'invalid-python-structure' });
        assert.equal('mergedCode' in result, false);
    }
});

test('a complete compatible file is accepted without duplicating existing tests', async () => {
    const result = await mergeWriterTestAddition({ baseline, addition: baseline + '    def test_added(self): self.assertEqual(target(2), 3)\n', python });
    assert.ok(result.ok);
    assert.equal(result.addedMethodsCount, 1);
    assert.equal((result.mergedCode.match(/def test_passed\(/g) || []).length, 1);
    assert.equal((result.mergedCode.match(/class Cases\(/g) || []).length, 1);
});

test('a changed same-named passing method is a typed rejection with no candidate output', async () => {
    const result = await mergeWriterTestAddition({ baseline,
        addition: 'def test_passed(self): self.assertEqual(target(self.value), 999)\n', python });
    assert.deepEqual(result, { ok: false, reasonCode: 'existing-test-method-changed' });
    assert.equal('mergedCode' in result, false);
});

test('a revised new method is merged against the original baseline, never accumulated with its failed draft', async () => {
    const first = await mergeWriterTestAddition({ baseline, addition: 'def test_added(self): self.assertEqual(target(2), 999)\n', python });
    const replacement = await mergeWriterTestAddition({ baseline, addition: 'def test_added(self): self.assertEqual(target(2), 3)\n', python });
    assert.ok(first.ok && replacement.ok);
    assert.equal(replacement.addedMethodsCount, 1);
    assert.doesNotMatch(replacement.mergedCode, /999/);
    assert.ok(replacement.mergedCode.startsWith(baseline));
});

test('new class imports cannot change the target binding', async () => {
    const result = await mergeWriterTestAddition({ baseline, addition: 'from unrelated import target\n'
        + 'class Added(unittest.TestCase):\n    def test_added(self): self.assertEqual(target(2), 3)\n', python });
    assert.deepEqual(result, { ok: false, reasonCode: 'import-binding-conflict' });
});

test('Unicode method identities survive the UTF-8 tool protocol and no-op baseline stays unchanged', async () => {
    const result = await mergeWriterTestAddition({ baseline, addition: 'def test_邊界(self): self.assertEqual(target(2), 3)\n', python });
    assert.ok(result.ok);
    assert.deepEqual(result.addedMethods, [{ className: 'Cases', name: 'test_邊界' }]);
    const unchanged = await mergeWriterTestAddition({ baseline, addition: baseline, python });
    assert.ok(unchanged.ok);
    assert.equal(unchanged.addedMethodsCount, 0);
    assert.equal(unchanged.mergedCode, baseline);
});

test('invalid Python and an unresolved multi-class attachment produce no partial candidate', async () => {
    const invalid = await mergeWriterTestAddition({ baseline, addition: 'def test_added(self): invalid python !\n', python });
    assert.deepEqual(invalid, { ok: false, reasonCode: 'invalid-python-structure' });
    const ambiguous = await mergeWriterTestAddition({ baseline: baseline + 'class Other(unittest.TestCase):\n    def test_other(self): pass\n',
        addition: 'def test_added(self): pass\n', python });
    assert.deepEqual(ambiguous, { ok: false, reasonCode: 'ambiguous-addition-target' });
});
