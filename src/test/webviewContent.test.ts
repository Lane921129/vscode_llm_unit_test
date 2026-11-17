import * as assert from 'assert';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { getWebviewContent } from '../ui/webviewContent';
import { setLanguage, t } from '../i18n/core';

test('both result deletion buttons remove only checked dashboard cards in either language', () => {
    try {
        for (const language of ['en', 'zh-tw']) {
            setLanguage(language);
            const html = getWebviewContent(t);
            const controls = html.slice(html.indexOf('id="select-all"'), html.indexOf('id="results-count"'));
            assert.ok(controls.includes('id="btn-delete-selected-top"'));
            assert.ok(controls.includes(t('ui.batchDeleteSelected')));
            assert.equal((html.match(/id="btn-delete-selected-top"/g) || []).length, 1);
            assert.equal((html.match(/id="btn-delete-selected"/g) || []).length, 1);
            const elements = new Map<string, any>();
            const handlers = new Map<string, () => void>();
            const messages: unknown[] = [];
            for (const match of html.matchAll(/<(?:input|select|button|textarea|p|span)[^>]*\bid="([^"]+)"[^>]*>/g)) {
                const id = match[1];
                elements.set(id, { value: '', style: {}, checked: false,
                    addEventListener: (event: string, handler: () => void) => handlers.set(id + ':' + event, handler) });
            }
            elements.get('validation-mode').value = 'full';
            const context = vm.createContext({ document: { getElementById: (id: string) => elements.get(id) },
                window: { addEventListener() {} }, acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }) });
            vm.runInContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1], context);
            vm.runInContext('let dashboardRefreshes = 0; renderDashboard = () => dashboardRefreshes++;', context);
            messages.length = 0;
            for (const id of ['btn-delete-selected-top', 'btn-delete-selected']) {
                vm.runInContext('resultsMap.clear(); resultsMap.set("checked", {checked: true}); resultsMap.set("kept", {checked: false});', context);
                elements.get('select-all').checked = true;
                const refreshes = vm.runInContext('dashboardRefreshes', context);
                handlers.get(id + ':click')!();
                assert.equal(vm.runInContext('resultsMap.has("checked")', context), false);
                assert.equal(vm.runInContext('resultsMap.has("kept")', context), true);
                assert.equal(vm.runInContext('resultsMap.size', context), 1);
                assert.equal(elements.get('select-all').checked, false);
                assert.equal(vm.runInContext('dashboardRefreshes', context), refreshes + 1);
                handlers.get(id + ':click')!();
                assert.equal(vm.runInContext('resultsMap.size', context), 1);
            }
            // Deletion stays inside the dashboard; no request to remove saved reports.
            assert.deepEqual(messages, []);
        }
    } finally { setLanguage('zh-tw'); }
});

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
    assert.ok(html.includes('ui.openReport'));
});

test('startAnalysis and startBatchAnalysis include cloudKeyName in payload', () => {
    const html = getWebviewContent(key => key);

    assert.ok(html.includes("const { envType, modelName, cloudKeyName } = getStartParams();"));
    assert.ok(html.includes("command: 'startAnalysis',\n                envType, modelName, cloudKeyName, filePath,"));
    assert.match(html, /command: 'startBatchAnalysis',\s+envType, modelName, cloudKeyName, batchPath,/);
    assert.ok(!html.includes('id="btn-batch-run"'));
    assert.ok(!html.includes('id="batch-path"'));
    assert.ok(html.includes('<option value="">ui.allFiles</option>'));
});

test('test settings do not expose an unsupported concurrency control', () => {
    const html = getWebviewContent(key => key);

    assert.ok(!html.includes('concurrency-select'));
    assert.ok(!html.includes('Concurrency Workers'));
});

// PR #13b (accepted 11/12) moved dependency checks and "other scope" into section ⑤ advanced settings.
function advancedSettingsArea(html: string) {
    return html.slice(html.indexOf('id="advanced-settings-details"'), html.indexOf('id="section-actions"'));
}

test('dependency checks and their result stay together in advanced settings with a separate scope option', () => {
    const html = getWebviewContent(key => key);
    const advanced = advancedSettingsArea(html);
    assert.ok(advanced.includes('id="btn-prepare-env"'));
    assert.ok(advanced.includes('id="btn-prepare-env-scope"'));
    assert.ok(advanced.includes('id="python-environment-status"'));
    assert.ok(advanced.indexOf('id="btn-prepare-env"') < advanced.indexOf('id="python-environment-status"'), 'the result follows its buttons');
    assert.equal((html.match(/id="btn-prepare-env"/g) || []).length, 1);
    assert.ok(!html.slice(html.indexOf('id="section-test-data"'), html.indexOf('id="section-test-method"')).includes('id="btn-prepare-env"'));
    assert.ok(!html.slice(html.indexOf('id="section-actions"')).includes('id="btn-prepare-env"'));
});

test('source selection guidance renders beside project readiness in both supported languages', () => {
    try {
        for (const language of ['en', 'zh-tw']) {
            setLanguage(language);
            const html = getWebviewContent(t);
            const area = advancedSettingsArea(html);
            assert.ok(area.includes('id="btn-batch-scope"'));
            assert.ok(area.indexOf('id="python-environment-status"') < area.indexOf('id="btn-batch-scope"'), 'guidance sits right after project readiness');
            assert.ok(area.includes(t('ui.chooseBatchSources')));
            assert.ok(area.includes(t('ui.batchScopeGuide')));
            assert.ok(!area.includes('ui.batchScope'));
            if (language === 'en') { assert.ok(!/[\u3400-\u9fff]/.test(area)); }
        }
    } finally { setLanguage('zh-tw'); }
});
