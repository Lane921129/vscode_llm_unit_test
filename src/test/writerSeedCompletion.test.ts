import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { writerSeedCompletionPrompt, assembleWriterSeedCompletion } from '../llm/writerSeedCompletion';
import { writerSeedCodePrefix } from '../pipeline/targetContract';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { getCompletedOllamaText } from '../llm/ollamaResponse';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

test('completion comments carry every evidence byte and expose only a body-free canonical wrapper', () => {
    const system = 'WRITER_SEED_V1 OUTPUT SCOPE\nComplete safety contract';
    const evidence = 'SOURCE\r\ndef target(value):\n    return value + 1\n\nOBSERVED:\nunknown stays unknown';
    for (const is_async of [false, true]) {
        const prefix = writerSeedCodePrefix('sample', 'Owner.target', { class_name: 'Owner', is_async });
        const prompt = writerSeedCompletionPrompt(system, evidence, prefix);
        const lines = prompt.split('\n').slice(0, (system + '\n' + evidence).split('\n').length);
        assert.equal(lines.map(line => line.slice(2)).join('\n'), system + '\n' + evidence);
        assert.ok(prompt.endsWith(prefix));
        assert.doesNotMatch(prefix, /self\.assert|Owner\(|return_value|pass/);
        assert.equal(validateUnittestStructure(prefix, 'Owner.target', 'sample').valid, false);
    }
    assert.equal(writerSeedCodePrefix('bad\nimport arbitrary', 'target', { is_async: false }), '');
    assert.equal(writerSeedCodePrefix('sample', 'target', {}), '');
});

test('completed continuations retain model bytes and undergo the original structure gate', () => {
    const prefix = writerSeedCodePrefix('sample', 'target', { is_async: false });
    const tail = '        self.assertEqual(target(1), 2)\n';
    const code = assembleWriterSeedCompletion(prefix, tail);
    assert.equal(code, prefix + tail);
    assert.equal(validateUnittestStructure(code, 'target', 'sample').valid, true);
    assert.equal(validateUnittestStructure(assembleWriterSeedCompletion(prefix, ''), 'target', 'sample').valid, false);
    const unindented = 'self.assertEqual(target(1), 2)\n';
    assert.equal(assembleWriterSeedCompletion(prefix, unindented), prefix + unindented);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    assert.throws(() => execFileSync(python, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'],
        { input: assembleWriterSeedCompletion(prefix, unindented), stdio: ['pipe', 'pipe', 'pipe'] }),
        'the AST gate rejects missing indentation; transport never repairs model bytes');
    const full = '```python\n' + code + '```';
    assert.equal(assembleWriterSeedCompletion(prefix, full), full, 'a complete fenced reply is not duplicated');
    assert.throws(() => getCompletedOllamaText({ response: tail, done: true, done_reason: 'length' }, 4096),
        'a plausible tail is never assembled from a length-stopped response');
    for (const payload of [{ response: tail }, { response: tail, done: false, done_reason: 'stop' },
        { response: tail, done: true, done_reason: 'unknown' }]) {
        assert.throws(() => getCompletedOllamaText(payload, 4096, undefined, true));
    }
    assert.equal(getCompletedOllamaText({ response: tail, done: true, done_reason: 'stop' }, 4096, undefined, true), tail);
    assert.equal(getCompletedOllamaText({ response: tail }), tail, 'ordinary legacy responses keep their existing compatibility');
});
