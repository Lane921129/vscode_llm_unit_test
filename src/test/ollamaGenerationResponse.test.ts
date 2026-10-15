import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { OLLAMA_GENERATION_RESPONSE_LIMITS as limits, OllamaResponseProgress,
    readOllamaGenerationResponse } from '../llm/ollamaGenerationResponse';
import { getCompletedOllamaText } from '../llm/ollamaResponse';
import { readOllamaGenerationTiming } from '../llm/requestTiming';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const encode = (text: string) => new TextEncoder().encode(text);
const line = (value: unknown) => JSON.stringify(value) + '\n';
function streamed(chunks: Uint8Array[], contentType = 'application/x-ndjson') {
    let index = 0, cancellations = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (index < chunks.length) { controller.enqueue(chunks[index++]); } else { controller.close(); }
    }, cancel() { cancellations++; } });
    return { response: new Response(body, { headers: { 'content-type': contentType } }),
        body, cancellations: () => cancellations };
}
function safeFailure(reason: string) {
    return (error: unknown): boolean => {
        assert.ok(error instanceof AnalysisStageError);
        assert.equal(error.category, reason === 'ollama-stream-provider-error' ? 'model-api' : 'model-format');
        assert.equal(error.stage, 'model-response');
        assert.deepEqual(error.diagnostic, { reasonCode: reason });
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROVIDER|PRIVATE_PARTIAL/);
        assert.doesNotMatch(error.message, /PRIVATE_PROVIDER|PRIVATE_PARTIAL/);
        return true;
    };
}

test('NDJSON handles UTF8 split inside multibyte characters, CRLF and split records', async () => {
    const text = '\n' + line({ response: '字🙂', done: false }) + '\r\n' + line({ response: '尾', done: true, done_reason: 'stop' });
    const bytes = encode(text), firstChineseByte = bytes.indexOf(0xe5);
    const fixture = streamed([bytes.slice(0, firstChineseByte + 1), bytes.slice(firstChineseByte + 1, firstChineseByte + 3),
        bytes.slice(firstChineseByte + 3, bytes.length - 2), bytes.slice(-2)]);
    assert.deepEqual(await readOllamaGenerationResponse(fixture.response), { done: true, done_reason: 'stop', response: '字🙂尾' });
    assert.equal(fixture.body.locked, false);
});

test('only bounded numeric terminal stats and known completion reason survive NDJSON', async () => {
    const fixture = streamed([encode(line({ response: 'ok', done: false, thinking: 'PRIVATE_PROVIDER' })
        + line({ done: true, done_reason: 'stop', total_duration: 3000000, load_duration: 1000000,
            prompt_eval_count: 7, prompt_eval_duration: 500000, eval_count: 2, eval_duration: 1500000,
            thinking: 'PRIVATE_PROVIDER', context: [1, 2], model: 'PRIVATE_PROVIDER', nested: { private: 'PRIVATE_PROVIDER' } }))]);
    const payload = await readOllamaGenerationResponse(fixture.response);
    assert.deepEqual(Object.keys(payload).sort(), ['done', 'done_reason', 'eval_count', 'eval_duration', 'load_duration',
        'prompt_eval_count', 'prompt_eval_duration', 'response', 'total_duration'].sort());
    assert.deepEqual(readOllamaGenerationTiming(payload), { loadDurationMs: 1, promptEvalDurationMs: 0.5,
        evalDurationMs: 1.5, totalDurationMs: 3, promptEvalCount: 7, evalCount: 2, done: true, completionReason: 'stop' });
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_PROVIDER/);
});

