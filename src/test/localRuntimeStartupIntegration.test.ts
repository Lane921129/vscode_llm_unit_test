import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { qualificationEndpointKey, QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { RUNTIME_CONTEXT_PREFERENCES_KEY } from '../llm/runtimeContextPreferences';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('run startup refreshes stale capacity metadata before formal requests and publishes the same snapshot', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-startup-integration-'));
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, 'def increment(value):\n    return value + 1\n');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const baseUrl = 'http://runtime-fixture:11434', modelName = 'neutral-runtime';
    const endpointKey = qualificationEndpointKey('local', baseUrl);
    const stale = { envType: 'local', modelName, endpointKey, paramSize: 'unknown', contextLength: 4096, contextLengthKnown: false,
        qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
        testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
        roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
            reviewer: { state: 'verified', reason: 'fixed fixture' }, bugFixer: { state: 'verified', reason: 'fixed fixture' } } };
    const persisted = new Map<string, unknown>([['llmUnitTest.modelProfiles.v1', [stale]],
        [RUNTIME_CONTEXT_PREFERENCES_KEY, [{ endpointKey, modelName, tokens: 8192, source: 'captured-runtime' }]]]);
    const originalProfiles = structuredClone(persisted.get('llmUnitTest.modelProfiles.v1'));
    const originalPreferences = structuredClone(persisted.get(RUNTIME_CONTEXT_PREFERENCES_KEY));
    const handlers = new Map<string, (...args: any[]) => any>(), messages: any[] = [], transports: string[] = [], formal: any[] = [];
    let scenario: 'fresh' | 'unavailable' | 'cancel' = 'fresh';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }], getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
            key === 'pythonPath' ? python : key === 'ollamaBaseUrl' ? baseUrl : fallback }), openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_name: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { messages.push(message); return true; } }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    const code = 'import unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
        + '    def test_increment(self):\n        self.assertEqual(increment(1), 2)\n';
    globalThis.fetch = async (url, init) => {
        const endpoint = String(url); transports.push(endpoint.slice(endpoint.lastIndexOf('/')));
        assert.ok(endpoint.startsWith(baseUrl + '/'), 'configured endpoint is frozen for metadata and generation');
        if (endpoint.endsWith('/api/show') || endpoint.endsWith('/api/ps')) {
            if (scenario === 'cancel') { return new Promise<Response>(() => {}); }
            if (scenario === 'unavailable') { return new Response('PRIVATE_RESPONSE_NOT_FOR_LOGS', { status: 503 }); }
            if (endpoint.endsWith('/api/show')) {
                assert.equal(JSON.parse(String(init?.body)).model, modelName);
                return Response.json({ model_info: { 'general.architecture': 'neutral', 'neutral.context_length': 16384 },
                    details: { parameter_size: '13B' }, privateField: 'PRIVATE_RESPONSE_NOT_FOR_LOGS' });
            }
            return Response.json({ models: [] });
        }
        assert.ok(endpoint.endsWith('/api/generate'));
        const request = readOllamaRoleRequest(JSON.parse(String(init?.body))); formal.push(request);
        assert.equal(request.options.num_ctx, 8192);
        const response = request.roleInstructions.includes('dependency_behaviors')
            ? JSON.stringify({ test_strategy: { approach: 'Exercise the source-bound integer input and observed return.',
                input_hints: [], assertion_style: 'assertEqual', mock_needed: false, key_rules: [] } })
            : request.roleInstructions.includes('You are the test Reviewer') ? '{"findings":[]}' : code;
        return Response.json({ response, done: true, done_reason: 'stop' });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => { persisted.set(key, value); } },
            secrets: {}, subscriptions: [] });
        const run = (output: string) => handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName,
            filePath: source, funcName: 'increment', promptStrategy: 'tier2', validationMode: 'full', maxLoops: 1,
            timeoutSeconds: 30, mutationEngine: 'builtin', outputPath: output });
        const reset = () => { messages.length = transports.length = formal.length = 0; };
        const runtime = () => messages.find(item => item.command === 'modelRuntimeContext');
        await t.test('fresh show metadata replaces stale unknown metadata in the actual role snapshot', async () => {
            reset(); scenario = 'fresh';
            const output = path.join(directory, 'fresh'); await run(output);
            assert.ok(fs.existsSync(output), JSON.stringify(messages.filter(item => item.command === 'appendLog')));
            const eventFile = fs.readdirSync(output, { recursive: true }).map(String).find(item => path.basename(item) === 'role_events.jsonl')!;
            const events = fs.readFileSync(path.join(output, eventFile), 'utf8');
            const selected = events.trim().split('\n').map(line => JSON.parse(line)).find(item => item.stage === 'model-runtime' && item.status === 'selected');
            const knowledgeFile = eventFile.replace(/role_events\.jsonl$/, 'function_knowledge.json');
            const knowledge = JSON.parse(fs.readFileSync(path.join(output, knowledgeFile), 'utf8'));
            assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
            assert.equal(knowledge.reviewStatus, 'completed');
            assert.equal(knowledge.mutationStatus, 'complete');
            assert.equal(selected.detail.metadataContextKnown, true);
            assert.equal(selected.detail.contextWindow, 8192);
            assert.equal(runtime().modelLimit, 16384);
            assert.equal(runtime().requestTokens, selected.detail.contextWindow);
            assert.equal(runtime().metadataStatus, 'fresh');
            assert.deepEqual(transports.slice(0, 2).sort(), ['/ps', '/show']);
            assert.equal(transports.filter(item => item === '/show').length, 1);
            assert.equal(formal.length, 3, 'discovery does not generate new qualification or duplicate formal role requests');
            assert.ok(!events.includes('PRIVATE_RESPONSE_NOT_FOR_LOGS'));
            assert.deepEqual(persisted.get('llmUnitTest.modelProfiles.v1'), originalProfiles);
            assert.deepEqual(persisted.get(RUNTIME_CONTEXT_PREFERENCES_KEY), originalPreferences);
        });
        await t.test('unavailable metadata retains captured capacity and manual-role attempt policy with explicit diagnostics', async () => {
            reset(); scenario = 'unavailable'; await run(path.join(directory, 'unavailable'));
            assert.equal(runtime().requestTokens, 8192);
            assert.equal(runtime().modelLimit, undefined);
            assert.equal(runtime().metadataStatus, 'unavailable');
            assert.equal(runtime().metadataDiagnostic.show.reasonCode, 'http-error');
            assert.equal(runtime().metadataDiagnostic.show.httpStatus, 503);
            assert.equal(formal.length, 3);
            assert.ok(!JSON.stringify(messages).includes('PRIVATE_RESPONSE_NOT_FOR_LOGS'));
            assert.deepEqual(persisted.get(RUNTIME_CONTEXT_PREFERENCES_KEY), originalPreferences);
        });
        await t.test('cancelling metadata discovery does not begin a target or publish a prepared selection', async () => {
            reset(); scenario = 'cancel'; const output = path.join(directory, 'cancel');
            const pending = run(output);
            for (let attempt = 0; attempt < 20 && transports.length < 2; attempt++) { await new Promise<void>(resolve => setImmediate(resolve)); }
            assert.equal(transports.length, 2);
            await handlers.get('llm-unit-test.abortTest')!(); await pending;
            assert.equal(formal.length, 0);
            assert.equal(fs.existsSync(output), false);
            assert.equal(runtime(), undefined);
            assert.deepEqual(persisted.get('llmUnitTest.modelProfiles.v1'), originalProfiles);
        });
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
