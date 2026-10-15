import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { SEMANTIC_PLAN_RESPONSE_SCHEMA } from '../roles/semanticAnalyzer';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture, readOllamaRoleRequest } from './ollamaRequestFixture';

test('formal Ollama streams preserve complete role contracts and distinguish partial or stalled HTTP 200 bodies', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-stream-integration-'));
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, 'def increment(value):\n    return value + 1\n');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load;
    const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout;
    const handlers = new Map<string, (...args: any[]) => any>();
    const persisted = new Map<string, unknown>();
    const requests: any[] = [];
    const requestBodies: string[] = [];
    const timerAllowances: number[] = [];
    const modelName = 'neutral-stream-transport';
    const metadataMarker = 'PRIVATE_STREAM_PROVIDER_METADATA_NOT_FOR_JOURNAL';
    const partialMarker = 'PARTIAL_ANALYST_TEXT_MUST_NOT_BECOME_A_CANDIDATE';
    const plan = JSON.stringify({ test_strategy: {
        approach: '分析 verified integer inputs through increment and compare exact observed return values.',
        input_hints: [], assertion_style: 'assertEqual', mock_needed: false, key_rules: []
    } });
    const code = 'import unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
        + '    def test_verified_integers(self):\n'
        + '        self.assertEqual(increment(0), 1)\n'
        + '        self.assertEqual(increment(1), 2)\n'
        + '        self.assertEqual(increment(2), 3)\n'
        + '        self.assertEqual(increment(-1), 0)\n';
    let scenario: 'complete' | 'partial-eof' | 'stalled-body' | 'draining-queue' | 'http-error-cancel-stalls' = 'complete';
    let bodyAborts = 0;
    let nonSuccessBodyCancels = 0;
    let drainingFetchCalls = 0, drainingActive = false;
    let drainingSignal: AbortSignal | undefined;
    let notifyDrainingStarted: (() => void) | undefined;
    let finishDraining: (() => void) | undefined;
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
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (scenario === 'stalled-body' && delay !== undefined && delay >= 20_000
            && new Error().stack?.includes('requestLlmApiUnlocked')) {
            timerAllowances.push(delay);
            // Exercise the real production timeout callback and AbortSignal. Keep
            // Date.now(), the recorded deadline and the target allowance unchanged.
            return originalTimeout(callback, 60, ...args);
        }
        return originalTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    const streamResponse = (answer: string, complete = true) => {
        const middle = Math.max(1, Math.floor(answer.length / 2));
        const records: Record<string, unknown>[] = [
            { response: answer.slice(0, middle), done: false, thinking: metadataMarker, model: metadataMarker },
            { response: answer.slice(middle), done: false, apiKey: metadataMarker }
        ];
        if (complete) {
            records.push({ response: '', done: true, done_reason: 'stop',
                load_duration: 10_000_000, prompt_eval_duration: 20_000_000,
                eval_duration: 30_000_000, total_duration: 65_000_000,
                prompt_eval_count: 180, eval_count: 40, thinking: metadataMarker, providerpayload: metadataMarker });
        }
        const bytes = new TextEncoder().encode(records.map(record => JSON.stringify(record)).join('\n') + '\n');
        const unicode = bytes.findIndex(byte => byte >= 0x80);
        const boundary = unicode >= 0 ? unicode + 1 : Math.floor(bytes.length / 3);
        const chunks = [bytes.slice(0, boundary), bytes.slice(boundary, boundary + 1), bytes.slice(boundary + 1)];
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            for (const chunk of chunks) { controller.enqueue(chunk); }
            controller.close();
        } }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
    };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, {
            modelName, contextLength: 16384, observedContextTokens: 8192
        });
        if (metadata) { return metadata; }
        const actualBody = String(options?.body);
        const wire = JSON.parse(actualBody);
        assert.equal(wire.stream, true, 'formal local generation must request an observable stream');
        const request = readOllamaRoleRequest(wire);
        requests.push(request);
        requestBodies.push(actualBody);
        assert.equal(request.options.num_ctx, 8192);
        if (request.roleInstructions.includes('dependency_behaviors')) {
            assert.deepEqual(request.format, SEMANTIC_PLAN_RESPONSE_SCHEMA);
            assert.equal(request.options.num_predict, 1024);
            if (scenario === 'http-error-cancel-stalls') {
                const response = new Response(metadataMarker, { status: 404 });
                assert.ok(response.body);
                response.body.cancel = () => { nonSuccessBodyCancels++; return new Promise<void>(() => {}); };
                return response;
            }
            if (scenario === 'partial-eof') { return streamResponse(partialMarker, false); }
            if (scenario === 'stalled-body') {
                const signal = options?.signal;
                assert.ok(signal, 'the production deadline must control body reading');
                return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                    const abort = () => { bodyAborts++; controller.error(new DOMException('Body read aborted', 'AbortError')); };
                    if (signal.aborted) { abort(); }
                    else { signal.addEventListener('abort', abort, { once: true }); }
                } }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
            }
            if (scenario === 'draining-queue') {
                drainingFetchCalls++;
                assert.equal(drainingFetchCalls, 1, 'a second run must not overlap the first draining request');
                drainingActive = true;
                drainingSignal = options?.signal ?? undefined;
                return new Promise<Response>(resolve => {
                    finishDraining = () => { drainingActive = false; resolve(streamResponse(plan)); };
                    notifyDrainingStarted?.();
                });
            }
            return streamResponse(plan);
        }
        if (request.roleInstructions.includes('You are the test Reviewer')) { return streamResponse('{"findings":[]}'); }
        if (request.roleInstructions.includes('Analyst after successful')) { return streamResponse('{"tasks":[]}'); }
        return streamResponse(code);
    };
    const run = async (timeoutSeconds = 30) => {
        requests.length = 0; requestBodies.length = 0; timerAllowances.length = 0; bodyAborts = 0;
        const output = path.join(directory, `results-${scenario}`);
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName,
            filePath: source, funcName: 'increment', promptStrategy: 'auto', validationMode: 'full',
            maxLoops: 1, timeoutSeconds, mutationEngine: 'builtin', outputPath: output });
        const files = fs.readdirSync(output, { recursive: true }).map(String);
        const artifact = (name: string) => {
            const found = files.filter(file => path.basename(file) === name);
            assert.equal(found.length, 1, `one formal ${name} artifact`);
            return path.join(output, found[0]);
        };
        const eventText = fs.readFileSync(artifact('role_events.jsonl'), 'utf8');
        const knowledgeText = fs.readFileSync(artifact('function_knowledge.json'), 'utf8');
        assert.equal(eventText.includes(metadataMarker), false, 'provider metadata/thinking must not be journalled');
        assert.equal(knowledgeText.includes(metadataMarker), false);
        assert.equal(eventText.includes(partialMarker), false, 'incomplete response content must not be journalled');
        assert.equal(knowledgeText.includes(partialMarker), false);
        const events = eventText.trim().split('\n').map(line => JSON.parse(line));
        const knowledge = JSON.parse(knowledgeText);
        const progress = events.filter(event => event.stage === 'model-request'
            && event.detail?.version === 'model-request-progress-v1' && event.detail?.role === 'analyst-planning');
        return { events, knowledge, progress, artifact, files, output };
    };
    const assertStoppedBeforeWriter = (result: Awaited<ReturnType<typeof run>>) => {
        assert.equal(result.knowledge.terminalStatus, 'failed');
        assert.equal(requests.length, 1, 'an incomplete transport cannot cause role correction or Writer requests');
        assert.equal(result.events.some(event => event.stage === 'mutation' && event.status === 'measured'), false);
        assert.equal(result.events.some(event => event.stage === 'writer-seed' && event.status === 'accepted'), false);
        const savedCandidates = result.files.filter(file => /quality_baseline|executable_baseline|rejected_candidate/.test(file))
            .filter(file => { const stat = fs.statSync(path.join(result.output, file)); return stat.isFile() && stat.size > 0; });
        assert.deepEqual(savedCandidates, [], 'reserved empty artifact paths are not saved candidates or baselines');
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

        await t.test('split UTF-8 NDJSON reaches real execution, review and guarded builtin mutation', async () => {
            scenario = 'complete';
            const result = await run();
            assert.equal(result.knowledge.terminalStatus, 'passed', JSON.stringify(result.knowledge.lastFailure));
            assert.equal(result.knowledge.reviewStatus, 'completed');
            assert.equal(result.knowledge.mutationStatus, 'complete');
            assert.equal(result.knowledge.mutationScore, 100);
            const analyst = requests.filter(request => request.roleInstructions.includes('dependency_behaviors'));
            assert.equal(analyst.length, 1);
            const analystIndex = requests.findIndex(request => request.roleInstructions.includes('dependency_behaviors'));
            const dispatch = result.progress.find(event => event.detail.phase === 'http-request').detail;
            assert.equal(dispatch.transportAttempt, 1);
            assert.equal(dispatch.requestBodyHash, evidenceHash(requestBodies[analystIndex]),
                'the recorded digest must bind the exact fetch init.body, not a rebuilt prompt');
            assert.equal(dispatch.requestBodyBytes, Buffer.byteLength(requestBodies[analystIndex], 'utf8'));
            const writer = requests.find(request => request.prompt.includes('WRITER_SEED_V1'));
            assert.ok(writer && writer.format === undefined && writer.options.num_predict === 1536);
            assert.match(JSON.stringify(result.knowledge.planningHypotheses), /分析/,
                'a UTF-8 character split between network chunks must survive the formal parser');
            const phases = result.progress.map(event => event.detail.phase);
            for (const phase of ['queued', 'dispatch', 'http-request', 'http-headers', 'first-bytes', 'first-text', 'response-completed']) {
                assert.ok(phases.includes(phase), `${phase} progress must survive journalling`);
            }
            assert.ok(phases.indexOf('http-headers') < phases.indexOf('first-text'));
            assert.ok(phases.indexOf('first-text') < phases.indexOf('response-completed'));
            const terminal = result.progress.find(event => event.detail.phase === 'response-completed').detail;
            assert.equal(terminal.receivedChunks, 3);
            assert.ok(terminal.receivedBytes > 0 && terminal.responseCharacters === plan.length && terminal.firstTextMs >= 0);
            const transport = result.events.find(event => event.status === 'timing' && event.detail.kind === 'transport'
                && event.detail.role === 'analyst-planning').detail;
            assert.equal(transport.httpStatus, 200);
            assert.equal(transport.outcome, 'completed');
            assert.equal(transport.ollama.evalCount, 40);
            assert.equal(transport.ollama.promptEvalCount, 180);
            const checkpoint = JSON.parse(fs.readFileSync(result.artifact('quality_baseline.json'), 'utf8'));
            assert.equal(checkpoint.codeHash, evidenceHash(checkpoint.code));
            assert.equal(checkpoint.qualityAssessment.fullyPassed, true);
            const review = result.events.findIndex(event => event.stage === 'reviewer' && event.status === 'approved');
            const mutation = result.events.findIndex(event => event.stage === 'mutation' && event.status === 'measured');
            assert.ok(review >= 0 && mutation > review);
            assert.equal(result.events[review].detail.approvedCodeHash, checkpoint.codeHash);
        });
        await t.test('HTTP 200 partial text without done is rejected before Writer or mutation', async () => {
            scenario = 'partial-eof';
            const result = await run();
            assertStoppedBeforeWriter(result);
            assert.equal(result.knowledge.failureCategory, 'model-format');
            const phases = result.progress.map(event => event.detail.phase);
            assert.ok(phases.includes('http-headers') && phases.includes('first-text'));
            assert.equal(phases.includes('response-completed'), false);
            const transport = result.events.find(event => event.status === 'timing' && event.detail.kind === 'transport').detail;
            assert.equal(transport.httpStatus, 200);
            assert.equal(transport.outcome, 'response-error');
            assert.ok(transport.httpWaitMs >= 0 && transport.responseReadMs >= 0);
            assert.ok(Object.values(transport.ollama).every(value => value === null));
        });
        await t.test('headers followed by a hanging body consume the original request timer and report response-read', async () => {
            scenario = 'stalled-body';
            const result = await run();
            assertStoppedBeforeWriter(result);
            assert.equal(result.knowledge.failureCategory, 'timeout');
            assert.equal(bodyAborts, 1);
            assert.equal(timerAllowances.length, 1);
            assert.ok(timerAllowances[0] >= 20_000 && timerAllowances[0] <= 30_000,
                'the intercepted production timer must retain its real original allowance');
            const phases = result.progress.map(event => event.detail.phase);
            assert.ok(phases.includes('http-headers'));
            assert.equal(phases.includes('first-text'), false);
            assert.equal(phases.includes('response-completed'), false);
            const error = result.events.find(event => event.stage === 'model-request' && event.status === 'error');
            assert.equal(error.detail.phase, 'response-read');
            const transport = result.events.find(event => event.status === 'timing' && event.detail.kind === 'transport').detail;
            assert.equal(transport.httpStatus, 200);
            assert.equal(transport.outcome, 'timeout');
            assert.ok(transport.httpWaitMs >= 0 && transport.responseReadMs >= 0);
            assert.ok(Object.values(transport.ollama).every(value => value === null));
        });
        await t.test('a new execution expires in queue without HTTP while cancelled old transport is still draining', async () => {
            scenario = 'draining-queue';
            drainingFetchCalls = 0;
            const started = new Promise<void>(resolve => { notifyDrainingStarted = resolve; });
            const oldOutput = path.join(directory, 'results-draining-old');
            const oldRun = handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName,
                filePath: source, funcName: 'increment', promptStrategy: 'auto', validationMode: 'full',
                maxLoops: 1, timeoutSeconds: 30, mutationEngine: 'builtin', outputPath: oldOutput });
            await started;
            assert.equal(drainingActive, true);
            assert.equal(drainingSignal?.aborted, false);
            handlers.get('llm-unit-test.abortTest')!();
            assert.equal(drainingSignal?.aborted, true, 'the old execution really receives its cancellation');
            try {
                // This explicit 0.1-second role allowance uses the real clock and
                // original absolute deadline. No queue timer is shortened or mocked.
                const result = await run(0.1);
                assert.equal(result.knowledge.terminalStatus, 'failed');
                assert.equal(result.knowledge.failureCategory, 'timeout');
                assert.equal(result.knowledge.failureStage, 'model-request');
                assert.equal(drainingActive, true, 'the cancelled old request has not settled yet');
                assert.equal(drainingFetchCalls, 1);
                assert.equal(requests.length, 0, 'the new execution never calls fetch');
                assert.equal(result.knowledge.targetBudget.used.logicalRequests, 1);
                assert.equal(result.knowledge.targetBudget.used.transportAttempts, 0);
                assert.equal(result.knowledge.targetBudget.used.candidateAttempts, 0);
                const phases = result.progress.map(event => event.detail.phase);
                assert.ok(phases.includes('queued') && phases.includes('queue-timeout'));
                assert.equal(phases.includes('dispatch'), false);
                assert.equal(phases.includes('http-request'), false);
                const error = result.events.find(event => event.stage === 'model-request' && event.status === 'error');
                assert.equal(error.detail.phase, 'queue');
                assert.equal(error.detail.transportStarted, false);
                assert.equal(error.detail.reasonCode, 'queue-timeout');
                assert.ok(result.events.some(event => event.status === 'timing'
                    && event.detail.kind === 'queue' && event.detail.queueWaitMs >= 0));
                assert.equal(result.events.some(event => event.status === 'timing' && event.detail.kind === 'transport'), false);
            } finally {
                finishDraining?.();
                await oldRun;
                notifyDrainingStarted = undefined; finishDraining = undefined;
            }
            assert.equal(drainingActive, false);
            assert.equal(drainingFetchCalls, 1, 'the expired queued task stays skipped after old transport settles');
        });
        await t.test('HTTP 404 failure is reported even when cancelling its unused body never settles', { timeout: 15_000 }, async () => {
            scenario = 'http-error-cancel-stalls';
            nonSuccessBodyCancels = 0;
            const result = await run();
            assertStoppedBeforeWriter(result);
            assert.equal(nonSuccessBodyCancels, 1, 'the unused HTTP error body is still told to cancel');
            assert.equal(result.knowledge.failureCategory, 'model-api');
            const error = result.events.find(event => event.stage === 'model-request' && event.status === 'error');
            assert.equal(error.detail.httpStatus, 404);
            const transport = result.events.find(event => event.status === 'timing' && event.detail.kind === 'transport').detail;
            assert.equal(transport.httpStatus, 404);
            assert.equal(transport.outcome, 'http-error');
            assert.equal(result.events.some(event => event.stage === 'analyst-planning' && event.status === 'repair-requested'), false);
            assert.equal(result.progress.some(event => event.detail.phase === 'http-headers'), true);
            assert.equal(result.progress.some(event => event.detail.phase === 'first-text'), false);
            assert.equal(result.progress.some(event => event.detail.phase === 'response-completed'), false);
        });
    } finally {
        globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