test('progress emits first bytes, first actual response and completed once; no thinking or headers are text', async () => {
    const progress: OllamaResponseProgress[] = [];
    const chunks = [line({ thinking: 'PRIVATE_PROVIDER', response: '', done: false }),
        line({ response: 'abc', done: false }), line({ response: 'de', done: true })].map(encode);
    const fixture = streamed(chunks, 'application/ndjson; charset=utf-8');
    await readOllamaGenerationResponse(fixture.response, item => progress.push(item));
    assert.deepEqual(progress.map(item => item.phase), ['first-bytes', 'first-text', 'completed']);
    assert.equal(progress[0].firstTextMs, null); assert.equal(progress[0].responseCharacters, 0);
    assert.equal(progress[1].receivedChunks, 2); assert.equal(progress[1].responseCharacters, 3);
    assert.ok(progress[1].firstTextMs !== null && progress[1].firstTextMs >= 0);
    assert.equal(progress[2].responseCharacters, 5); assert.equal(progress[2].receivedChunks, 3);
    assert.equal(progress[2].receivedBytes, chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    assert.deepEqual(Object.keys(progress[0]).sort(), ['version', 'phase', 'receivedChunks', 'receivedBytes',
        'responseCharacters', 'elapsedMs', 'firstTextMs'].sort());
    assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_PROVIDER|abc|de"/);
});

test('length terminal remains visible to the existing output-limit gate, never accepted as complete text', async () => {
    const fixture = streamed([encode(line({ response: 'PRIVATE_PARTIAL', done: true, done_reason: 'length', eval_count: 128 }))]);
    const payload = await readOllamaGenerationResponse(fixture.response);
    assert.equal(payload.done_reason, 'length'); assert.equal(payload.eval_count, 128);
    assert.throws(() => getCompletedOllamaText(payload, 128), error => error instanceof AnalysisStageError
        && (error.diagnostic as { reasonCode: string }).reasonCode === 'output-token-limit');
});

test('valid terminal without final newline and empty completed response are supported', async () => {
    const phases: string[] = [];
    const fixture = streamed([encode('{"done":true,"response":""}')]);
    assert.deepEqual(await readOllamaGenerationResponse(fixture.response, item => phases.push(item.phase)), { done: true, response: '' });
    assert.deepEqual(phases, ['first-bytes', 'completed']);
});

test('terminal is not published until EOF, so a later chunk cannot append another record', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const phases: string[] = [];
    controller.enqueue(encode(line({ done: true, response: 'PRIVATE_PARTIAL' })));
    const result = readOllamaGenerationResponse(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }),
        progress => phases.push(progress.phase));
    let settled = false;
    const settledResult = result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.ok(!phases.includes('completed'));
    controller.enqueue(encode(line({ response: 'PRIVATE_PROVIDER', done: false })));
    await assert.rejects(result, safeFailure('ollama-stream-trailing-record'));
    await settledResult;
    assert.equal(body.locked, false); assert.ok(!phases.includes('completed'));
});

test('invalid or private numerical/reason metadata is omitted rather than guessed or leaked', async () => {
    const fixture = streamed([encode(line({ done: true, done_reason: 'PRIVATE_PROVIDER', response: '',
        eval_count: -1, eval_duration: 1.5, load_duration: 'PRIVATE_PROVIDER', prompt_eval_count: 9007199254740992 }))]);
    const payload = await readOllamaGenerationResponse(fixture.response);
    assert.deepEqual(payload, { done: true, response: '' });
    assert.deepEqual(readOllamaGenerationTiming(payload), { loadDurationMs: null, promptEvalDurationMs: null,
        evalDurationMs: null, totalDurationMs: null, promptEvalCount: null, evalCount: null, done: true, completionReason: null });
});

for (const [name, wire, reason] of [
    ['missing terminal', line({ response: 'PRIVATE_PARTIAL', done: false }), 'ollama-stream-missing-terminal'],
    ['empty stream', '', 'ollama-stream-missing-terminal'],
    ['provider error', line({ error: 'PRIVATE_PROVIDER' }), 'ollama-stream-provider-error'],
    ['malformed JSON', '{"response":"PRIVATE_PARTIAL"\n', 'ollama-stream-invalid-json'],
    ['array record', '[]\n', 'ollama-stream-invalid-record'],
    ['invalid response type', '{"response":42,"done":true}\n', 'ollama-stream-invalid-record'],
    ['invalid done type', '{"done":"true"}\n', 'ollama-stream-invalid-record'],
    ['duplicate done', line({ done: true }) + line({ done: true }), 'ollama-stream-duplicate-terminal'],
    ['trailing record', line({ done: true }) + line({ response: 'PRIVATE_PARTIAL', done: false }), 'ollama-stream-trailing-record']
] as const) {
    test(`NDJSON rejects ${name} without adopting partial output`, async () => {
        const fixture = streamed([encode(wire)]);
        const phases: string[] = [];
        await assert.rejects(readOllamaGenerationResponse(fixture.response, item => phases.push(item.phase)), safeFailure(reason));
        assert.equal(fixture.body.locked, false); assert.ok(!phases.includes('completed'));
    });
}

