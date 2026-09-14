import * as assert from 'assert';
import { test } from 'node:test';
import { getWebviewContent } from '../ui/webviewContent';

test('cloud credential editor has separate name, model, and key inputs and clears them after saving', () => {
    const html = getWebviewContent(key => key);

    assert.ok(html.includes('id="new-key-name"'));
    assert.ok(html.includes('id="new-key-model"'));
    assert.ok(html.includes('id="new-key-value"'));
    assert.ok(html.includes("case 'apiKeySaved':"));
    assert.ok(html.includes("document.getElementById('new-key-model').value = '';"));
    assert.ok(!html.includes("new-key-value').value = currentKeys[name]"));
});

test('coverage dashboard cards can open their completed function report', () => {
    const html = getWebviewContent(key => key);

    assert.ok(html.includes("command: 'openTestResult'"));
    assert.ok(html.includes("case 'attachResultReport'"));
    assert.ok(html.includes('點擊開啟此函式的測試結果報告'));
});

test('startAnalysis and startBatchAnalysis include cloudKeyName in payload', () => {
    const html = getWebviewContent(key => key);

    assert.ok(html.includes("const { envType, modelName, cloudKeyName } = getStartParams();"));
    assert.ok(html.includes("command: 'startAnalysis',\n                envType, modelName, cloudKeyName, filePath,"));
    assert.ok(html.includes("command: 'startBatchAnalysis',\n                envType, modelName, cloudKeyName, batchPath,"));
});

test('test settings do not expose an unsupported concurrency control', () => {
    const html = getWebviewContent(key => key);

    assert.ok(!html.includes('concurrency-select'));
    assert.ok(!html.includes('Concurrency Workers'));
});
