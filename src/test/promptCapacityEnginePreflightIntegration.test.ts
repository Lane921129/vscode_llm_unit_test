import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture } from './ollamaRequestFixture';

test('complete role capacity is checked before the selected mutation engine or any model probe', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-capacity-engine-'));
    const source = path.join(directory, 'sample.py');
    // Whole source evidence cannot fit in 2K, independently of optional prompt
    // compaction. AST, environment preflight and controlled Trace stay real.
    const sourceText = 'def increment(value: int):\n'
        + Array.from({ length: 120 }, (_, index) =>
            `    # source evidence ${index}: ${'unchanged source '.repeat(8)}\n`).join('')
        + '    return value + 1\n';
    fs.writeFileSync(source, sourceText);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const processRunner = require('../utils/processRunner'), originalSpawn = processRunner.runSpawn;
    const handlers = new Map<string, (...args: any[]) => any>();
    const persisted = new Map<string, unknown>();
    const logs: string[] = [];
    const modelName = 'neutral-capacity-engine';
    let contextLimit = 2048, configuredContext = 0;
    let engineProbes = 0, generationRequests = 0;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? configuredContext : fallback }),
            openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => {
                if (message.text) { logs.push(message.text); } return true;
            } }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName, contextLength: contextLimit });
        if (metadata) { return metadata; }
        generationRequests++;
        throw new Error('No model transport may start before the chosen engine is usable');
    };
    processRunner.runSpawn = async (command: string, args: string[], options: any) => {
        if (args.some(arg => arg.endsWith('external_mutation_runner.py')) && args.includes('--probe')) {
            engineProbes++;
            return { code: 0, stdout: JSON.stringify({ schemaVersion: 'external-mutation-probe-v1',
                engine: 'mutatest', supported: false, diagnosticCode: 'self-check-failed' }), stderr: '' };
        }
        return originalSpawn(command, args, options);
    };
    const run = async (name: string) => {
        engineProbes = 0; generationRequests = 0;
        const selected = configuredContext || Math.floor(contextLimit / 2);
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName, paramSize: '13B',
            contextLength: contextLimit, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION,
            qualificationRuntime: { version: 'ollama-context-v1', numCtx: selected },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed capacity fixture' },
                reviewer: { state: 'verified', reason: 'fixed capacity fixture' },
                bugFixer: { state: 'unverified', reason: 'not needed' } } });
        const output = path.join(directory, name);
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName,
            filePath: source, funcName: 'increment', promptStrategy: 'tier2', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 30, mutationEngine: 'mutatest', outputPath: output });
        assert.ok(fs.existsSync(output), logs.join('\n'));
        const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
        const artifact = (base: string) => {
            const matches = artifacts.filter(item => path.basename(item) === base);
            assert.equal(matches.length, 1, `one ${base}`);
            return path.join(output, matches[0]);
        };
        const events = fs.readFileSync(artifact('role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const knowledge = JSON.parse(fs.readFileSync(artifact('function_knowledge.json'), 'utf8'));
        assert.ok(events.some(event => event.stage === 'environment' && event.status === 'passed'));
        assert.ok(knowledge.initialTargetObservations?.examples?.length > 0,
            'controlled Python Trace completes before the complete role budget is known: '
                + JSON.stringify({ failure: knowledge.lastFailure,
                    observations: knowledge.initialTargetObservations && {
                        load_error: knowledge.initialTargetObservations.load_error,
                        examples: knowledge.initialTargetObservations.examples?.length,
                        errors: knowledge.initialTargetObservations.errors?.length },
                    events: events.map(event => `${event.stage}:${event.status}`) }));
        assert.equal(knowledge.mutationStatus, 'not-measured');
        assert.equal(knowledge.mutationScore, null);
        assert.equal(knowledge.mutationSelection, undefined);
        assert.equal(generationRequests, 0, 'includes formal roles and capacity qualification probes');
        assert.ok(!events.some(event => event.stage === 'model-request' && event.status === 'requested'));
        assert.equal(fs.readFileSync(source, 'utf8'), sourceText);
        const workflow = fs.readFileSync(artifact('workflow_report.md'), 'utf8');
        return { events, knowledge, workflow };
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => {
                persisted.set(key, value);
            } }, secrets: {}, subscriptions: [] });
        await t.test('a complete prompt beyond the 2K ceiling skips expensive external preflight', async () => {
            contextLimit = 2048; configuredContext = 0;
            const result = await run('insufficient-ceiling');
            assert.equal(result.knowledge.failureStage, 'prompt-budget');
            assert.ok(result.events.some(event => event.stage === 'model-request' && event.status === 'budget-exceeded'));
            assert.equal(engineProbes, 0);
            assert.ok(!result.events.some(event => event.stage === 'mutation-engine'));
            const capacity = result.knowledge.promptCapacity;
            assert.equal(capacity.version, 'prompt-capacity-v1');
            assert.equal(capacity.state, 'model-limit-insufficient');
            assert.equal(capacity.contextWindow, 1024);
            assert.equal(capacity.modelContextLimit, 2048);
            assert.equal(capacity.modelContextLimitSource, 'ollama-show');
            assert.ok(capacity.minimumContextTokens > 2048);
            assert.equal(result.events.find(event => event.stage === 'model-runtime' && event.status === 'selected')
                .detail.modelContextLimit, 2048);
            const rejected = result.events.find(event => event.stage === 'model-request' && event.status === 'budget-exceeded');
            assert.deepEqual(rejected.detail.capacity, capacity);
            assert.match(result.workflow, /2048/);
            assert.ok(result.workflow.includes(String(capacity.minimumContextTokens)), 'the complete workflow shows the calculated requirement');
        });
        await t.test('a fitting prompt probes an unavailable engine once and stops before generation', async () => {
            contextLimit = 32768; configuredContext = 32768;
            const result = await run('unavailable-engine');
            assert.equal(result.knowledge.failureStage, 'mutation-preflight');
            assert.equal(engineProbes, 1);
            assert.equal(result.events.filter(event => event.stage === 'mutation-engine' && event.status === 'failed').length, 1);
            assert.equal(result.knowledge.promptCapacity.state, 'fits-current');
        });
        await t.test('an unavailable engine also stops before newly required capacity qualification', async () => {
            contextLimit = 32768; configuredContext = 1024;
            const result = await run('unavailable-before-qualification');
            assert.equal(result.knowledge.failureStage, 'mutation-preflight');
            assert.equal(engineProbes, 1);
            assert.ok(!result.events.some(event => event.stage === 'context-qualification'));
            assert.ok(!result.events.some(event => event.stage === 'model-runtime' && event.status === 'context-grown'));
        });
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad; processRunner.runSpawn = originalSpawn;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
