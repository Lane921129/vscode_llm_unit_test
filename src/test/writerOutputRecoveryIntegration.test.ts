import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { currentTargetBudget } from '../pipeline/targetBudget';
import { evidenceHash } from '../pipeline/analysisJournal';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('formal Writer length recovery resends complete evidence once with paired context and unchanged budget ownership', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-output-recovery-'));
    const source = path.join(directory, 'sample.py');
    const targetSource = 'def increment(value):\n    # REQUIRED_SOURCE_BEGIN\n    # '
        + 'complete source context '.repeat(525) + '\n    # REQUIRED_SOURCE_END\n    return value + 1\n';
    const sourceText = targetSource + Array.from({ length: 18 }, (_, index) =>
        `\ndef caller_${index}():\n    return increment(1)\n`).join('');
    fs.writeFileSync(source, sourceText);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const handlers = new Map<string, (...args: any[]) => any>();
    const persisted = new Map<string, unknown>();
    const requests: any[] = [];
    const prefixMarker = 'LENGTH_PREFIX_MUST_NEVER_BE_SAVED_OR_EXECUTED';
    const markerFile = path.join(directory, 'length-prefix-executed');
    const incomplete = 'import unittest\nfrom pathlib import Path\n'
        + `Path(${JSON.stringify(markerFile.replace(/\\/g, '/'))}).write_text("${prefixMarker}")\n`;
    const complete = 'import unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
        + '    def test_integers(self):\n        self.assertEqual(increment(0), 1)\n'
        + '        self.assertEqual(increment(1), 2)\n        self.assertEqual(increment(-1), 0)\n';
    const probeCode = 'import unittest\nclass TestProbe(unittest.TestCase):\n'
        + '    def test_positive(self):\n        self.assertEqual(increment(1), 2)\n'
        + '    def test_negative(self):\n        self.assertEqual(increment(-1), 0)\n';
    let scenario: 'recover' | 'recover-after-slow-first' | 'repeat-length' | 'first-request-expired' | 'measured-too-slow'
        | 'qualification-consumed-retry' = 'recover';
    let writerCalls = 0;
    let timeShift = 0;
    let writes = 0;
    let qualificationDelayed = false;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? 8192 : fallback,
            update: async () => { assert.fail('output recovery cannot overwrite saved context preferences'); } }),
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
    Date.now = () => originalNow() + timeShift;
    globalThis.fetch = async (_url, options) => {
        const wire = JSON.parse(String(options?.body));
        const probe = wire.prompt.includes('A safe runtime already provides increment(value)')
            || wire.prompt.includes('Review this exact TEST_FILE');
        const request = probe ? { ...wire, roleInstructions: '', transmittedPrompt: wire.prompt } : readOllamaRoleRequest(wire);
        request.targetBudget = currentTargetBudget();
        request.budgetSnapshot = request.targetBudget?.snapshot();
        requests.push(request);
        let response: string;
        let doneReason: 'stop' | 'length' = 'stop';
        if (probe && scenario === 'qualification-consumed-retry' && writerCalls === 1 && !qualificationDelayed) {
            timeShift += 55000;
            qualificationDelayed = true;
        }
        if (wire.prompt.includes('A safe runtime already provides increment(value)')) {
            response = probeCode;
        } else if (wire.prompt.includes('Review this exact TEST_FILE')) {
            assert.deepEqual(wire.format.required, ['findings']);
            response = '{"findings":[]}';
        } else if (request.roleInstructions.includes('dependency_behaviors')) {
            response = JSON.stringify({ test_strategy: { approach: 'Use controlled integer inputs and their verified observations.' } });
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            assert.ok(scenario === 'recover' || scenario === 'recover-after-slow-first',
                'an incomplete Writer response cannot reach actual candidate review');
            response = '{"findings":[]}';
        } else {
            writerCalls++;
            assert.ok(request.prompt.includes(targetSource.trimEnd()), 'the complete selected function survives every request');
            assert.match(request.prompt, /WRITER_SEED_V1/);
            if (writerCalls === 1 || scenario === 'repeat-length') {
                response = incomplete;
                doneReason = 'length';
                if (scenario === 'first-request-expired') { timeShift = 61000; }
                if (scenario === 'recover-after-slow-first') { timeShift = 45000; }
                if (scenario === 'qualification-consumed-retry') { timeShift = 45000; }
                if (scenario === 'measured-too-slow') { timeShift = 270000; }
            } else {
                response = complete;
            }
        }
        const measurements = scenario === 'measured-too-slow' && writerCalls === 1 && doneReason === 'length'
            ? { eval_count: 1536, eval_duration: 270_000_000_000, prompt_eval_duration: 10_000_000_000,
                load_duration: 1_000_000_000, total_duration: 281_000_000_000 }
            : doneReason === 'length' ? { eval_count: 1536, eval_duration: 1_000_000_000,
                prompt_eval_duration: 100_000_000, load_duration: 0, total_duration: 1_100_000_000 } : {};
        return new Response(JSON.stringify({ response, done: true, done_reason: doneReason, ...measurements }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => {
                writes++; persisted.set(key, value);
            } }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-writer-recovery',
            paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed original capacity' },
                reviewer: { state: 'verified', reason: 'fixed original capacity' }, bugFixer: { state: 'not-run', reason: 'not used' } } });
        for (scenario of ['recover', 'recover-after-slow-first', 'repeat-length', 'first-request-expired', 'measured-too-slow', 'qualification-consumed-retry'] as const) {
            await t.test(scenario, async () => {
                timeShift = 0; writerCalls = 0; requests.length = 0; qualificationDelayed = false;
                const savedBefore = JSON.stringify(persisted.get('llmUnitTest.modelProfiles.v1'));
                const writesBefore = writes;
                const output = path.join(directory, scenario);
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-writer-recovery',
                    filePath: source, funcName: 'increment', promptStrategy: 'tier1', validationMode: 'full', maxLoops: 1,
                    timeoutSeconds: scenario === 'measured-too-slow' ? 300 : 60,
                    mutationEngine: 'builtin', outputPath: output });
                const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
                const artifact = (name: string) => path.join(output, artifacts.find(item => path.basename(item) === name)!);
                const events = fs.readFileSync(artifact('role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const knowledge = JSON.parse(fs.readFileSync(artifact('function_knowledge.json'), 'utf8'));
                const writers = requests.filter(request => request.roleInstructions.length > 0
                    && !request.roleInstructions.includes('dependency_behaviors') && !request.roleInstructions.includes('You are the test Reviewer'));
                const budgetOwners = requests.map(request => request.targetBudget);
                assert.ok(budgetOwners[0]);
                assert.ok(budgetOwners.every(budget => budget === budgetOwners[0]), 'the same target budget owns probes, retry, review and mutation');
                const usages = requests.map(request => request.budgetSnapshot.used.logicalRequests);
                assert.ok(usages.every((usage, index) => index === 0 || usage > usages[index - 1]),
                    'every public probe and recovered Writer request consumes the existing logical request counter');
                assert.equal(writes, writesBefore);
                assert.equal(JSON.stringify(persisted.get('llmUnitTest.modelProfiles.v1')), savedBefore);
                assert.equal(fs.existsSync(markerFile), false);
                for (const file of artifacts.filter(item => /\.(?:py|json|jsonl|md)$/.test(item))) {
                    assert.ok(!fs.readFileSync(path.join(output, file), 'utf8').includes(prefixMarker),
                        'a length-stopped provider prefix is never stored as candidate/report evidence: ' + file);
                }
                assert.equal(fs.readFileSync(source, 'utf8'), sourceText);
                if (scenario === 'first-request-expired' || scenario === 'measured-too-slow' || scenario === 'qualification-consumed-retry') {
                    assert.equal(writers.length, 1, 'a retry that cannot fit its allowance is not sent');
                    const blocked = events.find(event => event.stage === 'model-request' && event.status === 'output-recovery-blocked');
                    assert.ok(!events.some(event => event.stage === 'tier' && event.status === 'fallback'));
                    if (scenario === 'measured-too-slow' || scenario === 'qualification-consumed-retry') {
                        assert.ok(blocked);
                        assert.equal(blocked.detail.reasonCode, 'insufficient-output-retry-time');
                        assert.equal(blocked.detail.targetDeadlinePreserved, true);
                        assert.ok(blocked.detail.estimatedRetryMs > blocked.detail.availableMs);
                        if (scenario === 'measured-too-slow') { assert.equal(blocked.detail.availableMs, 300000); }
                        else {
                            assert.ok(qualificationDelayed, 'the new capacity probes consumed the retry allowance');
                            assert.ok(requests.some(request => request.roleInstructions === ''), 'public probes actually ran');
                            assert.ok(blocked.detail.availableMs < 25000);
                        }
                    } else {
                        assert.ok(events.some(event => event.stage === 'model-request' && event.status === 'error'),
                            'the first request remains expired despite a longer reserved stage');
                    }
                    assert.ok(!events.some(event => event.stage === 'reviewer' || event.stage === 'mutation'));
                    assert.notEqual(knowledge.terminalStatus, 'passed');
                    return;
                }
                assert.equal(writers.length, 2, JSON.stringify(events.filter(event => event.status === 'error' || event.status === 'budget-exceeded')));
                assert.equal(writers[1].transmittedPrompt, writers[0].transmittedPrompt, 'retry sends the complete unchanged role and evidence envelope');
                assert.equal(writers[0].options.num_predict, 1536);
                assert.ok(writers[1].options.num_predict >= 2560);
                assert.ok(writers[1].options.num_ctx > writers[0].options.num_ctx,
                    'this long complete prompt requires matching context growth for its larger output reserve');
                assert.ok(writers[1].options.num_ctx <= 16384);
                assert.ok(estimatePromptTokens(writers[1].transmittedPrompt)
                    <= writers[1].options.num_ctx - writers[1].options.num_predict);
                const growth = events.filter(event => event.stage === 'model-request' && event.status === 'output-budget-grown');
                assert.equal(growth.length, 1);
                assert.equal(growth[0].detail.retry, 1);
                assert.equal(growth[0].detail.deadlinePreserved, true);
                const attempts = events.filter(event => event.stage === 'model-request' && event.status === 'requested'
                    && event.detail.role === 'writer' && event.detail.phase !== 'context-qualification');
                assert.equal(attempts.length, 2);
                assert.equal(attempts[0].detail.stageDeadlineAt, attempts[1].detail.stageDeadlineAt,
                    'the second response never renews its original reserved stage');
                assert.ok(attempts.every(event => event.detail.deadlineAt <= event.detail.stageDeadlineAt));
                assert.ok(attempts.every(event => event.detail.stageDeadlineAt <= budgetOwners[0].deadlineAt));
                if (scenario === 'recover-after-slow-first') {
                    assert.ok(attempts[1].detail.deadlineAt - attempts[0].detail.deadlineAt >= 45000,
                        'the pre-reserved recovery attempt has more than the exhausted first request remainder');
                }
                if (scenario === 'repeat-length') {
                    assert.ok(!events.some(event => event.stage === 'reviewer' || event.stage === 'mutation'));
                    assert.notEqual(knowledge.terminalStatus, 'passed');
                } else {
                    assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
                    assert.equal(knowledge.mutationScore, 100);
                    const checkpoint = JSON.parse(fs.readFileSync(artifact('quality_baseline.json'), 'utf8'));
                    assert.equal(checkpoint.codeHash, evidenceHash(checkpoint.code));
                    assert.ok(checkpoint.code.includes(complete.trimEnd()));
                    const approved = events.findIndex(event => event.stage === 'reviewer' && event.status === 'approved');
                    const mutated = events.findIndex(event => event.stage === 'mutation' && event.status === 'measured');
                    assert.ok(approved >= 0 && mutated > approved);
                    assert.equal(events[approved].detail.approvedCodeHash, checkpoint.codeHash);
                }
            });
        }
    } finally {
        Date.now = originalNow; globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
