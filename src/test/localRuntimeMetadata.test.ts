import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLocalRuntimeMetadata } from '../llm/localRuntimeMetadata';
import { qualificationEndpointKey, QUALIFICATION_VERSION } from '../llm/modelQualification';
import { StoredModelProfile } from '../llm/modelProfileRegistry';
import { resolveLocalRuntimeContext } from '../prompts/promptBudget';

const baseUrl = 'http://metadata-fixture:11434';
const modelName = 'neutral-fixture';
const metadata = { details: { parameter_size: '13B' }, model_info:
    { 'general.architecture': 'neutral', 'neutral.context_length': 16384 } };
const cached: StoredModelProfile = { envType: 'local', modelName, endpointKey: qualificationEndpointKey('local', baseUrl),
    paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
    qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
    roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
        reviewer: { state: 'unverified', reason: 'fixed fixture' }, bugFixer: { state: 'unverified', reason: 'fixed fixture' } } };
const discover = (show: () => Promise<Response> | Response, options: Partial<Parameters<typeof readLocalRuntimeMetadata>[0]> = {}) =>
    readLocalRuntimeMetadata({ baseUrl, modelName, ...options, fetcher: async url => url.endsWith('/api/show')
        ? show() : Response.json({ models: [{ name: modelName + ':latest', context_length: 8192 }] }) });

test('fresh Ollama metadata is bound to one model and separated from allocation and role qualification', async () => {
    const result = await discover(() => Response.json(metadata), { cachedProfile: cached });
    assert.equal(result.metadata.contextLength, 16384);
    assert.equal(result.metadata.contextLengthKnown, true);
    assert.deepEqual(result.allocation, { effectiveRuntimeContextTokens: 8192, runtimeContextSource: 'ollama-ps' });
    assert.equal(result.diagnostic.status, 'fresh');
    assert.equal(result.diagnostic.source, 'ollama-show');
    assert.equal(result.diagnostic.endpointKey, cached.endpointKey);
    assert.equal('roleQualification' in result.metadata, false);
    assert.equal('testGenerationReady' in result.metadata, false);
    assert.equal(cached.roleQualification!.reviewer.state, 'unverified');
});

test('metadata failure retains only a valid same-model cached upper bound with explicit cached provenance', async () => {
    const result = await discover(() => new Response('PRIVATE_RESPONSE_MUST_NOT_LEAVE_DISCOVERY', { status: 500 }), { cachedProfile: cached });
    assert.equal(result.metadata.contextLengthKnown, true);
    assert.equal(result.metadata.contextLength, 16384);
    assert.equal(result.diagnostic.status, 'cached');
    assert.deepEqual(result.diagnostic.show, { reasonCode: 'http-error', httpStatus: 500, elapsedMs: result.diagnostic.show.elapsedMs });
    assert.ok(!JSON.stringify(result).includes('PRIVATE_RESPONSE'));
    assert.equal(result.diagnostic.source, 'stored-model-profile');
});

test('metadata reuse rejects other endpoints, other models and malformed cached limits', async () => {
    for (const profile of [{ ...cached, modelName: 'other-model' }, { ...cached, endpointKey: qualificationEndpointKey('local', 'http://other') },
        { ...cached, contextLength: -1 }, { ...cached, contextLength: 16384.5 }, { ...cached, contextLengthKnown: false }]) {
        const result = await discover(() => new Response('', { status: 503 }), { cachedProfile: profile });
        assert.equal(result.metadata.contextLengthKnown, false);
        assert.equal(result.diagnostic.status, 'unavailable');
    }
});

test('successful HTTP with missing model metadata remains unavailable or explicitly cached', async () => {
    const unknown = await discover(() => Response.json({ model_info: {} }));
    assert.equal(unknown.diagnostic.show.reasonCode, 'missing-context-limit');
    assert.equal(unknown.diagnostic.status, 'unavailable');
    const retained = await discover(() => Response.json({ model_info: {} }), { cachedProfile: cached });
    assert.equal(retained.diagnostic.show.reasonCode, 'missing-context-limit');
    assert.equal(retained.diagnostic.status, 'cached');
});

test('malformed JSON and network failures use fixed safe diagnostics', async () => {
    const invalid = await discover(() => new Response('PRIVATE_BAD_JSON'));
    assert.equal(invalid.diagnostic.show.reasonCode, 'invalid-json');
    assert.ok(!JSON.stringify(invalid).includes('PRIVATE_BAD_JSON'));
    const network = await discover(() => { throw new Error('PRIVATE_NETWORK_TEXT'); });
    assert.equal(network.diagnostic.show.reasonCode, 'network-error');
    assert.ok(!JSON.stringify(network).includes('PRIVATE_NETWORK_TEXT'));
});

test('metadata timeout includes body parsing and cannot be renewed after headers', async () => {
    const result = await discover(() => ({ status: 200, ok: true, json: () => new Promise(() => {}) } as unknown as Response), { timeoutMs: 15 });
    assert.equal(result.diagnostic.show.reasonCode, 'timeout');
    assert.equal(result.metadata.contextLengthKnown, false);
});

test('cancelled discovery sends no requests and stops even a transport that ignores abort', async () => {
    const before = new AbortController(); before.abort();
    let requests = 0;
    const result = await readLocalRuntimeMetadata({ baseUrl, modelName, signal: before.signal,
        fetcher: async () => { requests++; return Response.json(metadata); } });
    assert.equal(requests, 0);
    assert.equal(result.diagnostic.show.reasonCode, 'cancelled');
    const during = new AbortController();
    const pending = readLocalRuntimeMetadata({ baseUrl, modelName, signal: during.signal,
        fetcher: async () => new Promise<Response>(() => {}) });
    during.abort();
    const stopped = await pending;
    assert.equal(stopped.diagnostic.show.reasonCode, 'cancelled');
    assert.equal(stopped.diagnostic.allocation.reasonCode, 'cancelled');
});

test('fresh upper bound keeps manual choices and validates a newly lower model limit', async () => {
    const fresh = await discover(() => Response.json(metadata), { cachedProfile: cached });
    assert.equal(resolveLocalRuntimeContext({ ...fresh.metadata, runtimeContextTokens: 12288 }).ok, true);
    const lowered = await discover(() => Response.json({ model_info: { 'neutral.context_length': 4096 } }), { cachedProfile: cached });
    assert.equal(lowered.metadata.contextLength, 4096);
    assert.deepEqual(resolveLocalRuntimeContext({ ...lowered.metadata, runtimeContextTokens: 8192 }),
        { ok: false, reasonCode: 'runtime-context-exceeds-model-limit' });
});
