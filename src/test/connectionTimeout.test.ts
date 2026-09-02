import * as assert from 'assert';
import { test } from 'node:test';
import { CONNECTION_DISCOVERY_TIMEOUT_MS, MODEL_QUALIFICATION_TIMEOUT_MS, fetchWithTimeout } from '../connectionTimeout';

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
});
