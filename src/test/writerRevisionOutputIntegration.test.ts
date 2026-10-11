import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

const candidate = 'import unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
    + '    def test_existing(self):\n        self.assertEqual(increment(1), 2)\n'
    + '    def test_new(self):\n        self.assertEqual(increment(MISSING_INPUT), 3)\n';
const corrected = candidate.replace('increment(MISSING_INPUT)', 'increment(2)');

test('formal full Writer revision preserves an oversized prior-policy envelope and enforces its paired wire cap', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-revision-output-'));
    const source = path.join(directory, 'sample.py');
    const targetSource = 'def increment(value):\n    # REQUIRED_SOURCE_BEGIN\n    # '
        + 'complete source context '.repeat(525) + '\n    # REQUIRED_SOURCE_END\n    return value + 1\n';
    // Caller setup is required Writer evidence; Reviewer does not receive the
    // caller inventory again. Retain complete identical-input sites in a group.
    const completeSource = targetSource + Array.from({ length: 18 }, (_, index) =>
        `\ndef caller_${index}():\n    return increment(1)\n`).join('');
    fs.writeFileSync(source, completeSource);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const requests: any[] = [];
    let completion: 'stop' | 'length' = 'stop';
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
        assert.equal(request.options.num_ctx, 8192);
        let response: string;
        let reason: 'stop' | 'length' = 'stop';
        if (request.roleInstructions.includes('dependency_behaviors')) {
            response = JSON.stringify({ test_strategy: {
                approach: 'Call increment with exact controlled inputs and verify its observed result.' } });
        } else if (request.prompt.startsWith('WRITER_REVISION_REQUEST_V2')) {
            assert.equal(request.options.num_predict, 1536);
            const estimate = estimatePromptTokens(request.transmittedPrompt);
            assert.ok(estimate > 5734, 'the complete formal repair reproduces the former input-budget obstacle');
            assert.ok(estimate <= 6656, 'the paired output reserve makes this unchanged envelope sendable');
            assert.equal(request.prompt.split(candidate).length - 1, 1);
            assert.ok(request.prompt.includes(targetSource.trimEnd()), 'the complete target source survives');
            assert.match(request.prompt, /NameError|undefined name/);
            assert.match(request.prompt, /VERIFIED OBSERVATIONS/);
            assert.doesNotMatch(request.prompt, /WRITER_SEED_V1/);
            response = '```python\n' + corrected + '\n```';
            reason = completion;
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            assert.equal(completion, 'stop', 'a length-stopped repair cannot reach Reviewer');
            response = '{"findings":[]}';
        } else {
            assert.match(request.prompt, /WRITER_SEED_V1/);
            response = '```python\n' + candidate + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: reason }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-revision-output',
            paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
                reviewer: { state: 'verified', reason: 'fixed fixture' }, bugFixer: { state: 'verified', reason: 'fixed fixture' } } });
        for (completion of ['stop', 'length'] as const) {
            await t.test(completion, async () => {
                requests.length = 0;
                const output = path.join(directory, completion);
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-revision-output',
                    filePath: source, funcName: 'increment', promptStrategy: 'tier1', validationMode: 'full',
                    maxLoops: 1, timeoutSeconds: 45, mutationEngine: 'builtin', mutpyTimeout: 20, outputPath: output });
                const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
                const events = artifacts.filter(name => path.basename(name) === 'role_events.jsonl')
                    .flatMap(name => fs.readFileSync(path.join(output, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
                const revisions = requests.filter(request => request.prompt.startsWith('WRITER_REVISION_REQUEST_V2'));
                assert.equal(revisions.length, 1, JSON.stringify(events.filter(event => event.status === 'budget-exceeded'
                    || event.status === 'error' || event.status === 'failed')));
                const sent = events.find(event => event.stage === 'model-request' && event.status === 'requested'
                    && event.detail.role === 'writer-revision');
                assert.ok(sent);
                assert.equal(sent.detail.inputBudget, 6656);
                assert.equal(sent.detail.reservedOutputTokens, 1536);
                assert.equal(sent.detail.requestOutputTokens, revisions[0].options.num_predict);
                assert.equal(sent.detail.estimatedInputTokens, estimatePromptTokens(revisions[0].transmittedPrompt));
                if (completion === 'stop') {
                    assert.ok(!events.some(event => event.stage === 'passing-tests' && event.status === 'preservation-rejected'));
                    const savedTests = artifacts.filter(name => /^(?:loop\d+_test|test)\.py$/.test(path.basename(name)))
                        .map(name => fs.readFileSync(path.join(output, name), 'utf8'));
                    assert.ok(savedTests.some(saved => saved.includes(corrected.trimEnd())),
                        'the actually saved corrected suite retains the original passing method verbatim');
                    assert.ok(events.some(event => event.stage === 'reviewer' && event.status === 'approved'),
                        JSON.stringify(events.filter(event => event.stage === 'reviewer' || event.status === 'budget-exceeded')));
                    assert.ok(events.some(event => event.stage === 'mutation' && event.status === 'measured'));
                } else {
                    assert.ok(events.some(event => event.stage === 'model-request' && event.status === 'error'
                        && event.detail.role === 'writer-revision' && event.detail.category === 'model-format'));
                    assert.ok(!events.some(event => event.stage === 'reviewer' || event.stage === 'mutation'));
                    assert.ok(!events.some(event => event.stage === 'model-request' && event.status === 'completed'
                        && event.detail.role === 'writer-revision'));
                }
                assert.equal(fs.readFileSync(source, 'utf8'), completeSource, 'the real target is unchanged');
            });
        }
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
