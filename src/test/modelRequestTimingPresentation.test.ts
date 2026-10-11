import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLanguage, setLanguage } from '../i18n/core';
import { createRequestQueueTiming, createTransportAttemptTiming } from '../llm/requestTiming';
import { formatModelRequestTiming } from '../pipeline/modelRequestTimingPresentation';
import { describeStageEvent } from '../pipeline/resultPresentation';

test('model timing displays measured phases in both languages without attributing HTTP wait to GPU', () => {
    const previous = getLanguage();
    const detail = { role: 'analyst-planning', ...createTransportAttemptTiming({
        transportAttempt: 2, outcome: 'completed', startedAt: 0, headersAt: 4000,
        responseReadStartedAt: 4000, responseReadFinishedAt: 4002, finishedAt: 4002, httpStatus: 200,
        ollamaPayload: { load_duration: 1e9, prompt_eval_duration: 2e9, eval_duration: 5e8,
            prompt_eval_count: 321, eval_count: 90, done_reason: 'stop', done: true } }) };
    try {
        setLanguage('zh-tw');
        assert.match(describeStageEvent('model-request', 'timing', detail), /HTTP 回應等待 4000.0 ms.*Ollama 載入 1000.0 ms/);
        setLanguage('en');
        const text = formatModelRequestTiming(detail)!;
        assert.match(text, /wait for HTTP response 4000.0 ms.*prompt evaluation 2000.0 ms.*input 321, output 90/);
        assert.doesNotMatch(text, /\p{Script=Han}/u);
        assert.match(text, /cannot establish GPU time/);
        assert.match(formatModelRequestTiming({ role: 'writer', ...createRequestQueueTiming(1, 6) })!, /5.0 ms/);
    } finally { setLanguage(previous); }
});

test('timing display rejects arbitrary labels and never infers missing provider statistics', () => {
    const previous = getLanguage();
    try {
        setLanguage('en');
        const text = formatModelRequestTiming({ version: 'model-request-timing-v1', kind: 'transport',
            role: 'private-role-value', outcome: 'private-outcome', elapsedMs: 60000,
            transportAttempt: 'private-count', httpWaitMs: Infinity,
            ollama: { loadDurationMs: 'private-timing', promptEvalCount: -1, evalCount: false } })!;
        assert.doesNotMatch(text, /private|Infinity|-1|false/);
        assert.match(text, /unknown/);
        assert.match(text, /elapsed 60000.0 ms/);
        assert.equal(formatModelRequestTiming({ kind: 'transport' }), undefined);
        assert.equal(formatModelRequestTiming({ version: 'model-request-timing-v1', kind: 'private-kind' }), undefined);
    } finally { setLanguage(previous); }
});

test('context growth is visible in both languages and accepts only safe capacity numbers', () => {
    const previous = getLanguage();
    try {
        const detail = { previousContextWindow: 4096, contextWindow: 8192, modelContextLimit: 16384 };
        setLanguage('zh-tw');
        assert.match(describeStageEvent('model-runtime', 'context-grown', detail), /4096.*8192.*16384.*已儲存選擇保留/);
        setLanguage('en');
        for (const status of ['context-grown', 'context-growth-requested', 'context-growth-blocked', 'qualification-failed']) {
            assert.doesNotMatch(describeStageEvent('model-runtime', status, detail), /\p{Script=Han}/u);
        }
        assert.doesNotMatch(describeStageEvent('model-runtime', 'context-grown', {
            ...detail, contextWindow: 'private-provider-response' }), /private-provider-response/);
        assert.match(describeStageEvent('model-runtime', 'qualification-failed', detail), /old capacity was not reused/);
    } finally { setLanguage(previous); }
});
