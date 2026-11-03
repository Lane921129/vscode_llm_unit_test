import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJsonWithTimeout, JsonResponse, requestJsonWithTimeout, retryTransientProviderRequest } from '../llm/connectionTimeout';

const pending = <T>(): Promise<T> => new Promise(() => undefined);
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

test('a response deadline covers a pending JSON body even when it ignores abort and cancel never settles', async () => {
    let signal: AbortSignal | undefined, cancellations = 0;
    const start = Date.now();
    await assert.rejects(fetchJsonWithTimeout(async (_url, init) => {
        signal = init.signal as AbortSignal;
        return { status: 200, ok: true, json: () => pending<unknown>(),
            body: { cancel: () => { cancellations++; return pending(); } } };
    }, 'https://fixture.invalid', {}, 15), isAbort);
    assert.equal(signal?.aborted, true);
    assert.equal(cancellations, 1);
    assert.ok(Date.now() - start < 1_000, 'cleanup must not wait for the unresolved body');
});

test('a late response from an abort-ignoring transport is discarded without decoding it', async () => {
    let finish!: (response: JsonResponse) => void;
    let parsed = false, cancellations = 0;
    await assert.rejects(requestJsonWithTimeout(() => new Promise<JsonResponse>(resolve => { finish = resolve; }), 15), isAbort);
    finish({ ok: true, status: 200, json: async () => { parsed = true; return {}; },
        body: { cancel: async () => { cancellations++; } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(parsed, false);
    assert.equal(cancellations, 1);
});

test('pre-cancelled requests do not dispatch and external cancellation bounds an ignored body', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    let requests = 0;
    await assert.rejects(requestJsonWithTimeout(async () => {
        requests++; return Response.json({});
    }, 100, cancelled.signal), isAbort);
    assert.equal(requests, 0);

    const active = new AbortController();
    let signal: AbortSignal | undefined, ready!: () => void;
    const dispatched = new Promise<void>(resolve => { ready = resolve; });
    const result = fetchJsonWithTimeout(async (_url, init) => {
        signal = init.signal as AbortSignal; ready();
        return { ok: true, status: 200, json: () => pending<unknown>() };
    }, 'https://fixture.invalid', { signal: active.signal }, 1_000);
    await dispatched; active.abort();
    await assert.rejects(result, isAbort);
    assert.equal(signal?.aborted, true);
});

test('completed JSON preserves request options and removes its cancellation listener', async () => {
    const parent = new AbortController();
    let added = 0, removed = 0, seenSignal: AbortSignal | undefined;
    const add = parent.signal.addEventListener.bind(parent.signal);
    const remove = parent.signal.removeEventListener.bind(parent.signal);
    parent.signal.addEventListener = (...args: Parameters<typeof add>) => { added++; return add(...args); };
    parent.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removed++; return remove(...args); };
    const result = await fetchJsonWithTimeout(async (url, init) => {
        assert.equal(url, 'https://fixture.invalid');
        assert.equal(init.method, 'POST');
        assert.equal(init.body, '{}');
        assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
        seenSignal = init.signal as AbortSignal;
        assert.notEqual(seenSignal, parent.signal);
        return Response.json({ accepted: true });
    }, 'https://fixture.invalid', { method: 'POST', body: '{}', signal: parent.signal,
        headers: { 'Content-Type': 'application/json' } }, 100);
    assert.deepEqual(result.payload, { accepted: true });
    assert.equal(result.response.status, 200);
    assert.equal(added, removed);
    parent.abort();
    assert.equal(seenSignal?.aborted, false, 'settled requests must no longer observe parent cancellation');
});

test('HTTP failures do not read a private body or wait for its cancellation', async () => {
    let reads = 0, cancellations = 0;
    const result = await requestJsonWithTimeout(async () => ({ ok: false, status: 401,
        json: async () => { reads++; throw new Error('PRIVATE_PROVIDER_BODY'); },
        body: { cancel: () => { cancellations++; return pending(); } } }), 100);
    assert.equal(result.response.status, 401);
    assert.equal(result.payload, undefined);
    assert.equal(reads, 0);
    assert.equal(cancellations, 1);
});

test('body parser errors cannot put provider text in the resulting diagnostic', async () => {
    let cancellations = 0;
    await assert.rejects(requestJsonWithTimeout(async () => ({ ok: true, status: 200,
        json: async () => { throw new SyntaxError('PRIVATE_PROVIDER_BODY'); },
        body: { cancel: async () => { cancellations++; } } }), 100), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Provider returned an invalid JSON response.');
        assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_BODY/);
        return true;
    });
    assert.equal(cancellations, 1);
});

test('absolute response deadlines reject late JSON before an overdue timer is serviced', async () => {
    const originalNow = Date.now;
    let now = originalNow(), cancellations = 0;
    Date.now = () => now;
    try {
        await assert.rejects(requestJsonWithTimeout(async () => ({ ok: true, status: 200,
            json: async () => { now += 101; return { late: true }; },
            body: { cancel: async () => { cancellations++; } } }), 100), isAbort);
        assert.equal(cancellations, 1);
    } finally { Date.now = originalNow; }
});

test('invalid response allowances fail before transport dispatch', async () => {
    let requests = 0;
    for (const allowance of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
        await assert.rejects(requestJsonWithTimeout(async () => {
            requests++; return Response.json({});
        }, allowance), TypeError);
    }
    assert.equal(requests, 0);
});

test('a transient retry discards only its superseded body without awaiting broken cleanup', async () => {
    let attempts = 0, discarded = 0, accepted = 0;
    const response = await retryTransientProviderRequest(async () => ++attempts === 1
        ? { status: 500, body: { cancel: () => { discarded++; return pending(); } } }
        : { status: 200, body: { cancel: async () => { accepted++; } } },
    { maxAttempts: 2, wait: async () => undefined });
    assert.equal(attempts, 2);
    assert.equal(discarded, 1);
    assert.equal(accepted, 0);
    assert.equal(response.status, 200);
});

test('non-retryable and final failed responses remain owned by the caller', async () => {
    for (const status of [400, 401, 404, 429, 500]) {
        let attempts = 0, cancellations = 0;
        const response = await retryTransientProviderRequest(async () => ({ status: (++attempts, status),
            body: { cancel: async () => { cancellations++; } } }), { maxAttempts: 1 });
        assert.equal(response.status, status);
        assert.equal(attempts, 1);
        assert.equal(cancellations, 0);
    }
});
