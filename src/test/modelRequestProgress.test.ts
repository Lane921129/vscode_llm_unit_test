import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestProgress, REQUEST_PROGRESS_PHASES } from '../llm/requestTiming';
import { formatModelRequestTiming } from '../pipeline/modelRequestTimingPresentation';
import { describeStageEvent } from '../pipeline/resultPresentation';
import { getLanguage, setLanguage } from '../i18n/core';

test('request progress preserves unknown HTTP and provider work before transport starts', () => {
    const progress = createRequestProgress('queue-timeout', 100, {}, 300);
    assert.equal(progress.elapsedMs, 200);
    assert.equal(progress.transportAttempt, null);
    assert.equal(progress.httpStatus, null);
    assert.equal(progress.receivedBytes, null);
    assert.equal(progress.responseCharacters, null);
    assert.equal(progress.firstTextMs, null);
    assert.equal(progress.requestBodyHash, null);
    assert.equal(createRequestProgress('dispatch', 300, {}, 100).elapsedMs, null);
});

test('request progress strips arbitrary provider fields and rejects unknown phases', () => {
    const progress = createRequestProgress('http-headers', 100, {
        transportAttempt: 1, httpStatus: 200, receivedBytes: -1, receivedChunks: 1.5,
        responseCharacters: Infinity, firstTextMs: NaN, response: 'PRIVATE_ANSWER',
        apiKey: 'PRIVATE_CREDENTIAL', requestBodyHash: 'PRIVATE_BODY', requestBodyBytes: -1
    } as any, 200);
    assert.equal(progress.httpStatus, 200);
    assert.equal(progress.receivedBytes, null);
    assert.equal(progress.receivedChunks, null);
    assert.equal(progress.responseCharacters, null);
    assert.equal(progress.requestBodyHash, null);
    assert.equal(progress.requestBodyBytes, null);
    assert.doesNotMatch(JSON.stringify(progress), /PRIVATE|apiKey|response":/);
    assert.throws(() => createRequestProgress('PRIVATE_PHASE' as any, 100), TypeError);
});

test('progress phases are visible in English and Chinese without presenting them as approval', () => {
    const previous = getLanguage();
    try {
        for (const phase of REQUEST_PROGRESS_PHASES) {
            const detail = { ...createRequestProgress(phase, 100, {
                receivedBytes: 80, responseCharacters: 12, firstTextMs: 50
            }, 200), role: 'analyst-planning' };
            setLanguage('zh-tw');
            assert.match(formatModelRequestTiming(detail)!, /模型請求進度/);
            setLanguage('en');
            const text = describeStageEvent('model-request', 'timing', detail);
            assert.match(text, /Model request progress/);
            assert.doesNotMatch(text, /\p{Script=Han}/u);
        }
        assert.match(formatModelRequestTiming({ ...createRequestProgress('response-completed', 0),
            role: 'writer' })!, /not a test pass/);
        assert.match(formatModelRequestTiming({ ...createRequestProgress('http-request', 0),
            role: 'writer' })!, /server receipt is not yet confirmed/);
    } finally { setLanguage(previous); }
});

test('progress renderer refuses untrusted phases and numeric or role text injection', () => {
    const previous = getLanguage();
    try {
        setLanguage('en');
        assert.equal(formatModelRequestTiming({ version: 'model-request-progress-v1', kind: 'progress',
            phase: 'PRIVATE_PHASE' }), undefined);
        assert.equal(formatModelRequestTiming({ version: 'model-request-progress-v1', kind: 'PRIVATE_KIND',
            phase: 'queued' }), undefined);
        const text = formatModelRequestTiming({ version: 'model-request-progress-v1', kind: 'progress',
            phase: 'queued', role: 'PRIVATE_ROLE', receivedBytes: 'PRIVATE_COUNT', elapsedMs: NaN,
            responseCharacters: -1 })!;
        assert.doesNotMatch(text, /PRIVATE|NaN|-1/);
        assert.match(text, /unknown/i);
    } finally { setLanguage(previous); }
});

test('allocation difference explains possible reload without replacing saved context or inventing input counts', () => {
    const previous = getLanguage();
    try {
        const detail = { contextWindow: 65536, lastObservedRuntimeContextTokens: 131072,
            savedChoicePreserved: true, provider: 'PRIVATE_PROVIDER' };
        setLanguage('zh-tw');
        assert.match(describeStageEvent('model-runtime', 'allocation-differs', detail), /65536.*131072.*可能重載/);
        setLanguage('en');
        const text = describeStageEvent('model-runtime', 'allocation-differs', detail);
        assert.match(text, /65536.*131072.*may reload/);
        assert.match(text, /not actual input token counts/);
        assert.doesNotMatch(text, /PRIVATE|\p{Script=Han}/u);
        assert.doesNotMatch(describeStageEvent('model-runtime', 'allocation-differs',
            { contextWindow: 'PRIVATE_CONTEXT', lastObservedRuntimeContextTokens: -1 }), /PRIVATE|-1/);
    } finally { setLanguage(previous); }
});
