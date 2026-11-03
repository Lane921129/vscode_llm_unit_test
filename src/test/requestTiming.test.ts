import * as assert from 'assert';
import { test } from 'node:test';
import { boundedRoleAttemptDeadline, boundedRoleStageDeadline, createRequestQueueTiming,
    createTransportAttemptTiming, readOllamaGenerationTiming } from '../llm/requestTiming';
import { retryTransientProviderRequest } from '../llm/connectionTimeout';
import { formatModelRequestTiming } from '../pipeline/modelRequestTimingPresentation';

test('gives one returned Analyst format failure a full bounded correction allowance', () => {
    const stage = boundedRoleStageDeadline(60, 2, undefined, 1_000);
    assert.strictEqual(stage, 121_000);
    assert.strictEqual(boundedRoleAttemptDeadline(stage, 60, 1_000), 61_000);
    // First response took 40 s: correction still gets the user's full 60 s.
    assert.strictEqual(boundedRoleAttemptDeadline(stage, 60, 41_000), 101_000);
});

test('manual request allowance and target deadline bound every Analyst attempt', () => {
    const stage = boundedRoleStageDeadline(15, 2, 22_000, 1_000);
    assert.strictEqual(stage, 22_000);
    assert.strictEqual(boundedRoleAttemptDeadline(stage, 15, 1_000), 16_000);
    assert.strictEqual(boundedRoleAttemptDeadline(stage, 15, 14_000), 22_000);
    assert.strictEqual(boundedRoleAttemptDeadline(stage, 15, 23_000), 22_000);
});

test('transport retries cannot spend the reserved Analyst correction allowance', async () => {
    let now = 0;
    let requests = 0;
    const stage = boundedRoleStageDeadline(60, 2, undefined, 0);
    const originalAttempt = boundedRoleAttemptDeadline(stage, 60, 0);
    await assert.rejects(retryTransientProviderRequest(async () => {
        requests++;
        now = 59_000;
        return { status: 503 };
    }, { isCancelled: () => now >= originalAttempt, wait: async () => { now = 61_000; } }), /deadline/);
    assert.strictEqual(requests, 1);
    assert.ok(now < stage, 'remaining role-stage time does not renew an HTTP attempt');
    assert.strictEqual(boundedRoleAttemptDeadline(stage, 60, 115_000), 120_000);
});

test('rejects non-finite or unbounded role timeout settings', () => {
    for (const value of [0, -1, NaN, Infinity, Number.MAX_VALUE]) {
        assert.throws(() => boundedRoleStageDeadline(value, 2, undefined, 0), TypeError);
        assert.throws(() => boundedRoleAttemptDeadline(100_000, value, 0), TypeError);
    }
    for (const attempts of [0, -1, 1.5, Infinity]) {
        assert.throws(() => boundedRoleStageDeadline(60, attempts, undefined, 0), TypeError);
    }
    assert.throws(() => boundedRoleStageDeadline(60, 2, NaN, 0), TypeError);
    assert.throws(() => boundedRoleAttemptDeadline(Infinity, 60, 0), TypeError);
});

test('converts reported Ollama nanoseconds and retains zero-valued statistics', () => {
    assert.deepStrictEqual(readOllamaGenerationTiming({
        load_duration: 1_250_000_000, prompt_eval_duration: 10_000_000,
        eval_duration: 500_000, total_duration: 2_000_000_000,
        prompt_eval_count: 100, eval_count: 0, done: true, done_reason: 'stop'
    }), {
        loadDurationMs: 1250, promptEvalDurationMs: 10, evalDurationMs: 0.5,
        totalDurationMs: 2000, promptEvalCount: 100, evalCount: 0,
        done: true, completionReason: 'stop'
    });
});

test('invalid or absent provider statistics remain unknown rather than inferred', () => {
    const unknown = readOllamaGenerationTiming(undefined);
    assert.deepStrictEqual(readOllamaGenerationTiming({
        load_duration: '1000000', prompt_eval_duration: -1, eval_duration: Infinity,
        total_duration: Number.MAX_SAFE_INTEGER + 1, prompt_eval_count: 1.5,
        eval_count: false, done: 'true', done_reason: 'arbitrary private provider text'
    }), unknown);
    assert.deepStrictEqual(readOllamaGenerationTiming(Object.create({ eval_count: 3 })), unknown);
    assert.deepStrictEqual(readOllamaGenerationTiming([]), unknown);
    assert.ok(Object.values(unknown).every(value => value === null));
});