test('malformed/oversize stream cancels its reader before releasing the lock', async () => {
    const fixture = streamed([encode('PRIVATE_PROVIDER\n'), encode(line({ done: true }))]);
    await assert.rejects(readOllamaGenerationResponse(fixture.response), safeFailure('ollama-stream-invalid-json'));
    assert.equal(fixture.cancellations(), 1); assert.equal(fixture.body.locked, false);
});

test('a transport whose cancel never settles cannot delay the safe rejection or retain the lock', async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode('PRIVATE_PROVIDER\n')); },
        cancel() { cancellations++; return new Promise<void>(() => undefined); } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('reader cleanup exceeded test deadline')), 250); });
        await assert.rejects(Promise.race([readOllamaGenerationResponse(new Response(body,
            { headers: { 'content-type': 'application/x-ndjson' } })), deadline]), safeFailure('ollama-stream-invalid-json'));
        assert.equal(cancellations, 1); assert.equal(body.locked, false);
    } finally { clearTimeout(timer); }
});

test('invalid UTF8, including a torn final codepoint, is rejected safely', async () => {
    for (const bytes of [Uint8Array.from([0xff]), Uint8Array.from([0xe5, 0xad])]) {
        const fixture = streamed([bytes]);
        await assert.rejects(readOllamaGenerationResponse(fixture.response), safeFailure('ollama-stream-invalid-utf8'));
        assert.equal(fixture.body.locked, false);
    }
});

test('unexpected body read failures are typed, sanitized and release the reader', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('PRIVATE_PROVIDER')); } });
    await assert.rejects(readOllamaGenerationResponse(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })),
        safeFailure('ollama-stream-read-error'));
    assert.equal(body.locked, false);
});

test('NDJSON requires an available unlocked byte stream', async () => {
    await assert.rejects(readOllamaGenerationResponse(new Response(null, { headers: { 'content-type': 'application/x-ndjson' } })),
        safeFailure('ollama-stream-body-unavailable'));
    const fixture = streamed([encode(line({ done: true }))]);
    const owned = fixture.body.getReader();
    await assert.rejects(readOllamaGenerationResponse(fixture.response), safeFailure('ollama-stream-body-unavailable'));
    assert.equal(fixture.body.locked, true, 'a reader owned elsewhere must not be released');
    await owned.cancel(); owned.releaseLock();
    const nonBytes = new ReadableStream({ start(controller) { controller.enqueue('PRIVATE_PROVIDER'); } });
    await assert.rejects(readOllamaGenerationResponse(new Response(nonBytes, { headers: { 'content-type': 'application/x-ndjson' } })),
        safeFailure('ollama-stream-invalid-chunk'));
    assert.equal(nonBytes.locked, false);
});

test('external AbortError propagates unchanged and observer exceptions still clean up', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(abort); } });
    await assert.rejects(readOllamaGenerationResponse(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })), error => error === abort);
    assert.equal(body.locked, false);
    const observer = new Error('observer failed');
    const fixture = streamed([encode(line({ response: 'x', done: false })), encode(line({ done: true }))]);
    await assert.rejects(readOllamaGenerationResponse(fixture.response, () => { throw observer; }), error => error === observer);
    assert.equal(fixture.cancellations(), 1); assert.equal(fixture.body.locked, false);
});

