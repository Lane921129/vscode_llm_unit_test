import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

async function verifyFocusedWorkflow(truncated: boolean, reviewAccepted = true, repetition: 'none' | 'repair' | 'persistent' | 'shells' = 'none', unknownFixture = false, preferredCompletion = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-seed-output-'));
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, unknownFixture ? 'def increment(value: object):\n    return value.amount\n'
        : 'def increment(value):\n    return value + 1\n');
    const output = path.join(directory, 'result');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const requests: any[] = [];
    let writerAttempts = 0;
    const persisted = new Map<string, unknown>();
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? 8192
                    : key === 'writerSeedPromptMode' ? preferredCompletion ? 'code-completion' : 'instruction' : fallback }),
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
        if (String(_url).endsWith('/api/show')) { return new Response(JSON.stringify({ details: { parameter_size: '70B' }, model_info: { 'general.architecture': 'llama', 'llama.context_length': 2048 } })); }
        if (String(_url).endsWith('/api/ps')) { return new Response(JSON.stringify({ models: [] })); }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        requests.push(request);
        assert.equal(request.options.num_ctx, 8192, 'explicit run capacity stays unchanged');
        if (request.roleInstructions.includes('dependency_behaviors')) {
            assert.notEqual(request.raw, true, 'Writer preference never changes Analyst transport');
            assert.equal(request.options.num_predict, 1024, 'Analyst uses its own short-plan output cap');
            return new Response(JSON.stringify({ response: JSON.stringify({ dependency_behaviors: [],
                test_strategy: { approach: 'Exercise increment with the exact verified observed input and result.' } }),
                done: true, done_reason: 'stop' }), { status: 200 });
        }
        if (request.roleInstructions.includes('You are the test Reviewer')) {
            assert.notEqual(request.raw, true, 'Writer preference never changes Reviewer transport');
            assert.match(request.prompt, /ISOLATED_EXECUTION_PASSED/);
            return Response.json({ response: reviewAccepted ? '{"findings":[]}' : 'invalid review', done: true, done_reason: 'stop' });
        }
        if (unknownFixture) {
            writerAttempts++;
            assert.doesNotMatch(request.prompt, /WRITER_SEED_CASE_FACTS_V1\n\{/);
            assert.match(request.prompt, /Pass execution before expansion; existing output contract\.$/,
                'seed generation and its Writer revision finish with the same bounded phase scope');
            const setup = 'import unittest\nfrom types import SimpleNamespace\nfrom sample import increment\n'
                + 'class Tests(unittest.TestCase):\n    def test_seed(self):\n';
            if (writerAttempts > 1) { assert.match(request.prompt, /one direct target call/); }
            return Response.json({ response: setup
                + '        self.assertEqual(increment(SimpleNamespace(amount=7)), 7)\n'
                + (writerAttempts === 1 ? '        self.assertEqual(increment(SimpleNamespace(amount=8)), 8)\n' : ''),
                done: true, done_reason: 'stop' });
        }
        assert.match(request.prompt, /WRITER_SEED_V1/);
        assert.match(request.transmittedPrompt, /TEST_FOCUS_V1 \(boundary/);
        assert.match(request.prompt, /WRITER_SEED_PACKAGING_V1/);
        assert.match(request.prompt, /from sample import increment/);
        assert.match(request.prompt, /class GeneratedSeedTests\(unittest.TestCase\):\n    def test_seed\(self\):/);
        assert.equal(request.options.num_predict, 4096);
        assert.ok(estimatePromptTokens(request.transmittedPrompt) <= 8192 - request.options.num_predict);
        writerAttempts++;
        if (preferredCompletion && writerAttempts === 1) {
            assert.equal(request.raw, true);
            assert.match(request.transmittedPrompt, /\nclass GeneratedSeedTests\(unittest.TestCase\):\n    def test_seed\(self\):\n$/);
        }
        if (repetition !== 'none') {
            if (writerAttempts === 1 || repetition === 'persistent') {
                const response = repetition === 'shells'
                    ? '```python\nimport unittest\nclass Tests(unittest.TestCase):\n    def test_seed(self):\n        # output not converged\n```\n'.repeat(12)
                    : '# output not converged\n'.repeat(40);
                return Response.json({ response, done: true, done_reason: 'length' });
            }
            assert.match(request.prompt, /WRITER_OUTPUT_FORMAT_REPAIR_V1/);
            assert.match(request.prompt, /value \+ 1/);
            assert.doesNotMatch(request.prompt, /# output not converged/);
            assert.equal(request.raw === true, !preferredCompletion);
            if (!preferredCompletion) { assert.match(request.transmittedPrompt, /\nclass GeneratedSeedTests\(unittest.TestCase\):\n    def test_seed\(self\):\n$/); }
            return Response.json({ response: preferredCompletion
                ? 'import unittest\nfrom sample import increment\nclass Tests(unittest.TestCase):\n    def test_seed(self):\n        self.assertEqual(increment(1), 2)\n'
                : '        self.assertEqual(increment(1), 2)\n',
                done: true, done_reason: truncated ? 'length' : 'stop' });
        }
        if (preferredCompletion) {
            return Response.json({ response: '        self.assertEqual(increment(1), 2)\n', done: true, done_reason: 'stop' });
        }
        return new Response(JSON.stringify({ response: 'import unittest\nfrom sample import increment\n'
            + 'class Tests(unittest.TestCase):\n    def test_increment(self):\n        self.assertEqual(increment(1), 2)\n',
            done: true, done_reason: truncated ? 'length' : 'stop' }), { status: 200 });
    };
    try {
        delete require.cache[require.resolve('../orchestrator')];
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => { persisted.set(key, value); } },
            secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-output',
            paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
            testGenerationReady: truncated, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: truncated ? 'verified' : 'unverified', reason: 'fixed fixture' },
                reviewer: { state: truncated ? 'verified' : 'not-run', reason: 'fixed fixture' }, bugFixer: { state: 'not-run', reason: 'fixed fixture' } } });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-output',
            filePath: source, funcName: 'increment', promptStrategy: 'boundary', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 30, mutationEngine: 'builtin', outputPath: output });
        const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
        const events = artifacts.filter(name => path.basename(name) === 'role_events.jsonl')
            .flatMap(name => fs.readFileSync(path.join(output, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
        assert.equal(requests.filter(request => request.options.num_predict === 4096).length, repetition === 'none' ? 1 : 2,
            'output-limit failure is not retried as a complete candidate or text-format fallback');
        const writer = events.find(event => event.stage === 'model-request' && event.status === 'requested' && event.detail.role === 'writer');
        assert.ok(writer, 'formal seed request was recorded');
        assert.ok(events.some(event => event.stage === 'test-focus'));
        assert.ok(!events.some(event => event.stage === 'tier'));
        const manifestPath = artifacts.find(name => path.basename(name) === 'run_manifest.json')!;
        const manifest = JSON.parse(fs.readFileSync(path.join(output, manifestPath), 'utf8'));
        assert.equal(manifest.report.testFocus, 'boundary');
        assert.equal(writer.detail.inputBudget, 4096);
        assert.equal(writer.detail.reservedOutputTokens, 4096);
        assert.equal(writer.detail.requestOutputTokens, 4096);
        if (preferredCompletion) { assert.equal(writer.detail.writerPromptMode, 'seed-code-completion-v1'); }
        if (unknownFixture) {
            const shape = events.find(event => event.stage === 'writer-seed-input' && event.status === 'rejected');
            assert.equal(shape?.detail.reasonCode, 'writer-seed-call-count');
            assert.equal(shape.detail.literalTargetCallCount, 0);
            assert.equal(shape.detail.syntacticTargetCallCount, 2);
            assert.equal(writerAttempts, 2, 'one Writer shape revision precedes the only executable seed');
            assert.equal(events.filter(event => event.stage === 'validation' && event.status === 'accepted').length, 1);
        }
        if (repetition !== 'none') {
            const failures = events.filter(event => event.stage === 'model-request' && event.status === 'error');
            assert.equal(failures[0].detail.outputDiagnosis, repetition === 'shells' ? 'repetitive-test-shells' : 'repetitive-without-tests');
            assert.equal(failures[0].detail.responsePreview.executable, false);
            assert.ok(failures[0].detail.responsePreview.samples.some((sample: any) => sample.text.includes('output not converged')));
            assert.equal(events.filter(event => event.status === 'output-format-retry').length, 1);
            assert.equal(events.filter(event => event.stage === 'writer-seed' && event.status === 'completion-selected').length, 1);
            assert.ok(!events.some(event => event.status === 'output-budget-grown'));
            const planned = events.find(event => event.status === 'recovery-stage-planned' && event.detail.role === 'writer');
            assert.ok(events.filter(event => event.stage === 'model-request' && event.status === 'requested' && event.detail.role === 'writer')
                .every(event => event.detail.stageDeadlineAt === planned.detail.deadlineAt));
            const failureReport = artifacts.find(name => path.basename(name) === 'failure_report.md' && !name.includes('loop'))!;
            const report = fs.readFileSync(path.join(output, failureReport), 'utf8');
            assert.match(report, /模型輸出失敗診斷|Model output failure diagnostics/);
            assert.match(report, /output not converged/);
            const roundFailure = artifacts.find(name => /loop[\\/]1[\\/]failure_report\.md$/.test(name))!;
            assert.doesNotMatch(fs.readFileSync(path.join(output, roundFailure), 'utf8'),
                /本輪沒有記錄失敗事件|No failure events were recorded/);
        }
        if (!truncated && repetition !== 'persistent') {
            const knowledgePath = artifacts.find(name => path.basename(name) === 'function_knowledge.json')!;
            const knowledge = JSON.parse(fs.readFileSync(path.join(output, knowledgePath), 'utf8'));
            if (!reviewAccepted) {
                assert.notEqual(knowledge.terminalStatus, 'passed');
                assert.ok(!events.some(event => event.stage === 'mutation' && event.status === 'measured'));
                assert.ok(requests.some(request => request.roleInstructions.includes('You are the test Reviewer')));
                return;
            }
            assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
            assert.equal(knowledge.roleQualificationRequired, false);
            assert.ok(events.some(event => event.stage === 'qualification-policy' && event.status === 'optional'));
            assert.ok(!events.some(event => event.detail?.phase === 'context-qualification'));
            assert.equal(knowledge.qualityAssessment.measurementStatus, 'complete');
            assert.equal(knowledge.qualityAssessment.policyStatus, 'met');
            assert.ok(knowledge.mutation.counts.selected > 0);
            assert.equal(knowledge.mutation.counts.executed, knowledge.mutation.counts.selected);
            const mutation = events.find(event => event.stage === 'mutation' && event.status === 'measured');
            assert.ok(mutation, 'the new focus workflow must execute the real mutation engine');
            const approved = events.find(event => event.stage === 'reviewer' && event.status === 'approved');
            assert.ok(approved && approved.sequence < mutation.sequence, 'the same complete candidate is reviewed before mutation');
            assert.ok(artifacts.some(name => path.basename(name) === 'loop1_test.py'));
            return;
        }
        assert.ok(events.some(event => event.stage === 'model-request' && event.status === 'error'
            && event.detail.role === 'writer' && event.detail.category === 'model-format'));
        assert.ok(!events.some(event => event.stage === 'model-request' && event.status === 'completed' && event.detail.role === 'writer'));
        assert.ok(!artifacts.some(name => path.basename(name) === 'loop1_test.py'),
            'a valid but truncated prefix never reaches candidate validation or execution');
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('focused workflow honors manual context beyond metadata and refuses truncated seeds without Tier fallback',
    () => verifyFocusedWorkflow(true));
test('focused workflow executes and reviews a seed before completing real coverage and builtin mutation',
    () => verifyFocusedWorkflow(false));
test('optional qualification never substitutes for actual Reviewer approval before mutation',
    () => verifyFocusedWorkflow(false, false));
test('repetitive Writer output receives one format correction and then completes real review and mutation',
    () => verifyFocusedWorkflow(false, true, 'repair'));
test('repeated test shells use one raw recovery without growing output, then reach execution review and mutation',
    () => verifyFocusedWorkflow(false, true, 'shells'));
test('explicit code completion starts on the first Writer request while Analyst and Reviewer keep instruction transport',
    () => verifyFocusedWorkflow(false, true, 'none', false, true));
test('repetitive preferred code completion falls back once to instruction mode without growing output',
    () => verifyFocusedWorkflow(false, true, 'shells', false, true));
test('a second repetitive Writer output stops without another retry or executing partial output',
    () => verifyFocusedWorkflow(false, true, 'persistent'));
test('a truncated code continuation never becomes a candidate despite its complete-looking assertion',
    () => verifyFocusedWorkflow(true, true, 'repair'));
test('without Trace a multi-call object seed returns to Writer before execution, then completes review and mutation',
    () => verifyFocusedWorkflow(false, true, 'none', true));
