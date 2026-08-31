import * as assert from 'assert';
import { test } from 'node:test';
import { buildGoogleGenerateContentRequest, buildGoogleListModelsRequest, getGenerateContentModelNames, getGoogleGeneratedText, normalizeGoogleModelName, resolveGoogleApiKey } from '../cloudApi';

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

test('normalizes resource-style model names and lists models without placing the key in a URL', () => {
    const request = buildGoogleGenerateContentRequest(' models/example-model ', 'test-key', 'hello');
    const listRequest = buildGoogleListModelsRequest('test-key', 'next page');

    assert.strictEqual(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/example-model:generateContent');
    assert.strictEqual(listRequest.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageToken=next%20page');
    assert.ok(!listRequest.url.includes('test-key'));
    assert.strictEqual(normalizeGoogleModelName('models/example-model'), 'example-model');
});

test('keeps only Cloud models that declare generateContent support', () => {
    const supported = getGenerateContentModelNames([
        { name: 'models/text-model', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embed-model', supportedActions: ['embedContent'] },
        { name: 'models/action-model', supportedActions: ['generateContent'] },
    ]);

    assert.deepStrictEqual(supported, ['text-model', 'action-model']);
});

test('extracts a Cloud generated text response without trusting malformed payloads', () => {
    assert.strictEqual(
        getGoogleGeneratedText({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
        '{"ok":true}'
    );
    assert.strictEqual(getGoogleGeneratedText({ candidates: [] }), undefined);
    assert.strictEqual(getGoogleGeneratedText({ candidates: [{ content: { parts: [{}] } }] }), undefined);
});
