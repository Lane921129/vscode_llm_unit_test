import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('formal requests bind context, qualification and whole-file settings to one run snapshot', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-context-'));
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, 'def first(value):\n    return value + 1\ndef second(value):\n    return value - 1\n');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const persisted = new Map<string, unknown>();
    let setting: unknown = 8192;
    let changeDuringRequest = true;
    const requests: Array<{ role: string; numCtx?: number }> = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? setting : fallback }),
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
        const body = JSON.parse(String(options?.body));
        if (body.contents) {
            requests.push({ role: 'cloud' });
            return new Response('fixed transport stop', { status: 400 });
        }
        const request = readOllamaRoleRequest(body);
        const role = request.roleInstructions.includes('dependency_behaviors') ? 'analyst' : 'writer';
        requests.push({ role, numCtx: request.options.num_ctx });
        if (changeDuringRequest) { setting = 16384; changeDuringRequest = false; }
        if (role === 'analyst') {
            return new Response(JSON.stringify({ response: JSON.stringify({ dependency_behaviors: [],
                test_strategy: { approach: 'Exercise the selected target using the verified observations.' } }) }), { status: 200 });
        }
        return new Response('fixed transport stop', { status: 400 });
    };
    const profile = (numCtx: number, extra: object = {}) => ({ envType: 'local', modelName: 'neutral-context',
        paramSize: '3B', contextLength: 32768, contextLengthKnown: true,
        qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx },
        testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
        roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
            reviewer: { state: 'verified', reason: 'fixed fixture' }, bugFixer: { state: 'verified', reason: 'fixed fixture' } },
        ...extra });
    const knowledge = (root: string): any[] => fs.readdirSync(root, { recursive: true }).map(String)
        .filter(name => path.basename(name) === 'function_knowledge.json')
        .map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
    const events = (root: string): any[] => fs.readdirSync(root, { recursive: true }).map(String)
        .filter(name => path.basename(name) === 'role_events.jsonl')
        .flatMap(name => fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => { persisted.set(key, value); } },
            secrets: {}, subscriptions: [] });
        const update = handlers.get('llm-unit-test.updateModelProfile')!;
        const run = handlers.get('llm-unit-test.runCaptureAndTest')!;
        update(profile(8192));
        const stored = persisted.get('llmUnitTest.modelProfiles.v1') as any[];
        assert.equal(stored[0].contextLengthKnown, true);
        assert.deepEqual(stored[0].qualificationRuntime, { version: 'ollama-context-v1', numCtx: 8192 });
        const params = { envType: 'local', modelName: 'neutral-context', filePath: source, funcName: 'first',
            promptStrategy: 'auto', validationMode: 'full', maxLoops: 1, timeoutSeconds: 30, mutationEngine: 'builtin' };
        const initial = path.join(directory, 'initial');
        await run({ ...params, funcName: '', outputPath: initial });
        assert.equal(knowledge(initial).length, 2, 'whole-file entry runs both discovered functions');
        assert.equal(requests.filter(row => row.role === 'writer').length, 2);
        assert.ok(requests.length >= 4 && requests.every(row => row.numCtx === 8192));
        const initialMetrics = events(initial).filter(row => row.stage === 'model-request' && row.status === 'requested');
        assert.ok(initialMetrics.length >= 4 && initialMetrics.every(row => row.detail.inputBudget === 5734));
        assert.equal(setting, 16384);

        requests.length = 0;
        const changed = path.join(directory, 'changed');
        await run({ ...params, outputPath: changed });
        assert.equal(requests.length, 0, 'an old context cannot authorize Auto in the next run');
        assert.equal(knowledge(changed)[0].failureStage, 'role-qualification');
        assert.equal(knowledge(changed)[0].roleQualification, null);
        assert.ok(events(changed).some(row => row.stage === 'model-runtime'
            && row.detail.contextWindow === 16384 && row.detail.qualificationApplicable === false));

        update(profile(16384, { testGenerationReady: false }));
        const contradictory = path.join(directory, 'contradictory');
        await run({ ...params, outputPath: contradictory });
        assert.equal(requests.length, 0, 'a failed Writer result cannot borrow a stale verified role flag');
        assert.equal(knowledge(contradictory)[0].failureStage, 'role-qualification');

        update(profile(16384));
        const rebound = path.join(directory, 'rebound');
        await run({ ...params, outputPath: rebound });
        assert.ok(requests.length >= 2 && requests.every(row => row.numCtx === 16384));
        assert.ok(events(rebound).filter(row => row.stage === 'model-request' && row.status === 'requested')
            .every(row => row.detail.inputBudget === 11468));
        requests.length = 0;

        for (const [value, known, reason] of [[32769, true, 'runtime-context-exceeds-model-limit'],
            [8192, false, 'runtime-context-metadata-required'], [-1, true, 'invalid-runtime-context']] as const) {
            setting = value; update(profile(16384, { contextLengthKnown: known }));
            const output = path.join(directory, reason);
            await run({ ...params, outputPath: output });
            assert.equal(requests.length, 0);
            assert.equal(knowledge(output)[0].failureStage, 'model-runtime');
            assert.ok(events(output).some(row => row.detail?.diagnostic?.reasonCode === reason
                || row.detail?.reasonCode === reason), reason);
        }

        setting = -1;
        update({ ...profile(16384), envType: 'cloud', modelName: 'neutral-cloud', paramSize: 'Cloud',
            qualificationRuntime: undefined, contextLengthKnown: undefined });
        const cloud = path.join(directory, 'cloud');
        await run({ ...params, envType: 'cloud', modelName: 'neutral-cloud', cloudKey: 'neutral-fixture-value', outputPath: cloud });
        assert.ok(requests.some(row => row.role === 'cloud'), 'local configuration does not block Cloud requests');
        assert.notEqual(knowledge(cloud)[0].failureStage, 'model-runtime');
    } finally {
        globalThis.fetch = originalFetch;
        Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
