import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('formal seed wire uses the logged reserve and never validates an output-limit prefix', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-seed-output-'));
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, 'def increment(value):\n    return value + 1\n');
    const output = path.join(directory, 'result');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const requests: any[] = [];
    const persisted = new Map<string, unknown>();
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? 8192 : fallback }),
            openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    globalThis.fetch = async (_url, options) => {
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        requests.push(request);
        assert.equal(request.options.num_ctx, 8192, 'explicit run capacity stays unchanged');
        if (request.roleInstructions.includes('dependency_behaviors')) {
            assert.equal(request.options.num_predict, undefined, 'Analyst keeps its existing output policy');
            return new Response(JSON.stringify({ response: JSON.stringify({ dependency_behaviors: [],
                test_strategy: { approach: 'Exercise increment with the exact verified observed input and result.' } }),
                done: true, done_reason: 'stop' }), { status: 200 });
        }
        assert.match(request.prompt, /WRITER_SEED_V1/);
        assert.equal(request.options.num_predict, 1536);
        assert.ok(estimatePromptTokens(request.transmittedPrompt) <= 8192 - request.options.num_predict);
        return new Response(JSON.stringify({ response: 'import unittest\nfrom sample import increment\n'
            + 'class Tests(unittest.TestCase):\n    def test_increment(self):\n        self.assertEqual(increment(1), 2)\n',
            done: true, done_reason: 'length' }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => { persisted.set(key, value); } },
            secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-output',
            paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
                reviewer: { state: 'verified', reason: 'fixed fixture' }, bugFixer: { state: 'verified', reason: 'fixed fixture' } } });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-output',
            filePath: source, funcName: 'increment', promptStrategy: 'auto', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 30, mutationEngine: 'builtin', outputPath: output });
        const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
        const events = artifacts.filter(name => path.basename(name) === 'role_events.jsonl')
            .flatMap(name => fs.readFileSync(path.join(output, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
        assert.equal(requests.filter(request => request.options.num_predict === 1536).length, 1,
            'output-limit failure is not retried as a complete candidate or text-format fallback');
        const writer = events.find(event => event.stage === 'model-request' && event.status === 'requested' && event.detail.role === 'writer');
        assert.ok(writer, 'formal seed request was recorded');
        assert.equal(writer.detail.inputBudget, 6656);
        assert.equal(writer.detail.reservedOutputTokens, 1536);
        assert.equal(writer.detail.requestOutputTokens, 1536);
        assert.ok(events.some(event => event.stage === 'model-request' && event.status === 'error'
            && event.detail.role === 'writer' && event.detail.category === 'model-format'));
        assert.ok(!events.some(event => event.stage === 'model-request' && event.status === 'completed' && event.detail.role === 'writer'));
        assert.ok(!artifacts.some(name => path.basename(name) === 'loop1_test.py'),
            'a valid but truncated prefix never reaches candidate validation or execution');
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
