import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RUNTIME_CONTEXT_PREFERENCES_KEY, upsertRuntimeContextPreference } from '../llm/runtimeContextPreferences';
import { qualificationEndpointKey } from '../llm/modelQualification';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { currentTargetBudget } from '../pipeline/targetBudget';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('captured capacity recovers a length response using measured input and time without borrowing a model ceiling', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'captured-output-recovery-'));
    const source = path.join(directory, 'sample.py');
    const sourceText = 'def advance(value):\n    return value + 1\n';
    fs.writeFileSync(source, sourceText);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const handlers = new Map<string, (...args: any[]) => any>();
    const persisted = new Map<string, unknown>();
    const model = 'neutral-captured-output';
    persisted.set(RUNTIME_CONTEXT_PREFERENCES_KEY, upsertRuntimeContextPreference([], {
        endpointKey: qualificationEndpointKey('local'), modelName: model
    }, 8192, 'captured-runtime'));
    const complete = 'import unittest\nfrom sample import advance\nclass Cases(unittest.TestCase):\n'
        + '    def test_numbers(self):\n        self.assertEqual(advance(0), 1)\n'
        + '        self.assertEqual(advance(1), 2)\n        self.assertEqual(advance(-1), 0)\n';
    const prefix = 'TRUNCATED_PREFIX_IS_NEVER_A_CANDIDATE';
    let scenario: 'capacity-bound' | 'time-bound' | 'no-headroom' = 'capacity-bound';
    let writers = 0, timeShift = 0;
    const requests: any[] = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback }),
            openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    Date.now = () => originalNow() + timeShift;
    globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/api/show')) { return new Response('{}', { status: 200 }); }
        if (String(url).endsWith('/api/ps')) {
            return new Response(JSON.stringify({ models: [{ name: model, context_length: 8192 }] }), { status: 200 });
        }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        requests.push({ ...request, budget: currentTargetBudget() });
        assert.equal(request.options.num_ctx, 8192, 'unknown model limits never authorize context growth');
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) {
            response = JSON.stringify({ test_strategy: { approach: 'Call advance with verified integer inputs and preserve its observed results.' } });
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            response = '{"findings":[]}';
        } else {
            writers++;
            if (writers === 1) {
                if (scenario === 'time-bound') { timeShift = 46820; }
                return new Response(JSON.stringify({ response: prefix, done: true, done_reason: 'length',
                    prompt_eval_count: scenario === 'no-headroom' ? 6600 : 5729, eval_count: 1536,
                    eval_duration: scenario === 'time-bound' ? 39724791000 : 1000000000,
                    prompt_eval_duration: scenario === 'time-bound' ? 2754897000 : 100000000,
                    load_duration: 6796100, total_duration: scenario === 'time-bound' ? 46769098800 : 1106796100 }), { status: 200 });
            }
            response = complete;
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => { persisted.set(key, value); } },
            secrets: {}, subscriptions: [] });
        for (scenario of ['capacity-bound', 'time-bound', 'no-headroom'] as const) {
            await t.test(scenario, async () => {
                timeShift = 0; writers = 0; requests.length = 0;
                const before = JSON.stringify([persisted.get(RUNTIME_CONTEXT_PREFERENCES_KEY), persisted.get('llmUnitTest.modelProfiles.v1')]);
                const output = path.join(directory, scenario);
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: model,
                    filePath: source, funcName: 'advance', promptStrategy: 'tier1', validationMode: 'full',
                    maxLoops: 1, timeoutSeconds: 60, mutationEngine: 'builtin', outputPath: output });
                const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
                const artifact = (name: string) => path.join(output, artifacts.find(item => path.basename(item) === name)!);
                const events = fs.readFileSync(artifact('role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const knowledge = JSON.parse(fs.readFileSync(artifact('function_knowledge.json'), 'utf8'));
                const formalWriters = requests.filter(request => !request.roleInstructions.includes('dependency_behaviors')
                    && !request.roleInstructions.includes('You are the test Reviewer'));
                assert.equal(JSON.stringify([persisted.get(RUNTIME_CONTEXT_PREFERENCES_KEY), persisted.get('llmUnitTest.modelProfiles.v1')]),
                    before, 'recovery cannot change user preferences or stored profiles');
                assert.equal(fs.readFileSync(source, 'utf8'), sourceText);
                assert.ok(requests.every(request => request.budget === requests[0].budget));
                assert.ok(events.some(event => event.stage === 'model-runtime' && event.status === 'selected'
                    && event.detail.metadataContextKnown === false));
                for (const file of artifacts.filter(item => /\.(?:py|json|jsonl|md)$/.test(item))) {
                    assert.ok(!fs.readFileSync(path.join(output, file), 'utf8').includes(prefix));
                }
                if (scenario === 'no-headroom') {
                    assert.equal(formalWriters.length, 1);
                    assert.ok(events.some(event => event.status === 'output-recovery-blocked' && event.detail.reasonCode === 'no-output-headroom'));
                    assert.ok(!events.some(event => event.stage === 'reviewer' || event.stage === 'mutation'));
                    return;
                }
                assert.equal(formalWriters.length, 2, JSON.stringify(knowledge.lastFailure));
                assert.equal(formalWriters[1].transmittedPrompt, formalWriters[0].transmittedPrompt);
                const cap = formalWriters[1].options.num_predict;
                assert.ok(cap > 1536 && cap <= 2335);
                if (scenario === 'time-bound') { assert.ok(cap < 2335); }
                assert.ok(5729 + cap + 128 <= 8192);
                const attempts = events.filter(event => event.stage === 'model-request' && event.status === 'requested' && event.detail.role === 'writer');
                assert.equal(attempts[1].detail.observedInputTokens, 5729);
                assert.equal(attempts[1].detail.stageDeadlineAt, attempts[0].detail.stageDeadlineAt);
                assert.ok(attempts.every(event => event.detail.deadlineAt <= event.detail.stageDeadlineAt));
                assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
                const approved = events.findIndex(event => event.stage === 'reviewer' && event.status === 'approved');
                const measured = events.findIndex(event => event.stage === 'mutation' && event.status === 'measured');
                assert.ok(approved >= 0 && measured > approved, 'recovered code still needs approval before real mutation');
            });
        }
    } finally {
        Date.now = originalNow; globalThis.fetch = originalFetch; Module._load = originalLoad;
        const resolved = path.resolve(directory);
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(resolved, { recursive: true, force: true });
    }
});
