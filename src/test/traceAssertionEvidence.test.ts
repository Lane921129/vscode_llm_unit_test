import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { validateTraceEvidence, TraceAssertionEvidence } from '../validation/traceAssertionEvidence';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { parseBehaviorObservations } from '../pipeline/behaviorObservations';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';

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

test('real keyword-order observations remain distinct through Tier 1, guarded execution and the assertion gate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-keyword-order-'));
    const execute = (args: string[], input?: string) => {
        const result = spawnSync(python, ['-B', ...args], { cwd: directory, input, encoding: 'utf8', timeout: 20000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
    };
    try {
        const file = path.join(directory, 'neutral.py');
        fs.writeFileSync(file, 'def target(**kwargs):\n    return list(kwargs)\n');
        const observed = parseBehaviorObservations(execute([pythonToolPath('trace'), file, 'target', JSON.stringify([
            { args: [], kwargs: { a: 1, b: 2 } }, { args: [], kwargs: { b: 2, a: 1 } }
        ])]), 'target');
        assert.equal(observed.examples.length, 2);
        const generated = buildTier1TestFile({ moduleName: 'neutral', functionName: 'target',
            examples: observed.examples, errors: observed.errors });
        assert.equal(generated.methodCount, 2);
        const code = generated.code!;
        fs.writeFileSync(path.join(directory, 'candidate.py'), code);
        execute([pythonToolPath('testRunner'), 'candidate']);

        const gate = JSON.parse(execute([pythonToolPath('assertionEvidence')],
            JSON.stringify({ code, target: 'target', module: 'neutral', trace: observed })));
        assert.equal(gate.valid, true);
        assert.equal(gate.checked, 2, 'distinct keyword orders must not collapse into conflicting unknown facts');
        assert.equal((await validateTraceEvidence(code, 'target', observed, 'neutral', python)).valid, true);

        const wrong = code.replace("self.assertEqual(result, ['b', 'a'])", "self.assertEqual(result, ['a', 'b'])");
        assert.notEqual(wrong, code);
        assert.equal((await validateTraceEvidence(wrong, 'target', observed, 'neutral', python)).valid, false);

        // A different order without its own observation stays unknown rather
        // than being rejected against the observed order's expected value.
        const reverse = buildTier1TestFile({ moduleName: 'neutral', functionName: 'target',
            examples: [observed.examples[1]], errors: [] }).code!;
        assert.equal((await validateTraceEvidence(reverse, 'target', { examples: [observed.examples[0]] }, 'neutral', python)).valid, true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
