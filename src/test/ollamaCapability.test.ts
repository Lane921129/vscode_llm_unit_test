import * as assert from 'assert';
import { test } from 'node:test';
import { assessStructuredOutputProbe, assessTestGenerationProbe, buildOllamaStructuredProbe, buildOllamaTestGenerationProbe } from '../ollamaCapability';

test('Ollama structured probe is small, deterministic, and domain neutral', () => {
    const request = buildOllamaStructuredProbe('local-model');

    assert.deepStrictEqual(request, {
        model: 'local-model',
        prompt: 'Return exactly one JSON object with a boolean field named "ok" set to true. Do not include any other text.',
        stream: false,
        format: 'json',
        options: { temperature: 0 }
    });
});

test('Ollama structured probe accepts the expected JSON object only', () => {
    assert.deepStrictEqual(
        assessStructuredOutputProbe({ response: '{"ok":true}' }),
        { capability: 'verified', reason: '模型已通過結構化 JSON 輸出驗證。' }
    );
    assert.strictEqual(assessStructuredOutputProbe({ response: '{}' }).capability, 'unverified');
    assert.strictEqual(assessStructuredOutputProbe({ response: '{' }).capability, 'unverified');
    assert.strictEqual(assessStructuredOutputProbe({ response: '' }).capability, 'unverified');
});

test('test-generation probe requires a complete unittest structure, not merely JSON', () => {
    const request = buildOllamaTestGenerationProbe('local-model');
    assert.strictEqual(request.format, 'json');
    assert.ok(request.prompt.includes('def increment(value): return value + 1'));
    assert.strictEqual(assessTestGenerationProbe({ response: '{"code":"string"}' }).capability, 'unverified');
    assert.strictEqual(
        assessTestGenerationProbe({
            response: JSON.stringify({
                code: [
                    'import unittest',
                    '',
                    'def increment(value):',
                    '    return value + 1',
                    '',
                    'class TestIncrement(unittest.TestCase):',
                    '    def test_increment(self):',
                    '        self.assertEqual(increment(1), 2)',
                    ''
                ].join('\n')
            })
        }).capability,
        'verified'
    );
    assert.strictEqual(
        assessTestGenerationProbe({
            response: JSON.stringify({
                code: 'import unittest\n\nclass TestIncrement(unittest.TestCase):\n    def test_increment(self):\n        self.assertEqual(2, 2)\n'
            })
        }).capability,
        'unverified'
    );
});
