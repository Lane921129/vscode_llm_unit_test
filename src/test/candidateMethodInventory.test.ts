import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { readCandidateMethodInventory } from '../pipeline/candidateMethodInventory';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { runSpawn } from '../utils/processRunner';
import { pythonToolPath } from '../pipeline/pythonTools';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const code = 'raise RuntimeError("must not execute")\nimport unittest\nclass Cases(unittest.TestCase):\n'
    + '    def test_中文(self):\n        self.assertEqual(1, 1)\n';

test('native inventory parses UTF-8 without executing code and preserves the legacy reader contract', async () => {
    const result = await readCandidateMethodInventory({ code, python });
    assert.equal(result.status, 'parsed');
    if (result.status !== 'parsed') { throw Error('Expected parsed method metadata'); }
    assert.equal(result.methods[0].id, 'Cases.test_中文');
    const legacy = await runSpawn(python, ['-B', pythonToolPath('scenarios')], {
        input: code, timeout: 5000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.deepEqual(JSON.parse(legacy.stdout), result.methods);
});

test('candidate syntax errors carry positions without copying arbitrary source lines or exception text', async () => {
    const bad = 'Explanation before Python: private_customer_record_123\n```python\n' + code;
    const result = await readCandidateMethodInventory({ code: bad, python });
    assert.equal(result.status, 'syntax-error');
    assert.match(JSON.stringify(result), /SyntaxError/);
    assert.doesNotMatch(JSON.stringify(result), /private_customer|must not execute|Explanation|```/);
    if (result.status === 'syntax-error') { assert.equal(result.syntax.line, 1); }
    const empty = await readCandidateMethodInventory({ code: 'import unittest\n', python });
    assert.deepEqual(empty, { status: 'parsed', methods: [] });
});

test('an inventory process failure is a typed tool failure and never a model syntax verdict', async () => {
    await assert.rejects(readCandidateMethodInventory({ code, python: process.execPath }), (error: unknown) => {
        assert.ok(error instanceof AnalysisStageError);
        assert.equal(error.stage, 'candidate-inventory-tool');
        assert.equal(error.category, 'validation');
        assert.deepEqual(error.diagnostic, { reasonCode: 'inventory-process-failed' });
        assert.doesNotMatch(error.message, /test_中文|must not execute|bad option/);
        return true;
    });
});
