import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { getWebviewContent } from '../ui/webviewContent';
import { setLanguage, t } from '../i18n/core';

test('context UI clears stale model and endpoint values, saves a choice and freezes during analysis', () => {
    setLanguage('en');
    const html = getWebviewContent(t, 'en');
    assert.match(html, /(?:Saving 0 clears the choice and detects capacity again|saving 0 clears it and restores automatic mode)/i);
    const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)![1];
    const elements = new Map<string, any>();
    for (const match of html.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/gi)) {
        let value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        const element = { style: {}, disabled: /\bdisabled\b/.test(match[0]), addEventListener: () => {}, textContent: '', innerHTML: '' };
        Object.defineProperty(element, 'value', { get: () => value, set: next => { value = String(next); } });
        elements.set(match[1], element);
    }
    elements.get('validation-mode').value = 'full'; elements.get('mutation-engine').value = 'builtin';
    elements.get('env-type').value = 'local';
    const messages: any[] = [];
    let receive!: (event: unknown) => void;
    const context = vm.createContext({ document: { getElementById: (id: string) => elements.get(id) },
        window: { addEventListener: (event: string, handler: typeof receive) => { if (event === 'message') { receive = handler; } } },
        acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { messages.push(message); } }) });
    vm.runInContext(script, context);
    const select = (model: string) => { elements.get('model-select').value = model; elements.get('model-select').onchange(); return messages.at(-1); };
    const render = (request: any, fields: any) => receive({ data: { command: 'modelRuntimeContext', modelName: request.modelName,
        endpointKey: 'endpoint-a', revision: request.revision, configuredTokens: 0, ...fields } });
    const input = elements.get('runtime-context-tokens'), save = elements.get('btn-save-runtime-context'), status = elements.get('runtime-context-status');
    assert.equal(input.disabled, true);
    const first = select('neutral-a'); assert.equal(first.command, 'getModelRuntimeContext');
    render(first, { savedTokens: 8192, savedSource: 'captured-runtime', allocatedTokens: 8192, allocationCurrent: true, modelLimit: 32768, requestTokens: 8192 });
    assert.equal(input.value, '0'); assert.equal(input.disabled, false);
    assert.match(status.textContent, /Ollama current allocation/); assert.match(status.textContent, /8,192/);
    assert.ok(status.textContent.includes('\n'), 'capacity facts are displayed on separate lines');
    assert.match(status.textContent, /32,768/); assert.doesNotMatch(status.textContent, /[\u4e00-\u9fff]/);
    input.value = '12288'; save.onclick();
    assert.equal(messages.at(-1).command, 'setModelRuntimeContextTokens'); assert.equal(messages.at(-1).tokens, 12288);
    assert.equal(save.disabled, true);
    render(messages.at(-1), { savedTokens: 12288, savedSource: 'user-choice', allocatedTokens: 8192, allocationCurrent: false, defaultTokens: 4096, modelLimit: 32768, requestTokens: 12288 });
    assert.equal(input.value, '12288'); assert.equal(save.disabled, false);
    assert.match(status.textContent, /Most recently observed/); assert.match(status.textContent, /Model default num_ctx/);
    const second = select('neutral-b'); assert.equal(input.value, '0'); assert.equal(status.textContent, ''); assert.equal(save.disabled, true);
    render(first, { savedTokens: 12288, savedSource: 'user-choice', requestTokens: 12288 });
    assert.equal(input.value, '0'); assert.equal(status.textContent, '', 'stale model reply must not populate a new model');
    render(second, { savedTokens: 4096, savedSource: 'captured-runtime', requestTokens: 4096 }); assert.equal(input.value, '0');
    elements.get('ollama-url').value = 'http://127.0.0.1:21434'; elements.get('ollama-url').oninput();
    assert.equal(save.disabled, true); assert.equal(status.textContent, '');
    render(second, { savedTokens: 8192, savedSource: 'user-choice', requestTokens: 8192 }); assert.equal(status.textContent, '', 'stale endpoint reply must be ignored');
    receive({ data: { command: 'ollamaUrlSaved' } }); const fresh = messages.at(-1); assert.equal(fresh.ollamaUrl, 'http://127.0.0.1:21434');
    render(fresh, { savedTokens: 6144, savedSource: 'user-choice', requestTokens: 6144, modelLimit: 32768 }); assert.equal(input.value, '6144');
    input.value = ''; const count = messages.length; save.onclick(); assert.equal(messages.length, count); assert.match(status.textContent, /whole number/);
    vm.runInContext('setRunningState(true)', context);
    for (const id of ['runtime-context-tokens', 'btn-save-runtime-context', 'model-select', 'ollama-url', 'btn-save-ollama-url', 'btn-refresh-models', 'btn-test-local']) {
        assert.equal(elements.get(id).disabled, true, `${id} must freeze during analysis`);
    }
    receive({ data: { command: 'analysisFinished' } }); assert.equal(input.disabled, false); assert.equal(save.disabled, false);
});
