import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';
import { BUG_FIXER_QUALIFICATION_PROMPT, REVIEWER_QUALIFICATION_PROMPT } from '../llm/roleQualification';

// The optional initialization binding deliberately remains unknown to static
// name analysis, so real execution still proves one passing and one failing case.
const candidate = 'import unittest\nfrom sample import increment\n'
    + 'if __name__ == "optional_test_setup":\n    MISSING_INPUT = 2\nclass Cases(unittest.TestCase):\n'
    + '    def test_existing(self):\n        self.assertEqual(increment(1), 2)\n'
    + '    def test_new(self):\n        self.assertEqual(increment(MISSING_INPUT), 3)\n';
const corrected = candidate.replace('increment(MISSING_INPUT)', 'increment(2)');

test('formal full Writer revision preserves an oversized prior-policy envelope and enforces its paired wire cap', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-revision-output-'));
    const source = path.join(directory, 'sample.py');
    const targetSource = 'def increment(value):\n    # REQUIRED_SOURCE_BEGIN\n    # '
        + 'complete source context '.repeat(500) + '\n    # REQUIRED_SOURCE_END\n    return value + 1\n';
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
        const wire = JSON.parse(String(options?.body));
        const probe = wire.prompt.includes('A safe runtime already provides increment(value)') ? 'writer'
            : wire.prompt.includes(REVIEWER_QUALIFICATION_PROMPT) ? 'reviewer'
                : wire.prompt.includes(BUG_FIXER_QUALIFICATION_PROMPT) ? 'bug-fixer' : undefined;
        assert.equal(wire.system, ' ');
        const request = probe ? { ...wire, roleInstructions: '', transmittedPrompt: wire.prompt, qualificationProbe: probe }
            : readOllamaRoleRequest(wire);
        requests.push(request);
        assert.ok(request.options.num_ctx >= 8192 && request.options.num_ctx <= 16384);
        let response: string;
        let reason: 'stop' | 'length' = 'stop';
        if (probe === 'writer') {
            response = '```python\nimport unittest\nclass TestProbe(unittest.TestCase):\n'
                + '    def test_increment(self):\n        self.assertEqual(increment(1), 2)\n```';
        } else if (probe === 'reviewer') {
            assert.deepEqual(wire.format.required, ['findings']);
            response = '{"findings":[]}';
        } else if (probe === 'bug-fixer') {
            response = '```python\ndef test_increment(self):\n    self.assertEqual(increment(1), 2)\n```';
        } else if (request.roleInstructions.includes('dependency_behaviors')) {
            response = JSON.stringify({ test_strategy: {
                approach: 'Call increment with exact controlled inputs and verify its observed result.' } });
        } else if (request.prompt.startsWith('WRITER_REVISION_REQUEST_V2')) {
            assert.ok(request.options.num_predict === 1536 || request.options.num_predict >= 2560);
            const estimate = estimatePromptTokens(request.transmittedPrompt);
            assert.ok(estimate > 5734, 'the complete formal repair reproduces the former input-budget obstacle');
            assert.ok(estimate <= request.options.num_ctx - request.options.num_predict,
                'the paired output reserve makes the complete unchanged envelope sendable');
            if (request.options.num_predict === 1536) {
                assert.equal(request.options.num_ctx, 8192);
                assert.ok(estimate <= 6656);
            }
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
        return new Response(JSON.stringify({ response, done: true, done_reason: reason,
            ...(reason === 'length' ? { eval_count: 1536, eval_duration: 1_000_000_000,
                prompt_eval_duration: 100_000_000, load_duration: 0, total_duration: 1_100_000_000 } : {}) }), { status: 200 });
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
                assert.equal(revisions.length, completion === 'stop' ? 1 : 2, JSON.stringify({ events: events.filter(event => event.status === 'budget-exceeded'
                    || event.status === 'error' || event.status === 'failed' || event.stage === 'model-runtime').map(event => ({
                        stage: event.stage, status: event.status, category: event.detail?.category,
                        reasonCode: event.detail?.reasonCode, inputBudget: event.detail?.inputBudget,
                        estimatedInputTokens: event.detail?.estimatedInputTokens, contextWindow: event.detail?.contextWindow })), requests: requests.map(request => ({
                    estimate: estimatePromptTokens(request.transmittedPrompt), cap: request.options.num_predict,
                    contextWindow: request.options.num_ctx, qualificationProbe: request.qualificationProbe,
                    revision: request.prompt.startsWith('WRITER_REVISION_REQUEST_V2') })) }));
                const sent = events.find(event => event.stage === 'model-request' && event.status === 'requested'
                    && event.detail.role === 'writer-revision');
                assert.ok(sent);
                assert.equal(sent.detail.inputBudget, 6656);
                assert.equal(sent.detail.reservedOutputTokens, 1536);
                assert.equal(sent.detail.requestOutputTokens, revisions[0].options.num_predict);
                assert.equal(sent.detail.estimatedInputTokens, estimatePromptTokens(revisions[0].transmittedPrompt));
                assert.ok(events.some(event => event.stage === 'validation' && event.status === 'failed'
                    && /test_existing \([^\n)]+\) \.\.\. ok/.test(event.detail.out || '')
                    && /test_new \([^\n)]+\) \.\.\. ERROR/.test(event.detail.out || '')),
                    'real guarded execution supplies a genuinely passing method before the Writer revision');
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
                    assert.equal(revisions[0].options.num_predict, 1536);
                    assert.ok(revisions[1].options.num_predict >= 2560);
                    assert.ok(revisions[1].options.num_ctx > revisions[0].options.num_ctx);
                    assert.equal(revisions[1].transmittedPrompt, revisions[0].transmittedPrompt,
                        'length recovery preserves the complete prior test, source and execution facts');
                    const probes = requests.filter(request => request.qualificationProbe);
                    assert.deepEqual(probes.map(request => request.qualificationProbe), ['writer', 'reviewer', 'bug-fixer']);
                    assert.ok(probes.every(request => request.options.num_ctx === revisions[1].options.num_ctx));
                    assert.ok(events.some(event => event.stage === 'context-qualification' && event.status === 'completed'),
                        'the enlarged capacity must qualify with executable public role fixtures');
                    const attempts = events.filter(event => event.stage === 'model-request' && event.status === 'requested'
                        && event.detail.role === 'writer-revision');
                    assert.equal(attempts.length, 2);
                    assert.equal(attempts[0].detail.stageDeadlineAt, attempts[1].detail.stageDeadlineAt);
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