test('wire, per-line and cumulative answer limits independently reject overflow', async () => {
    const wire = streamed([new Uint8Array(limits.wireBytes + 1)]);
    await assert.rejects(readOllamaGenerationResponse(wire.response), safeFailure('ollama-stream-wire-limit'));
    const longLine = streamed([encode(' '.repeat(limits.lineCharacters + 1))]);
    await assert.rejects(readOllamaGenerationResponse(longLine.response), safeFailure('ollama-stream-line-limit'));
    const part = 'a'.repeat(1024 * 1024);
    const answer = streamed(Array.from({ length: 9 }, () => encode(line({ response: part, done: false }))));
    await assert.rejects(readOllamaGenerationResponse(answer.response), safeFailure('ollama-stream-answer-limit'));
    for (const fixture of [wire, longLine, answer]) { assert.equal(fixture.body.locked, false); }
});

test('exact inclusive answer limit succeeds across bounded records', async () => {
    const part = 'a'.repeat(1024 * 1024);
    const fixture = streamed([...Array.from({ length: 8 }, () => encode(line({ response: part, done: false }))), encode(line({ done: true }))]);
    assert.equal((await readOllamaGenerationResponse(fixture.response)).response?.toString().length, limits.answerCharacters);
});

test('exact inclusive wire and line limits remain usable rather than rejecting valid boundary responses', async () => {
    const terminal = line({ done: true });
    const unit = 1024 * 1024;
    const padding = encode(' '.repeat(unit - 1) + '\n');
    const last = encode(' '.repeat(unit - terminal.length - 1) + '\n' + terminal);
    const wire = streamed([...Array.from({ length: 15 }, () => padding), last]);
    let byteCount = 0;
    assert.deepEqual(await readOllamaGenerationResponse(wire.response, progress => { byteCount = progress.receivedBytes; }), { done: true, response: '' });
    assert.equal(byteCount, limits.wireBytes);
    const prefix = '{"done":true,"ignored":"', suffix = '"}';
    const exactLine = prefix + 'x'.repeat(limits.lineCharacters - prefix.length - suffix.length) + suffix;
    assert.equal(exactLine.length, limits.lineCharacters);
    assert.deepEqual(await readOllamaGenerationResponse(streamed([encode(exactLine)]).response), { done: true, response: '' });
});

test('plain JSON and existing json-only mocks retain missing-done compatibility and stats', async () => {
    const payload = { response: 'answer', eval_count: 2, eval_duration: 1000000 };
    let calls = 0;
    const mock = { json: async () => { calls++; return payload; } } as unknown as Response;
    assert.equal(await readOllamaGenerationResponse(mock), payload); assert.equal(calls, 1);
    const real = new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    assert.deepEqual(await readOllamaGenerationResponse(real), payload);
    for (const value of [null, [], 'PRIVATE_PROVIDER']) {
        await assert.rejects(readOllamaGenerationResponse({ json: async () => value } as unknown as Response), safeFailure('ollama-response-invalid-record'));
    }
    await assert.rejects(readOllamaGenerationResponse(new Response('PRIVATE_PROVIDER')), safeFailure('ollama-response-invalid-json'));
    await assert.rejects(readOllamaGenerationResponse({ json: async () => ({ response: 'x'.repeat(limits.answerCharacters + 1) }) } as unknown as Response),
        safeFailure('ollama-response-answer-limit'));
});

test('plain JSON explicitly marked incomplete cannot pass a valid role response prefix to the caller', async () => {
    const payload = { done: false, response: '{"findings":[]}' };
    for (const response of [new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
        { json: async () => payload } as unknown as Response]) {
        await assert.rejects(readOllamaGenerationResponse(response), error => {
            assert.equal(safeFailure('ollama-response-incomplete')(error), true);
            assert.doesNotMatch(JSON.stringify(error), /findings/);
            return true;
        });
    }
});

test('plain JSON rejects a nonboolean done while retaining true and omitted done', async () => {
    for (const done of [null, 'true', 1, {}, [], undefined]) {
        await assert.rejects(readOllamaGenerationResponse({ json: async () => ({ done, response: 'answer' }) } as unknown as Response),
            safeFailure('ollama-response-invalid-record'));
    }
    for (const payload of [{ done: true, response: 'answer' }, { response: 'answer' }]) {
        assert.equal(await readOllamaGenerationResponse({ json: async () => payload } as unknown as Response), payload);
    }
});
