import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { validateTraceEvidence, TraceAssertionEvidence } from '../validation/traceAssertionEvidence';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
const trace = { examples: [{ args: ["'value'", '2'], result: "{'ok': True}" }] };
const check = (statement: string, target = 'target', evidence: TraceAssertionEvidence = trace) =>
    validateTraceEvidence(`import unittest
import sample as module
from sample import ${target}
class Cases(unittest.TestCase):
    def test_case(self):
        ${statement}
`, target, evidence, 'sample', python);

test('rejects a literal assertion contradicting the same verified Trace call', async () => {
    const result = await check("self.assertEqual(target('value', 2), {'ok': False})");
    assert.equal(result.valid, false);
    assert.match(result.reason!, /實測.*True/);
});

test('accepts the exact Trace value and leaves untraced inputs to execution', async () => {
    assert.equal((await check("self.assertEqual(target('value', 2), {'ok': True})")).valid, true);
    assert.equal((await check("self.assertEqual(target('other', 2), {'ok': False})")).valid, true);
});

test('resolves module aliases and does not treat setup without an assertion as a contradiction', async () => {
    assert.equal((await check("self.assertEqual(module.target('value', 2), {'ok': False})")).valid, false);
    assert.equal((await check("result = target('value', 2)")).valid, true);
});

test('checks boolean and None assertions against matching real Trace literals', async () => {
    assert.equal((await check('self.assertFalse(check(1))', 'check', { examples: [{ args: ['1'], result: 'True' }] })).valid, false);
    assert.equal((await check("self.assertIsNone(fetch('x'))", 'fetch', { examples: [{ args: ["'x'"], result: 'None' }] })).valid, true);
});

test('uses Python truthiness for known safe literals instead of conflating truthiness with equality', async () => {
    const evidence = { examples: [{ args: ["'x'"], result: 'None' }] };
    assert.equal((await check("self.assertFalse(fetch('x'))", 'fetch', evidence)).valid, true);
    assert.equal((await check("self.assertTrue(fetch('x'))", 'fetch', evidence)).valid, false);
});

test('checks reversed equality arguments and ignores optional assertion messages', async () => {
    assert.equal((await check("self.assertEqual({'ok': False}, target('value', 2), 'detail')")).valid, false);
    assert.equal((await check("self.assertEqual(target('value', 2), {'ok': True}, 'detail')")).valid, true);
});

test('unsafe or non-assertable Trace values are not used as literal oracles', async () => {
    assert.equal((await check('self.assertEqual(target(), 99)', 'target', { examples: [{ args: [], result: 'object()', result_assertable: false }] })).valid, true);
    assert.equal((await check('self.assertEqual(target(), 99)', 'target', { examples: [{ args: [], result: 'object()' }] })).valid, true);
});
