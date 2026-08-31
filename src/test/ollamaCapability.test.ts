import * as assert from 'assert';
import { test } from 'node:test';
import { assessStructuredOutputProbe, buildOllamaStructuredProbe } from '../ollamaCapability';

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
