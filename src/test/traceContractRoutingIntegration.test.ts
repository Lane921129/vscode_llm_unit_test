import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture } from './ollamaRequestFixture';
import * as processRunner from '../utils/processRunner';

test('malformed Trace stdout stops the real analysis pipeline before model roles and mutation, even with a valid progress journal', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-contract-routing-'));
    const source = path.join(directory, 'sample.py');
    const sourceText = 'def increment(value: int):\n    return value + 1\n';
    fs.writeFileSync(source, sourceText);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const originalRun = processRunner.runSpawn;
    const handlers = new Map<string, (...args: any[]) => any>(), persisted = new Map<string, unknown>();
    const tools: string[] = [];
    let modelRequests = 0, traceRuns = 0;
    let malformed: 'json' | 'input-plan' = 'json';
    const modelName = 'neutral-trace-contract-routing';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python
                : key === 'runtimeContextTokens' ? 8192 : fallback,
                update: async () => assert.fail('Trace failures must preserve user preferences') }),
            openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName, contextLength: 16384 });
        if (metadata) { return metadata; }
        modelRequests++;
        assert.fail('Invalid tool evidence must not reach Analyst, Writer, Reviewer, or Bug Fixer');
    };
    (processRunner as any).runSpawn = async (...args: Parameters<typeof processRunner.runSpawn>) => {
        const name = path.basename(args[1][0] || '');
        tools.push(name);
        const result = await originalRun(...args);
        if (name !== 'dynamic_tracer.py') { return result; }
        traceRuns++;
        // The actual Python worker completes and writes a valid journal first.
        // Only its stdout wire is corrupted, so recovery cannot conceal a broken contract.
        if (malformed === 'json') { return { ...result, stdout: '{malformed' }; }
        const observations = JSON.parse(result.stdout);
        observations.input_plan.diagnostics = [{ parameter: 42, code: 'budget-exceeded', reason: 'invalid fixture' }];
        return { ...result, stdout: JSON.stringify(observations) };
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => {
                persisted.set(key, value);
            } }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName, paramSize: '13B',
            contextLength: 16384, contextLengthKnown: true, qualificationVersion: QUALIFICATION_VERSION,
            qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 }, testGenerationReady: true,
            testGenerationMode: TEST_GEN_MODE_PYTHON, roleQualification: {
                writer: { state: 'verified', reason: 'public fixture' }, reviewer: { state: 'verified', reason: 'public fixture' },
                bugFixer: { state: 'not-run', reason: 'unused' } } });
        for (malformed of ['json', 'input-plan'] as const) {
            await t.test(malformed, async () => {
                const output = path.join(directory, malformed);
                modelRequests = 0; traceRuns = 0; tools.length = 0;
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName,
                    filePath: source, funcName: 'increment', promptStrategy: 'tier2', validationMode: 'full',
                    maxLoops: 1, timeoutSeconds: 60, mutationEngine: 'builtin', outputPath: output });
                const files = fs.readdirSync(output, { recursive: true }).map(String);
                const artifact = (name: string) => path.join(output, files.find(item => path.basename(item) === name)!);
                const events = fs.readFileSync(artifact('role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const knowledge = JSON.parse(fs.readFileSync(artifact('function_knowledge.json'), 'utf8'));
                assert.equal(traceRuns, 1, 'contract corruption is not retried as missing caller inputs');
                assert.equal(modelRequests, 0);
                assert.equal(knowledge.failureCategory, 'ast-trace');
                assert.equal(knowledge.failureStage, 'trace-contract');
                assert.equal(knowledge.terminalStatus, 'failed');
                assert.equal(knowledge.diagnostic.reasonCode, malformed === 'json' ? 'invalid-json' : 'invalid-input-plan');
                assert.ok(!events.some(event => ['model-request', 'reviewer', 'mutation', 'candidate-validation'].includes(event.stage)));
                assert.ok(!tools.some(name => /mutation|generated_test_runner/.test(name)));
                assert.ok(!files.some(file => path.basename(file) === 'loop1_test.py'));
                assert.ok(fs.readFileSync(artifact('trace_001.jsonl'), 'utf8').includes('run_completed'),
                    'a completed journal cannot turn malformed stdout into accepted evidence');
                assert.equal(fs.readFileSync(source, 'utf8'), sourceText);
            });
        }
    } finally {
        (processRunner as any).runSpawn = originalRun;
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
