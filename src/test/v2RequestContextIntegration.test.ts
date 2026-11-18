import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { qualificationEndpointKey } from '../llm/modelQualification';
import { RUNTIME_CONTEXT_PREFERENCES_KEY } from '../llm/runtimeContextPreferences';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

// 2026-11-18 lab run: every v2 request went out without num_ctx, so Ollama used its own
// 4096 default and 17 of 26 targets stopped at exactly 4096 tokens (prompt + output).
test('v2 case-table requests send the same resolved local num_ctx as v1', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-request-context-'));
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, 'def increment(value):\n    """Return value plus one."""\n    return value + 1\n');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const baseUrl = 'http://v2-context-fixture:11434', modelName = 'neutral-v2-context';
    const endpointKey = qualificationEndpointKey('local', baseUrl);
    const persisted = new Map<string, unknown>([
        [RUNTIME_CONTEXT_PREFERENCES_KEY, [{ endpointKey, modelName, tokens: 8192, source: 'user-choice' }]]]);
    const settings: Record<string, unknown> = { pythonPath: python, ollamaBaseUrl: baseUrl, pipelineVersion: 'v2-case-table',
        specOracle: 'off', caseTableReview: 'off', qualityAnalyst: 'off', language: 'en' };
    const handlers = new Map<string, (...args: any[]) => any>();
    const generated: Array<{ num_ctx: unknown; think: unknown }> = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }], getConfiguration: () => ({
            get: (key: string, fallback: unknown) => (Object.hasOwn(settings, key) ? settings[key] : fallback) }),
            openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_name: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showWarningMessage: async () => {}, showTextDocument: async () => {} },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    const row = JSON.stringify({ scenario: 'one more than a positive value', category: 'normal', args: '(1,)', kwargs: '{}',
        mocks: '', requirement: '' });
    globalThis.fetch = async (url, init) => {
        const endpoint = String(url);
        if (endpoint.endsWith('/api/show')) {
            return Response.json({ model_info: { 'general.architecture': 'neutral', 'neutral.context_length': 16384 },
                details: { parameter_size: '20B' } });
        }
        if (endpoint.endsWith('/api/ps')) { return Response.json({ models: [] }); }
        assert.ok(endpoint.endsWith('/api/generate'), endpoint);
        const body = JSON.parse(String(init?.body));
        generated.push({ num_ctx: body.options?.num_ctx, think: body.think });
        return Response.json({ response: row, done: true, done_reason: 'stop' });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => { persisted.set(key, value); } },
            secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName, ollamaUrl: baseUrl,
            localThinkingMode: 'disabled', filePath: source, funcName: 'increment', promptStrategy: 'full', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 30, mutationEngine: 'builtin', outputPath: path.join(directory, 'out') });
        assert.ok(generated.length > 0, 'the v2 pipeline sent at least one model request');
        for (const request of generated) { assert.equal(request.num_ctx, 8192); }
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
