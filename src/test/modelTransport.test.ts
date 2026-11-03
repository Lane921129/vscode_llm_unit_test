import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { channel } from 'node:diagnostics_channel';
import {
    fetchModelResponse,
    getSafeTransportFailureCode,
    isSafeTransportFailureCode,
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
    const controller = new AbortController();
    const response = new Response('fixture');
    let calls = 0;
    globalThis.fetch = async (input, init) => {
        calls++;
        assert.equal(input, 'https://fixture.invalid/generate');
        assert.equal(init?.signal?.aborted, false);
        assert.equal('dispatcher' in (init || {}), false);
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
    } finally { globalThis.fetch = priorFetch; }
});

test('transport adjusts the final host request without supplying or replacing its dispatcher', async () => {
    const deadlineAt = Date.now() + 900_000;
    const request = { headersTimeout: 300_000, bodyTimeout: 300_000 };
    await fetchModelResponse('https://fixture.invalid/generate', { signal: new AbortController().signal }, {
        deadlineAt,
        fetcher: async (_input, init) => {
            assert.equal('dispatcher' in (init || {}), false);
            await Promise.resolve(); // Host proxy/certificate resolution may await.
            channel('undici:request:create').publish({ request });
            return new Response('fixture');
        },
    });
    assert.ok(request.headersTimeout > 890_000 && request.headersTimeout <= 900_000);
    assert.equal(request.bodyTimeout, request.headersTimeout);
    const unrelated = { headersTimeout: 300_000, bodyTimeout: 300_000 };
    channel('undici:request:create').publish({ request: unrelated });
    assert.deepEqual(unrelated, { headersTimeout: 300_000, bodyTimeout: 300_000 });
});

test('unsupported request fields cancel only that fetch without throwing from the diagnostics subscriber', async () => {
    for (const request of [{}, Object.freeze({ headersTimeout: 300_000, bodyTimeout: 300_000 })]) {
        const controller = new AbortController();
        await assert.rejects(fetchModelResponse('https://fixture.invalid', { signal: controller.signal }, {
            deadlineAt: Date.now() + 1000,
            fetcher: async (_input, init) => {
                assert.doesNotThrow(() => channel('undici:request:create').publish({ request }));
                assert.equal(init?.signal?.aborted, true);
                assert.equal(controller.signal.aborted, false);
                return new Response('fixture');
            }
        }), { code: 'MODEL_TRANSPORT_TIMEOUT_UNSUPPORTED' });
    }
});

test('concurrent model waits retain independent deadlines and leave unrelated HTTP unchanged', async () => {
    const requests: { headersTimeout: number; bodyTimeout: number }[] = [];
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const fetcher: typeof fetch = async () => {
        await ready;
        const request = { headersTimeout: 300_000, bodyTimeout: 300_000 };
        channel('undici:request:create').publish({ request });
        requests.push(request);
        return new Response('fixture');
    };
    const first = fetchModelResponse('https://fixture.invalid', { signal: new AbortController().signal },
        { deadlineAt: Date.now() + 900_000, fetcher });
    const second = fetchModelResponse('https://fixture.invalid', { signal: new AbortController().signal },
        { deadlineAt: Date.now() + 600_000, fetcher });
    const other = { headersTimeout: 300_000, bodyTimeout: 300_000 };
    channel('undici:request:create').publish({ request: other });
    release();
    await Promise.all([first, second]);
    assert.ok(requests[0].headersTimeout > 890_000 && requests[0].headersTimeout <= 900_000);
    assert.ok(requests[1].headersTimeout > 590_000 && requests[1].headersTimeout <= 600_000);
    assert.deepEqual(other, { headersTimeout: 300_000, bodyTimeout: 300_000 });
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
