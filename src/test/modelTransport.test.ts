import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    fetchModelResponse,
    getNativeGlobalDispatcher,
    getSafeTransportFailureCode,
    isSafeTransportFailureCode,
    ModelTransportDispatcher,
    ModelTransportDispatchOptions,
} from '../llm/modelTransport';

test('transport diagnostics retain only allowlisted nested failure codes', () => {
    const error = new TypeError('fetch failed: private-url', { cause: {
        code: 'UND_ERR_HEADERS_TIMEOUT', message: 'private provider response', address: 'private-host',
    } });
    assert.equal(getSafeTransportFailureCode(error), 'UND_ERR_HEADERS_TIMEOUT');
    assert.equal(getSafeTransportFailureCode({ code: 'ECONNRESET' }), 'ECONNRESET');
    assert.equal(getSafeTransportFailureCode({ code: 'PRIVATE_TOKEN_VALUE', message: 'ETIMEDOUT' }), undefined);
    assert.equal(getSafeTransportFailureCode(new Error('UND_ERR_HEADERS_TIMEOUT')), undefined);
    assert.equal(isSafeTransportFailureCode('UND_ERR_HEADERS_TIMEOUT\nsecret'), false);
    assert.equal(isSafeTransportFailureCode(300), false);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    assert.equal(getSafeTransportFailureCode(cyclic), undefined);
    assert.equal(getSafeTransportFailureCode({ get code() { throw new Error('private'); } }), undefined);
});

test('model transport preserves the current host fetch replacement and caller signal', async () => {
    const priorFetch = globalThis.fetch;
    const priorDispatcher = getNativeGlobalDispatcher();
    const controller = new AbortController();
    const response = new Response('fixture');
    let calls = 0;
    globalThis.fetch = async (input, init) => {
        calls++;
        assert.equal(input, 'https://fixture.invalid/generate');
        assert.equal(init?.signal, controller.signal);
        assert.equal(init?.body, 'exact public fixture');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
        return response;
    };
    try {
        assert.equal(await fetchModelResponse('https://fixture.invalid/generate', {
            method: 'POST', body: 'exact public fixture', headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
        }, { deadlineAt: Date.now() + 600_000 }), response);
        assert.equal(calls, 1);
        assert.equal(getNativeGlobalDispatcher(), priorDispatcher);
    } finally { globalThis.fetch = priorFetch; }
});

test('transport dispatch overrides native 300-second defaults without replacing the delegated policy', async () => {
    let dispatchCount = 0;
    const priorDispatcher = getNativeGlobalDispatcher();
    const deadlineAt = Date.now() + 900_000;
    const delegate: ModelTransportDispatcher = {
        dispatch(options: ModelTransportDispatchOptions): boolean {
            dispatchCount++;
            assert.equal(options.origin, 'https://fixture.invalid');
            assert.equal(options.path, '/generate');
            assert.ok(options.headersTimeout! > 890_000 && options.headersTimeout! <= 900_000);
            assert.equal(options.bodyTimeout, options.headersTimeout);
            return true;
        },
    };
    await fetchModelResponse('https://fixture.invalid/generate', { signal: new AbortController().signal }, {
        deadlineAt, dispatcher: delegate,
        fetcher: async (_input, init) => {
            const dispatcher = (init as RequestInit & { dispatcher: ModelTransportDispatcher }).dispatcher;
            dispatcher.dispatch({ origin: 'https://fixture.invalid', path: '/generate', method: 'POST',
                headersTimeout: 300_000, bodyTimeout: 300_000 }, {});
            return new Response('fixture');
        },
    });
    assert.equal(dispatchCount, 1);
    assert.equal(getNativeGlobalDispatcher(), priorDispatcher);
});

test('expired or cancelled model transport does not dispatch another request', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return new Response('fixture'); };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchModelResponse('https://fixture.invalid', { signal: controller.signal }, {
        deadlineAt: Date.now() + 1000, fetcher,
    }), { name: 'AbortError' });
    await assert.rejects(fetchModelResponse('https://fixture.invalid', { signal: new AbortController().signal }, {
        deadlineAt: Date.now() - 1, fetcher,
    }), { name: 'AbortError' });
    assert.throws(() => fetchModelResponse('https://fixture.invalid', {}, { deadlineAt: Date.now() + 1000 }), TypeError);
    assert.throws(() => fetchModelResponse('https://fixture.invalid', { signal: controller.signal }, { deadlineAt: Infinity }), TypeError);
    assert.equal(calls, 0);
});
