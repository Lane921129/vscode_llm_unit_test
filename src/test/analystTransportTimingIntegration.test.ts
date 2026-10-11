import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { SEMANTIC_PLAN_RESPONSE_SCHEMA } from '../roles/semanticAnalyzer';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('formal Analyst transport separates Python Writer qualification, correction, fallback and timing through guarded mutation', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analyst-transport-integration-'));
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, 'def increment(value):\n    return value + 1\n');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const originalTimeout = globalThis.setTimeout;
    const handlers = new Map<string, (...args: any[]) => any>();
    const persisted = new Map<string, unknown>();
    const requests: any[] = [];
    const requestTimers: number[] = [];
    let scenario: 'correction' | 'format-rejection' | 'server-error' | 'malformed-envelope' = 'correction';
    let analystAttempts = 0;
    const modelName = 'neutral-transport';
    const metadataMarker = 'PRIVATE_PROVIDER_METADATA_NOT_FOR_JOURNAL';
    const invalidReplyMarker = 'INVALID_REPLY_BODY_NOT_FOR_JOURNAL';
    const plan = JSON.stringify({ test_strategy: {
        approach: 'Exercise increment with verified integer inputs and exact observed return values.',
        input_hints: [], assertion_style: 'assertEqual', mock_needed: false, key_rules: []
    } });
    const code = 'import unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
        + '    def test_verified_integers(self):\n'
        + '        self.assertEqual(increment(0), 1)\n'
        + '        self.assertEqual(increment(1), 2)\n'
        + '        self.assertEqual(increment(2), 3)\n'
        + '        self.assertEqual(increment(-1), 0)\n';
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
    // Observe the production request timer, leaving timers and the clock real.
    // A delayed HTTP rejection must shorten its fallback's remaining allowance.
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (scenario === 'format-rejection' && analystAttempts < 2 && delay !== undefined && delay >= 20_000
            && new Error().stack?.includes('requestLlmApiUnlocked')) { requestTimers.push(delay); }
        return originalTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.fetch = async (_url, options) => {
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        requests.push(request);
        assert.equal(request.options.num_ctx, 8192);
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) {
            analystAttempts++;
            assert.equal(request.options.num_predict, 1024);
            if (scenario === 'format-rejection' && analystAttempts === 1) {
                await new Promise<void>(resolve => originalTimeout(resolve, 40));
                return new Response(metadataMarker, { status: 400 });
            }
            if (scenario === 'server-error') { return new Response(metadataMarker, { status: 500 }); }
            if (scenario === 'malformed-envelope') {
                return new Response(metadataMarker, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            response = scenario === 'correction' && analystAttempts === 1 ? invalidReplyMarker : plan;
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            response = '{"findings":[]}';
        } else if (request.roleInstructions.includes('Analyst after successful')) {
            response = '{"tasks":[]}';
        } else {
            response = code;
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop',
            load_duration: 10_000_000, prompt_eval_duration: 20_000_000,
            eval_duration: 30_000_000, total_duration: 65_000_000,
            prompt_eval_count: 180, eval_count: 40,
            model: metadataMarker, thinking: metadataMarker, apiKey: metadataMarker }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const run = async () => {
        requests.length = 0; requestTimers.length = 0; analystAttempts = 0;
        const output = path.join(directory, `results-${scenario}`);
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName,
            filePath: source, funcName: 'increment', promptStrategy: 'auto', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 30, mutationEngine: 'builtin', outputPath: output });
        const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
        const artifact = (name: string) => {
            const found = artifacts.filter(item => path.basename(item) === name);
            assert.equal(found.length, 1, `one formal ${name} artifact`);
            return path.join(output, found[0]);
        };
        const eventText = fs.readFileSync(artifact('role_events.jsonl'), 'utf8');
        assert.ok(!eventText.includes(metadataMarker), 'provider metadata and HTTP bodies are not journalled');
        assert.ok(!eventText.includes(invalidReplyMarker), 'invalid replies are recorded by safe hash/shape only');
        const events = eventText.trim().split('\n').map(line => JSON.parse(line));
        const knowledge = JSON.parse(fs.readFileSync(artifact('function_knowledge.json'), 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(artifact('run_manifest.json'), 'utf8'));
        assert.equal(manifest.roleContracts.semanticPlan, 'semantic-plan-v3', 'new Analyst request limits have their own role version');
        assert.equal(manifest.evidenceContracts.semanticPlan, 'semantic-plan-v2', 'normalized evidence shape remains compatible');
        return { events, knowledge, artifact };
    };
    const assertMeasured = (result: Awaited<ReturnType<typeof run>>) => {
        assert.equal(result.knowledge.terminalStatus, 'passed', JSON.stringify(result.knowledge.lastFailure));
        assert.equal(result.knowledge.reviewStatus, 'completed');
        assert.equal(result.knowledge.mutationStatus, 'complete');
        assert.equal(result.knowledge.mutationScore, 100);
        assert.equal(result.knowledge.planningHypotheses.schemaVersion, 'semantic-plan-v2');
        const checkpoint = JSON.parse(fs.readFileSync(result.artifact('quality_baseline.json'), 'utf8'));
        assert.equal(checkpoint.codeHash, evidenceHash(checkpoint.code), 'measured tests match the retained checkpoint');
        assert.equal(checkpoint.mutationStatus, 'complete');
        assert.equal(checkpoint.qualityAssessment.fullyPassed, true);
        const reviewer = result.events.findIndex(event => event.stage === 'reviewer' && event.status === 'approved');
        const mutation = result.events.findIndex(event => event.stage === 'mutation' && event.status === 'measured');
        assert.ok(reviewer >= 0 && mutation > reviewer, 'same candidate is reviewed before real builtin mutation');
        assert.equal(result.events[reviewer].detail.approvedCodeHash, checkpoint.codeHash);
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => { persisted.set(key, value); } },
            secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName,
            paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
                reviewer: { state: 'verified', reason: 'fixed fixture' }, bugFixer: { state: 'verified', reason: 'fixed fixture' } } });

        await t.test('one invalid HTTP 200 Analyst reply gets one semantic correction and reaches mutation', async () => {
            scenario = 'correction';
            const result = await run();
            assertMeasured(result);
            const analyst = requests.filter(request => request.roleInstructions.includes('dependency_behaviors'));
            assert.equal(analyst.length, 2, 'no hidden text fallback duplicates a completed invalid reply');
            for (const request of analyst) { assert.deepEqual(request.format, SEMANTIC_PLAN_RESPONSE_SCHEMA); }
            assert.ok(!analyst[0].prompt.includes('SEMANTIC_CONTRACT_REPAIR_V1'));
            assert.match(analyst[1].prompt, /SEMANTIC_CONTRACT_REPAIR_V1/);
            assert.equal(result.events.filter(event => event.stage === 'analyst-planning' && event.status === 'repair-requested').length, 1);
            const writer = requests.find(request => request.prompt.includes('WRITER_SEED_V1'));
            assert.ok(writer && writer.format === undefined && writer.options.num_predict === 1536,
                'Writer remains pure Python while Analyst independently uses JSON schema');
            const timing = result.events.filter(event => event.stage === 'model-request' && event.status === 'timing');
            assert.ok(timing.some(event => event.detail.kind === 'queue' && event.detail.queueWaitMs >= 0));
            const transports = timing.filter(event => event.detail.kind === 'transport');
            assert.equal(transports.length, requests.length);
            for (const { detail } of transports) {
                assert.equal(detail.httpStatus, 200); assert.equal(detail.outcome, 'completed');
                assert.ok(detail.elapsedMs >= 0 && detail.httpWaitMs >= 0 && detail.responseReadMs >= 0);
                assert.deepEqual(detail.ollama, { loadDurationMs: 10, promptEvalDurationMs: 20, evalDurationMs: 30,
                    totalDurationMs: 65, promptEvalCount: 180, evalCount: 40, done: true, completionReason: 'stop' });
                for (const unsafe of ['response', 'thinking', 'model', 'apiKey', 'providerpayload']) {
                    assert.ok(!Object.hasOwn(detail, unsafe) && !Object.hasOwn(detail.ollama, unsafe));
                }
            }
        });

        await t.test('explicit HTTP format rejection removes only transport format and preserves the deadline', async () => {
            scenario = 'format-rejection';
            const result = await run();
            assertMeasured(result);
            const analyst = requests.filter(request => request.roleInstructions.includes('dependency_behaviors'));
            assert.equal(analyst.length, 2);
            assert.deepEqual(analyst[0].format, SEMANTIC_PLAN_RESPONSE_SCHEMA);
            assert.equal(analyst[1].format, undefined);
            assert.equal(analyst[1].transmittedPrompt, analyst[0].transmittedPrompt,
                'fallback retains complete evidence and the JSON output instruction');
            assert.equal(requestTimers.length, 2);
            assert.ok(requestTimers[1] < requestTimers[0] - 20, '40 ms rejection wait is deducted instead of resetting the 30 s timer');
            assert.ok(!result.events.some(event => event.stage === 'analyst-planning' && event.status === 'repair-requested'));
            const transports = result.events.filter(event => event.status === 'timing' && event.detail.role === 'analyst-planning'
                && event.detail.kind === 'transport');
            assert.deepEqual(transports.map(event => event.detail.transportAttempt), [1, 2]);
            assert.deepEqual(transports.map(event => event.detail.httpStatus), [400, 200]);
            assert.ok(Object.values(transports[0].detail.ollama).every(value => value === null));
        });

        await t.test('HTTP 500 gets bounded transport retries without text fallback or semantic correction', async () => {
            scenario = 'server-error';
            const result = await run();
            assert.equal(result.knowledge.terminalStatus, 'failed');
            assert.equal(requests.length, 3);
            for (const request of requests) { assert.deepEqual(request.format, SEMANTIC_PLAN_RESPONSE_SCHEMA); }
            assert.ok(!result.events.some(event => event.stage === 'analyst-planning' && event.status === 'repair-requested'));
            assert.ok(!result.events.some(event => event.stage === 'mutation' && event.status === 'measured'));
            const error = result.events.find(event => event.stage === 'model-request' && event.status === 'error');
            assert.equal(error?.detail.category, 'model-api'); assert.equal(error?.detail.httpStatus, 500);
            const timing = result.events.filter(event => event.status === 'timing' && event.detail.kind === 'transport');
            assert.deepEqual(timing.map(event => event.detail.transportAttempt), [1, 2, 3]);
            assert.ok(timing.every(event => event.detail.outcome === 'http-error' && event.detail.httpStatus === 500));
        });

        await t.test('malformed HTTP 200 provider JSON is one response error with measured body wait', async () => {
            scenario = 'malformed-envelope';
            const result = await run();
            assert.equal(result.knowledge.terminalStatus, 'failed');
            assert.equal(requests.length, 1, 'provider-envelope syntax errors do not trigger transport or role correction');
            assert.deepEqual(requests[0].format, SEMANTIC_PLAN_RESPONSE_SCHEMA);
            assert.ok(!result.events.some(event => event.stage === 'analyst-planning' && event.status === 'repair-requested'));
            assert.ok(!result.events.some(event => event.stage === 'mutation' && event.status === 'measured'));
            const error = result.events.find(event => event.stage === 'model-request' && event.status === 'error');
            assert.equal(error?.detail.category, 'model-format');
            assert.equal(error?.detail.reason, 'model-response: model-format');
            const timing = result.events.filter(event => event.status === 'timing' && event.detail.kind === 'transport');
            assert.equal(timing.length, 1);
            const detail = timing[0].detail;
            assert.equal(detail.transportAttempt, 1); assert.equal(detail.httpStatus, 200);
            assert.equal(detail.outcome, 'response-error');
            assert.ok(detail.httpWaitMs >= 0 && detail.responseReadMs >= 0 && detail.elapsedMs >= detail.responseReadMs);
            assert.ok(Object.values(detail.ollama).every(value => value === null));
        });
    } finally {
        globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
