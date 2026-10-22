import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOllamaRoleQualificationProbe, requestOllamaQualification } from '../llm/ollamaCapability';
import { QualificationRequestError } from '../llm/connectionQualification';

const encode = (lines: unknown[]) => lines.map(line => JSON.stringify(line)).join('\n') + '\n';
const body = () => buildOllamaRoleQualificationProbe('neutral-probe', 'Return a fixed probe.', 'review-json', 8192);

test('qualification consumes complete streaming output with its original role schema and context', async () => {
    let calls = 0;
    const request = body();
    const payload = await requestOllamaQualification('http://127.0.0.1:11434///', request, 1000, async (url, init) => {
        calls++;
        assert.equal(url, 'http://127.0.0.1:11434/api/generate');
        const wire = JSON.parse(String(init.body));
        assert.equal(wire.stream, true);
        assert.deepEqual(wire.format, request.format);
        assert.deepEqual(wire.options, { temperature: 0, num_ctx: 8192, num_predict: 1024 });
        return new Response(encode([{ response: '{"findings":', done: false },
            { response: '[]}', done: true, done_reason: 'stop', eval_count: 8 }]),
        { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    assert.equal(calls, 1);
    assert.equal(payload?.response, '{"findings":[]}');
    assert.equal(payload?.done, true);
});

test('qualification keeps the deadline active after HTTP headers arrive', async () => {
    let headersReturned = false, aborted = false;
    await assert.rejects(requestOllamaQualification('http://127.0.0.1:11434', body(), 25, async (_url, init) => {
        const signal = init.signal!;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    controller.error(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            }
        });
        headersReturned = true;
        return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
    }), (error: unknown) => error instanceof QualificationRequestError && error.reasonCode === 'timeout');
    assert.equal(headersReturned, true);
    assert.equal(aborted, true);
});

test('qualification discards a partial streaming prefix and length-stopped complete envelope', async () => {
    for (const records of [
        [{ response: '{"findings":[]}', done: false }],
        [{ response: '{"findings":[]}', done: true, done_reason: 'length' }]
    ]) {
        await assert.rejects(requestOllamaQualification('http://127.0.0.1:11434', body(), 1000,
            async () => new Response(encode(records), { headers: { 'Content-Type': 'application/x-ndjson' } })),
        (error: unknown) => error instanceof QualificationRequestError
            && !JSON.stringify(error).includes('findings'));
    }
});

test('qualification preserves JSON-only compatibility and does not retry HTTP rejection', async () => {
    const payload = await requestOllamaQualification('http://127.0.0.1:11434', body(), 1000,
        async () => new Response(JSON.stringify({ response: '{"findings":[]}' }),
            { headers: { 'Content-Type': 'application/json' } }));
    assert.equal(payload?.response, '{"findings":[]}');
    let calls = 0;
    await assert.rejects(requestOllamaQualification('http://127.0.0.1:11434', body(), 1000, async () => {
        calls++;
        return new Response('private provider failure', { status: 503 });
    }), (error: unknown) => error instanceof QualificationRequestError && error.httpStatus === 503);
    assert.equal(calls, 1);
});

test('qualification rejects invalid timer allowances before issuing any request', async () => {
    let calls = 0;
    for (const timeout of [0, -1, Infinity, 2_147_483_648]) {
        await assert.rejects(requestOllamaQualification('http://127.0.0.1:11434', body(), timeout,
            async () => { calls++; return new Response(); }), TypeError);
    }
    assert.equal(calls, 0);
});
