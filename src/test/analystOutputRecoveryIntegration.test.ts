import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { currentTargetBudget } from '../pipeline/targetBudget';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture, readObservedSeedCaseForModelFixture, readOllamaRoleRequest } from './ollamaRequestFixture';

test('Analyst length recovery keeps complete evidence, separate output floors and the original deadline', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analyst-output-recovery-'));
    const source = path.join(directory, 'sample.py');
    const sourceText = 'def increment(value: int):\n    return value + 1\n';
    fs.writeFileSync(source, sourceText);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch, originalNow = Date.now;
    const handlers = new Map<string, (...args: any[]) => any>(), persisted = new Map<string, unknown>();
    const requests: any[] = [];
    const marker = 'TRUNCATED_ANALYST_PREFIX_MUST_NOT_BE_PERSISTED';
    let scenario: 'recover' | 'repeat-length' | 'missing-counts' | 'expired' = 'recover';
    let analystCalls = 0, timeShift = 0, writes = 0;
    const modelName = 'neutral-analyst-recovery';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python
                : key === 'runtimeContextTokens' ? 8192 : fallback,
            update: async () => assert.fail('recovery must preserve user preferences') }), openTextDocument: async () => ({}) },
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
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName, contextLength: 16384 });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        request.owner = currentTargetBudget();
        request.used = request.owner?.snapshot().used.logicalRequests;
        requests.push(request);
        assert.equal(request.options.num_ctx, 8192, 'same-capacity output growth needs no new allocation');
        let response: string, reason = 'stop';
        if (request.roleInstructions.includes('dependency_behaviors')) {
            analystCalls++;
            assert.ok(request.prompt.includes(sourceText.trimEnd()), 'all selected source survives');
            if (analystCalls === 1 || scenario === 'repeat-length') {
                response = marker;
                reason = 'length';
                if (scenario === 'expired') { timeShift += 61000; }
            } else {
                response = JSON.stringify({ test_strategy: { approach: 'Call increment with the observed input and assert its observed result.' } });
            }
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            assert.equal(scenario, 'recover', 'truncated analysis cannot reach review');
            response = '{"findings":[]}';
        } else {
            assert.equal(scenario, 'recover', 'truncated analysis cannot reach Writer');
            assert.equal(request.options.num_predict, 1536, 'Analyst floor cannot leak into Writer seed');
            const observed = readObservedSeedCaseForModelFixture(request.prompt, 'increment');
            assert.ok(observed, 'the host must provide a selected executable seed observation');
            response = 'import unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
                + (observed.observedOutcome === 'returned'
                    ? `    def test_observed(self):\n        self.assertEqual(increment(${observed.args.join(', ')}), ${observed.observedResult})\n`
                    : `    def test_observed(self):\n        with self.assertRaises(${observed.exception!.qualname}):\n            increment(${observed.args.join(', ')})\n`);
        }
        const measurements = reason === 'length' && scenario !== 'missing-counts'
            ? { eval_count: request.options.num_predict, eval_duration: 1_000_000_000,
                prompt_eval_count: 1000, prompt_eval_duration: 100_000_000,
                load_duration: 0, total_duration: 1_100_000_000 } : {};
        return new Response(JSON.stringify({ response, done: true, done_reason: reason, ...measurements }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => {
                writes++; persisted.set(key, value);
            } }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName, paramSize: '70B',
            contextLength: 16384, contextLengthKnown: true, qualificationVersion: QUALIFICATION_VERSION,
            qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 }, testGenerationReady: true,
            testGenerationMode: TEST_GEN_MODE_PYTHON, roleQualification: {
                writer: { state: 'verified', reason: 'public fixture' }, reviewer: { state: 'verified', reason: 'public fixture' },
                bugFixer: { state: 'not-run', reason: 'unused' } } });
        for (scenario of ['recover', 'repeat-length', 'missing-counts', 'expired'] as const) {
            await t.test(scenario, async () => {
                analystCalls = 0; timeShift = 0; requests.length = 0;
                const output = path.join(directory, scenario), beforeWrites = writes;
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName,
                    filePath: source, funcName: 'increment', promptStrategy: 'tier1', validationMode: 'full',
                    maxLoops: 1, timeoutSeconds: 60, mutationEngine: 'builtin', outputPath: output });
                const files = fs.readdirSync(output, { recursive: true }).map(String);
                const artifact = (name: string) => path.join(output, files.find(item => path.basename(item) === name)!);
                const events = fs.readFileSync(artifact('role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const knowledge = JSON.parse(fs.readFileSync(artifact('function_knowledge.json'), 'utf8'));
                assert.equal(writes, beforeWrites);
                assert.equal(fs.readFileSync(source, 'utf8'), sourceText);
                assert.ok(requests.every(request => request.owner === requests[0].owner));
                assert.ok(requests.every((request, i) => !i || request.used > requests[i - 1].used),
                    JSON.stringify({ requests: requests.map(request => ({ used: request.used,
                        cap: request.options.num_predict, analyst: request.roleInstructions.includes('dependency_behaviors') })),
                    failure: knowledge.lastFailure }));
                for (const file of files.filter(item => /\.(py|json|jsonl|md)$/.test(item))) {
                    assert.ok(!fs.readFileSync(path.join(output, file), 'utf8').includes(marker), 'never persist the truncated plan');
                }
                const analysts = requests.filter(request => request.roleInstructions.includes('dependency_behaviors'));
                assert.equal(analysts[0].options.num_predict, 1024);
                if (scenario === 'recover' || scenario === 'repeat-length') {
                    assert.equal(analysts.length, 2, 'at most one output recovery');
                    assert.equal(analysts[1].transmittedPrompt, analysts[0].transmittedPrompt);
                    assert.equal(analysts[1].options.num_predict, 2048);
                    const attempts = events.filter(event => event.stage === 'model-request' && event.status === 'requested'
                        && event.detail.role === 'analyst-planning');
                    assert.equal(attempts[0].detail.stageDeadlineAt, attempts[1].detail.stageDeadlineAt);
                    assert.ok(attempts.every(event => event.detail.deadlineAt <= event.detail.stageDeadlineAt));
                    assert.ok(attempts.every(event => event.detail.stageDeadlineAt <= requests[0].owner.deadlineAt));
                    assert.ok(events.some(event => event.status === 'output-budget-grown' && event.detail.role === 'analyst-planning'));
                } else { assert.equal(analysts.length, 1); }
                if (scenario === 'recover') {
                    assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
                    assert.equal(knowledge.mutationScore, 100);
                    const approved = events.findIndex(event => event.stage === 'reviewer' && event.status === 'approved');
                    const mutated = events.findIndex(event => event.stage === 'mutation' && event.status === 'measured');
                    assert.ok(approved >= 0 && mutated > approved);
                } else {
                    assert.notEqual(knowledge.terminalStatus, 'passed');
                    assert.ok(!events.some(event => event.stage === 'reviewer' || event.stage === 'mutation'));
                    assert.ok(!files.some(file => path.basename(file) === 'loop1_test.py'));
                }
            });
        }
    } finally {
        Date.now = originalNow; globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
