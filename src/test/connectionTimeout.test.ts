import * as assert from 'assert';
import { test } from 'node:test';
import { CONNECTION_DISCOVERY_TIMEOUT_MS, deadlineAtFromTimeoutSeconds, MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS, MODEL_QUALIFICATION_TIMEOUT_MS, fetchWithServerRetry, fetchWithTimeout, remainingDeadlineMs, retryTransientProviderRequest } from '../llm/connectionTimeout';

test('uses a fresh active AbortSignal for an individual provider request', async () => {
    let seenSignal: AbortSignal | undefined;
    const result = await fetchWithTimeout(
        async (_input, init) => {
            seenSignal = init.signal as AbortSignal;
            return 'ok';
        },
        'https://provider.test/models',
        { method: 'GET' },
        100
    );

    assert.strictEqual(result, 'ok');
    assert.ok(seenSignal);
    assert.strictEqual(seenSignal?.aborted, false);
});

test('aborts an individual request only after its own deadline', async () => {
    await assert.rejects(
        fetchWithTimeout(
            async (_input, init) => new Promise<string>((_resolve, reject) => {
                (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('timed out')));
            }),
            'https://provider.test/generate',
            { method: 'POST' },
            5
        ),
        /timed out/
    );
    assert.ok(MODEL_QUALIFICATION_TIMEOUT_MS > CONNECTION_DISCOVERY_TIMEOUT_MS);
    assert.ok(MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS >= 30_000);
});

test('retries a transient provider error once before accepting the probe response', async () => {
    let attempts = 0;
    const response = await fetchWithServerRetry(
        async () => ({ status: ++attempts === 1 ? 500 : 200 }),
        'https://provider.test/generate',
        { method: 'POST' },
        100,
        2,
        async () => undefined
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(attempts, 2);
});

test('does not retry authentication or malformed-request responses', async () => {
    let attempts = 0;
    const response = await fetchWithServerRetry(
        async () => ({ status: (++attempts, 400) }),
        'https://provider.test/generate',
        { method: 'POST' },
        100,
        2,
        async () => undefined
    );

    assert.strictEqual(response.status, 400);
    assert.strictEqual(attempts, 1);
});

test('uses bounded exponential jitter for transient generation responses', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const retries: string[] = [];
    const response = await retryTransientProviderRequest(
        async () => ({ status: ++attempts < 3 ? 503 : 200 }),
        {
            maxAttempts: 3,
            random: () => 0,
            wait: async milliseconds => { delays.push(milliseconds); },
            onRetry: event => { retries.push(`${event.reason}:${event.retryAttempt}/${event.maxAttempts}`); }
        }
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(delays, [375, 750]);
    assert.deepStrictEqual(retries, ['HTTP 503:2/3', 'HTTP 503:3/3']);
});

test('does not launch another provider retry after the shared deadline expires during backoff', async () => {
    let attempts = 0;
    let expired = false;
    await assert.rejects(
        retryTransientProviderRequest(
            async () => ({ status: (++attempts, 503) }),
            {
                maxAttempts: 3,
                isCancelled: () => expired,
                wait: async () => { expired = true; }
            }
        ),
        /deadline/
    );
    assert.strictEqual(attempts, 1);
});

test('keeps one absolute deadline when a request changes output format', () => {
    const deadline = deadlineAtFromTimeoutSeconds(30, 1_000);
    assert.strictEqual(deadline, 31_000);
    assert.strictEqual(remainingDeadlineMs(deadline, 1_500), 29_500);
    assert.strictEqual(remainingDeadlineMs(deadline, 31_001), 0);
});

test('retries a transient transport failure but not a cancelled request', async () => {
    let attempts = 0;
    const recovered = await retryTransientProviderRequest(
        async () => {
            attempts++;
            if (attempts === 1) { throw new Error('connection reset'); }
            return { status: 200 };
        },
        { random: () => 0, wait: async () => undefined }
    );
    assert.strictEqual(recovered.status, 200);
    assert.strictEqual(attempts, 2);

    attempts = 0;
    await assert.rejects(
        retryTransientProviderRequest(
            async () => { attempts++; throw new Error('aborted'); },
            { isCancelled: () => true, wait: async () => undefined }
        ),
        /aborted/
    );
    assert.strictEqual(attempts, 1);
});
