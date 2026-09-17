import * as assert from 'assert';
import { test } from 'node:test';
import { buildGoogleGenerateContentRequest, buildGoogleListModelsRequest, getGenerateContentModelNames, getGoogleGeneratedText, getGoogleModelConnectionMetadata, GoogleThinkingSession, normalizeGoogleModelName, resolveGoogleApiKey } from '../llm/cloudApi';

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

test('buildGoogleGenerateContentRequest supports responseSchema without responseMimeType', () => {
    const request = buildGoogleGenerateContentRequest('gemini-test', 'test-key', 'hello', {
        responseSchema: { type: 'object' }
    });

    assert.deepStrictEqual(request.body.generationConfig, {
        responseSchema: { type: 'object' }
    });
});

test('buildGoogleGenerateContentRequest supports a deterministic connection-probe temperature', () => {
    const request = buildGoogleGenerateContentRequest('gemma-4-31b-it', 'test-key', 'probe', { temperature: 0 });

    assert.deepStrictEqual(request.body.generationConfig, { temperature: 0 });
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

test('uses advertised Cloud token limits and labels name-derived parameter sizes', () => {
    const metadata = getGoogleModelConnectionMetadata([
        { name: 'models/gemma-4-31b-it', displayName: 'Gemma 4 31B IT', inputTokenLimit: 131072 }
    ], 'gemma-4-31b-it');

    assert.deepStrictEqual(metadata, {
        paramSize: '31B（依模型名稱推定）',
        contextLength: 131072,
        contextLengthKnown: true,
    });
});

test('uses a conservative budget when Cloud metadata omits an input limit', () => {
    const metadata = getGoogleModelConnectionMetadata([
        { name: 'models/gemini-unknown', supportedGenerationMethods: ['generateContent'] }
    ], 'gemini-unknown');

    assert.strictEqual(metadata.paramSize, 'Cloud API 未提供');
    assert.strictEqual(metadata.contextLength, 4096);
    assert.strictEqual(metadata.contextLengthKnown, false);
});

test('extracts a Cloud generated text response without trusting malformed payloads', () => {
    assert.strictEqual(getGoogleGeneratedText({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial but valid looking code' }] } }] }), undefined);
    assert.strictEqual(getGoogleGeneratedText({ candidates: [{ content: { parts: [
        { thought: true, text: 'private reasoning is not an answer' }, { text: 'final answer' }
    ] } }] }), 'final answer');
    assert.strictEqual(
        getGoogleGeneratedText({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
        '{"ok":true}'
    );
    assert.strictEqual(getGoogleGeneratedText({ candidates: [] }), undefined);
    assert.strictEqual(getGoogleGeneratedText({ candidates: [{ content: { parts: [{}] } }] }), undefined);
    assert.strictEqual(
        getGoogleGeneratedText({ candidates: [{ content: { parts: [{ text: '{"code":' }, { text: '"complete"}' }, { inlineData: {} }] } }] }),
        '{"code":"complete"}'
    );
});

test('minimal thinking uses a capability response, shares cancellation and remembers unsupported endpoints', async () => {
    const session = new GoogleThinkingSession();
    const request = buildGoogleGenerateContentRequest('arbitrary-model', 'test-key', 'hello', { thinkingMode: 'minimal' });
    assert.deepStrictEqual(request.body.generationConfig, { thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    let sends = 0;
    let fallbacks = 0;
    const send = async (next: typeof request) => {
        sends++;
        if (sends === 1) { return new Response(JSON.stringify({ error: { message: 'Thinking level MINIMAL is not supported for this endpoint.' } }), { status: 400 }); }
        assert.strictEqual(next.body.generationConfig?.thinkingConfig, undefined);
        assert.strictEqual(next.headers, request.headers);
        return new Response('{}');
    };
    await session.send(request, send, () => { fallbacks++; });
    await session.send(request, send);
    assert.strictEqual(sends, 3);
    assert.strictEqual(fallbacks, 1);
    assert.ok(request.body.generationConfig?.thinkingConfig, 'caller request is not mutated');

    for (const status of [400, 401, 403, 404, 429, 500]) {
        let calls = 0;
        await new GoogleThinkingSession().send(request, async () => {
            calls++;
            return new Response(JSON.stringify({ error: { message: status === 400 ? 'invalid schema' : 'thinking level is not supported' } }), { status });
        });
        assert.strictEqual(calls, 1, 'unrelated or service errors are not thinking fallback');
    }
    const controller = new AbortController();
    await assert.rejects(new GoogleThinkingSession().send(request, async () => {
        controller.signal.throwIfAborted();
        controller.abort();
        return new Response(JSON.stringify({ error: { message: 'unknown field thinkingConfig' } }), { status: 400 });
    }), /abort/i);
});
