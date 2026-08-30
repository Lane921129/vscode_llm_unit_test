import * as assert from 'assert';
import { test } from 'node:test';
import { buildGoogleGenerateContentRequest, resolveGoogleApiKey } from '../cloudApi';

test('buildGoogleGenerateContentRequest uses the selected model and a key header', () => {
    const request = buildGoogleGenerateContentRequest('gemma-4-31b-it', 'test-key', 'hello');

    assert.strictEqual(
        request.url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent'
    );
    assert.strictEqual(request.headers['x-goog-api-key'], 'test-key');
    assert.ok(!request.url.includes('test-key'));
    assert.deepStrictEqual(request.body, { contents: [{ parts: [{ text: 'hello' }] }] });
});

test('resolveGoogleApiKey prioritizes the transient UI key over the environment', () => {
    const key = resolveGoogleApiKey(' ui-key ', { LLM_UNIT_TEST_GOOGLE_API_KEY: 'environment-key' });
    assert.strictEqual(key, 'ui-key');
});

test('resolveGoogleApiKey supports CI through an environment variable', () => {
    const key = resolveGoogleApiKey(undefined, { LLM_UNIT_TEST_GOOGLE_API_KEY: 'environment-key' });
    assert.strictEqual(key, 'environment-key');
});

test('buildGoogleGenerateContentRequest supports a JSON output contract without exposing the key', () => {
    const request = buildGoogleGenerateContentRequest('gemini-test', 'test-key', 'hello', {
        responseMimeType: 'application/json',
        responseSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }
    });

    assert.deepStrictEqual(request.body.generationConfig, {
        responseMimeType: 'application/json',
        responseSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }
    });
});
