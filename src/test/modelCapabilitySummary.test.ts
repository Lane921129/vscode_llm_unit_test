import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { measuredOutputRateMilli, summarizeModelCapability } from '../llm/modelCapabilitySummary';
import { renderModelCapabilitySummary } from '../pipeline/targetReport';

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