test('projects only safe timing facts and keeps output-length completion visible', () => {
    const projected = readOllamaGenerationTiming({
        response: 'private provider answer', thinking: 'private internal text',
        model: 'private model identity', apiKey: 'private credential',
        done: true, done_reason: 'length', eval_count: 1536, eval_duration: 4_000_000
    });
    assert.strictEqual(projected.completionReason, 'length');
    assert.strictEqual(projected.evalCount, 1536);
    assert.strictEqual(projected.evalDurationMs, 4);
    assert.ok(!JSON.stringify(projected).includes('private'));
    assert.ok(!JSON.stringify(projected).includes('apiKey'));
});

test('separates queue, HTTP and body wait from provider inference measurements', () => {
    const queue = createRequestQueueTiming(100, 300);
    const timing = createTransportAttemptTiming({
        transportAttempt: 2, outcome: 'completed', queueWaitMs: queue.queueWaitMs,
        startedAt: 300, headersAt: 350, responseReadStartedAt: 360,
        responseReadFinishedAt: 900, finishedAt: 920, httpStatus: 200,
        ollamaPayload: { load_duration: 10_000_000, eval_duration: 120_000_000 }
    });
    assert.strictEqual(timing.queueWaitMs, 200);
    assert.strictEqual(timing.elapsedMs, 620);
    assert.strictEqual(timing.httpWaitMs, 50);
    assert.strictEqual(timing.responseReadMs, 540);
    assert.strictEqual(timing.httpStatus, 200);
    assert.strictEqual(timing.ollama.loadDurationMs, 10);
    assert.strictEqual(timing.ollama.evalDurationMs, 120);
    assert.strictEqual(timing.ollama.totalDurationMs, null);
});

test('timeout and cancellation keep measured waits without fabricating a provider response', () => {
    for (const outcome of ['timeout', 'cancelled'] as const) {
        const timing = createTransportAttemptTiming({ transportAttempt: 1, outcome,
            startedAt: 0, finishedAt: 60_000 });
        assert.strictEqual(timing.outcome, outcome);
        assert.strictEqual(timing.elapsedMs, 60_000);
        assert.strictEqual(timing.httpStatus, null);
        assert.strictEqual(timing.httpWaitMs, null);
        assert.strictEqual(timing.responseReadMs, null);
        assert.ok(Object.values(timing.ollama).every(value => value === null));
    }
});

test('malformed response bodies preserve HTTP and read timing as response errors', () => {
    const timing = createTransportAttemptTiming({ transportAttempt: 1, outcome: 'response-error',
        startedAt: 10, headersAt: 20, responseReadStartedAt: 20, responseReadFinishedAt: 35,
        finishedAt: 35, httpStatus: 200 });
    assert.strictEqual(timing.outcome, 'response-error');
    assert.strictEqual(timing.httpStatus, 200);
    assert.strictEqual(timing.httpWaitMs, 10);
    assert.strictEqual(timing.responseReadMs, 15);
    assert.ok(Object.values(timing.ollama).every(value => value === null));
    const presented = formatModelRequestTiming({ ...timing, role: 'analyst-planning' });
    assert.match(presented || '', /response-error/);
    assert.doesNotMatch(presented || '', /network-error/);
});

test('clock regression and invalid status numbers cannot produce misleading timing evidence', () => {
    assert.strictEqual(createRequestQueueTiming(300, 100).queueWaitMs, null);
    assert.strictEqual(createRequestQueueTiming(NaN, 100).queueWaitMs, null);
    const timing = createTransportAttemptTiming({ transportAttempt: 0, outcome: 'network-error',
        startedAt: 100, finishedAt: 99, headersAt: NaN, queueWaitMs: -1,
        responseReadStartedAt: 300, responseReadFinishedAt: 200, httpStatus: 700 });
    assert.strictEqual(timing.transportAttempt, null);
    assert.strictEqual(timing.elapsedMs, null);
    assert.strictEqual(timing.httpWaitMs, null);
    assert.strictEqual(timing.queueWaitMs, null);
    assert.strictEqual(timing.responseReadMs, null);
    assert.strictEqual(timing.httpStatus, null);
});
