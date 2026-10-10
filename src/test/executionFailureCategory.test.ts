import * as assert from 'assert';
import { test } from 'node:test';
import { AnalysisStageError, classifyExecutionFailure, modelRequestHttpStatus } from '../utils/executionFailureCategory';

test('classifies Tier generation failures without naming a provider or model', () => {
    assert.strictEqual(classifyExecutionFailure('HTTP 503 - service unavailable'), 'model-api');
    assert.strictEqual(classifyExecutionFailure('模型輸出未通過 Python/unittest 格式驗證'), 'model-format');
    assert.strictEqual(classifyExecutionFailure('AI 輸出格式連續兩次未通過'), 'model-format');
    assert.strictEqual(classifyExecutionFailure('Tier 1 確定性備援無法取得可驗證的動態 Trace'), 'ast-trace');
    assert.strictEqual(classifyExecutionFailure('Coverage 品質閘門不可用'), 'coverage');
    assert.strictEqual(classifyExecutionFailure('mutatest baseline failed'), 'mutation');
    assert.strictEqual(classifyExecutionFailure('執行超時 (超過 30 秒)'), 'timeout');
    assert.strictEqual(classifyExecutionFailure("No module named 'coverage'"), 'environment');
    assert.strictEqual(classifyExecutionFailure('使用者強制中止'), 'cancelled');
});

test('classifies execution validation separately from unknown diagnostics', () => {
    assert.strictEqual(classifyExecutionFailure('測試檔預先驗證失敗'), 'validation');
    assert.strictEqual(classifyExecutionFailure('unexpected diagnostic value'), 'unknown');
});

test('model request diagnostics retain only numeric HTTP error statuses from the transport stage', () => {
    assert.strictEqual(modelRequestHttpStatus(new AnalysisStageError('model-api', 'model-request', 'safe',
        { httpStatus: 500, body: 'not-for-logs', headers: { authorization: 'not-for-logs' } })), 500);
    for (const status of [undefined, null, '500', 200, 399, 600, 500.5, NaN, Infinity]) {
        assert.strictEqual(modelRequestHttpStatus(new AnalysisStageError('model-api', 'model-request', 'HTTP 500',
            { httpStatus: status })), undefined);
    }
    assert.strictEqual(modelRequestHttpStatus(new Error('HTTP 500')), undefined);
    assert.strictEqual(modelRequestHttpStatus({ category: 'model-api', stage: 'model-request', diagnostic: { httpStatus: 500 } }), undefined);
    assert.strictEqual(modelRequestHttpStatus(new AnalysisStageError('validation', 'model-request', 'HTTP 500', { httpStatus: 500 })), undefined);
    assert.strictEqual(modelRequestHttpStatus(new AnalysisStageError('model-api', 'other-stage', 'HTTP 500', { httpStatus: 500 })), undefined);
});
