import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { measuredOutputRateMilli, mergeModelCapabilitySummaries, summarizeModelCapability } from '../llm/modelCapabilitySummary';
import { renderModelCapabilitySummary } from '../pipeline/targetReport';

test('fractional milliseconds and tokens aggregate only as valid completed pairs', () => {
    const event = (evalCount: unknown, evalDurationMs: unknown, outcome = 'completed') => ({
        version: 'model-request-timing-v1', kind: 'transport', outcome, ollama: { evalCount, evalDurationMs }
    });
    const summary = summarizeModelCapability([event(10, 100.25), event(20, 200.5),
        event(900, null), event(null, 800), event(50, 0), event(100, 2, 'timeout'), event(1, Infinity)]);
    assert.equal(summary.outputTokens, 30);
    assert.equal(summary.outputEvalMs, 300.75);
    assert.equal(measuredOutputRateMilli(summary), Math.floor(30 * 1_000_000 / 300.75));
    assert.deepEqual(mergeModelCapabilitySummaries([summary]), summary);
    assert.deepEqual(mergeModelCapabilitySummaries([summary, { ...summary, outputTokens: 900, outputEvalMs: 0 }]), summary,
        'historical summaries with tokens but no timing must not distort another measured rate');
});

test('capability summaries retain only aggregate completed transport evidence', () => {
    const summary = summarizeModelCapability([
        { version: 'model-request-timing-v1', kind: 'transport', outcome: 'completed',
            ollama: { completionReason: 'length', evalCount: 120, evalDurationMs: 3000 }, response: 'private' },
        { version: 'model-request-timing-v1', kind: 'transport', outcome: 'timeout',
            ollama: { completionReason: null, evalCount: null, evalDurationMs: null }, endpoint: 'private' },
        { version: 'wrong', kind: 'transport', outcome: 'completed', ollama: { evalCount: 999, evalDurationMs: 1 } }
    ]);
    assert.deepEqual(summary, { version: 'model-capability-summary-v1', completedTransports: 1,
        timedOutTransports: 1, lengthStoppedTransports: 1, outputTokens: 120, outputEvalMs: 3000 });
    assert.equal(measuredOutputRateMilli(summary), 40000);
});

test('capability summary never invents a rate from missing or invalid timing', () => {
    assert.equal(measuredOutputRateMilli(summarizeModelCapability([])), null);
    assert.deepEqual(summarizeModelCapability([null, { version: 'model-request-timing-v1', kind: 'progress' }]), {
        version: 'model-capability-summary-v1', completedTransports: 0, timedOutTransports: 0,
        lengthStoppedTransports: 0, outputTokens: 0, outputEvalMs: 0
    });
});

test('batch aggregation ignores malformed summaries and refuses numeric overflow', () => {
    const merged = mergeModelCapabilitySummaries([
        { version: 'model-capability-summary-v1', completedTransports: 2, timedOutTransports: 1,
            lengthStoppedTransports: 0, outputTokens: 60, outputEvalMs: 1500 },
        { version: 'model-capability-summary-v1', completedTransports: 1, timedOutTransports: 0,
            lengthStoppedTransports: 1, outputTokens: 40, outputEvalMs: 500 },
        { version: 'model-capability-summary-v1', completedTransports: -1, timedOutTransports: 0,
            lengthStoppedTransports: 0, outputTokens: 0, outputEvalMs: 0 },
        { version: 'model-capability-summary-v1', completedTransports: Number.MAX_SAFE_INTEGER,
            timedOutTransports: 0, lengthStoppedTransports: 0, outputTokens: 0, outputEvalMs: 0 }
    ]);
    assert.deepEqual(merged, { version: 'model-capability-summary-v1', completedTransports: 3,
        timedOutTransports: 1, lengthStoppedTransports: 1, outputTokens: 100, outputEvalMs: 2000 });
});

test('report presentation accepts only matching model-request timing details', () => {
    const report = renderModelCapabilitySummary([
        { stage: 'model-request', status: 'timing', detail: { version: 'model-request-timing-v1', kind: 'transport',
            outcome: 'completed', ollama: { completionReason: 'stop', evalCount: 20, evalDurationMs: 500 } } },
        { stage: 'writer', status: 'timing', detail: { version: 'model-request-timing-v1', kind: 'transport',
            outcome: 'timeout', ollama: { completionReason: 'length', evalCount: 999, evalDurationMs: 1 } } },
        { stage: 'model-request', status: 'requested', detail: { version: 'model-request-timing-v1', kind: 'transport',
            outcome: 'timeout', ollama: { completionReason: 'length', evalCount: 999, evalDurationMs: 1 } } }
    ]);
    assert.match(report, /完成傳輸：1；逾時：0；因輸出長度停止：0/);
    assert.match(report, /20；生成計時：500 ms；量測輸出速率：40\.000 tokens\/s/);
    assert.doesNotMatch(report, /999/);
    assert.match(report, /不代表測試品質、模型資格或後續請求保證/);
});
