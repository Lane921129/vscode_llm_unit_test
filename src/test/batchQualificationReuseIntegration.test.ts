import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resultDataDirectory } from '../pipeline/resultLayout';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('real batch keeps manual qualification policy, reuses exact grown runtime, and requires actual review before mutation', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-qualification-reuse-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const sourceText = 'def advance(value):\n    # FULL_REQUIRED_SOURCE_MARKER\n'
        + Array.from({ length: 90 }, (_, i) => `    # source note ${i}: ${'unchanged evidence '.repeat(4)}\n`).join('')
        + '    return value + 1\n';
    for (const module of ['sample_a', 'sample_b']) { fs.writeFileSync(path.join(project, module + '.py'), sourceText); }
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const persisted = new Map<string, unknown>();
    const requests: any[] = [];
    const writes: string[] = [];
    let rejectActualReviewer = false;
    const probeCode = 'import unittest\nclass TestProbe(unittest.TestCase):\n'
        + '    def test_positive(self):\n        self.assertEqual(increment(1), 2)\n'
        + '    def test_negative(self):\n        self.assertEqual(increment(-1), 0)\n';
    const vscode = {
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: project } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? 4096 : fallback,
            update: async () => { assert.fail('batch growth cannot overwrite saved settings'); } }),
            openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {},
        showQuickPick: async (items: any[]) => items.filter(item => item.picked),
        showWarningMessage: async () => '繼續測試並記錄失敗' },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }, env: { openExternal: async () => true }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    globalThis.fetch = async (_url, options) => {
        const wire = JSON.parse(String(options?.body));
        const probe = wire.prompt.includes('A safe runtime already provides increment(value)')
            || wire.prompt.includes('Review this exact TEST_FILE');
        assert.equal(wire.system, ' ');
        const request = probe ? { ...wire, roleInstructions: '', transmittedPrompt: wire.prompt } : readOllamaRoleRequest(wire);
        requests.push(request);
        let response: string;
        if (wire.prompt.includes('A safe runtime already provides increment(value)')) {
            response = probeCode;
        } else if (wire.prompt.includes('Review this exact TEST_FILE')) {
            assert.deepEqual(wire.format.required, ['findings'], 'the public probe uses the formal schema');
            response = 'not a valid public reviewer contract';
        } else if (request.roleInstructions.includes('dependency_behaviors')) {
            assert.ok(request.prompt.includes('FULL_REQUIRED_SOURCE_MARKER') && request.prompt.includes('source note 89'));
            response = JSON.stringify({ test_strategy: { approach: 'Call advance with observed integer inputs.' } });
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            response = rejectActualReviewer ? 'not a valid actual candidate review' : '{"findings":[]}';
        } else {
            const module = /\bsample_a\b/.test(request.prompt) ? 'sample_a' : 'sample_b';
            response = `import unittest\nfrom ${module} import advance\nclass Cases(unittest.TestCase):\n`
                + '    def test_integers(self):\n        self.assertEqual(advance(0), 1)\n'
                + '        self.assertEqual(advance(1), 2)\n        self.assertEqual(advance(-1), 0)\n';
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => {
                writes.push(key); persisted.set(key, value);
            } }, secrets: {}, subscriptions: [] });
        const setInitialProfile = (reviewerState: 'verified' | 'unverified') => handlers.get('llm-unit-test.updateModelProfile')!({
            envType: 'local', modelName: 'neutral-batch-reuse', paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 4096 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed original context' },
                reviewer: { state: reviewerState, reason: 'fixed original context' }, bugFixer: { state: 'not-run', reason: 'not used' } }
        });
        const run = async (name: string, strategy: 'tier2' | 'auto') => {
            requests.length = 0;
            const output = path.join(directory, name);
            const savedBefore = JSON.stringify(persisted.get('llmUnitTest.modelProfiles.v1'));
            const writesBefore = writes.length;
            await handlers.get('llm-unit-test.runBatchAnalysis')!({ envType: 'local', modelName: 'neutral-batch-reuse',
                batchPath: project, promptStrategy: strategy, validationMode: 'full', maxLoops: 1,
                timeoutSeconds: 60, mutationEngine: 'builtin', outputPath: output });
            const batch = path.join(output, fs.readdirSync(output)[0]);
            const manifest = JSON.parse(fs.readFileSync(path.join(batch, 'batch_manifest.json'), 'utf8'));
            assert.equal(manifest.expectedTargets, 2);
            assert.equal(manifest.finishedTargets, 2);
            const targets = manifest.targets.map((target: any) => {
                const data = resultDataDirectory(path.join(batch, target.reportDirectory));
                const events = fs.readFileSync(path.join(data, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const knowledge = JSON.parse(fs.readFileSync(path.join(data, 'function_knowledge.json'), 'utf8'));
                return { target, data, events, knowledge };
            });
            assert.ok(writes.slice(writesBefore).every(key => key !== 'llmUnitTest.modelProfiles.v1'
                && !/runtimeContext|contextPreference/i.test(key)),
            'ordinary last-folder memory is allowed; runtime model/context preferences must stay unchanged');
            assert.equal(JSON.stringify(persisted.get('llmUnitTest.modelProfiles.v1')), savedBefore);
            for (const module of ['sample_a', 'sample_b']) {
                assert.equal(fs.readFileSync(path.join(project, module + '.py'), 'utf8'), sourceText);
            }
            return { manifest, targets, wire: [...requests] };
        };
        await t.test('manual Tier 2 probes once per capacity and reaches mutation only after actual candidate approval', async () => {
            setInitialProfile('unverified');
            const result = await run('manual-approved', 'tier2');
            assert.equal(result.manifest.allTargetsPassed, true, JSON.stringify(result.targets.map((item: any) => item.knowledge.lastFailure)));
            const probes = result.wire.filter(request => !request.roleInstructions);
            const capacities = [...new Set(probes.map(request => request.options.num_ctx))];
            assert.ok(capacities.length > 0 && capacities.every(capacity => Number(capacity) > 4096 && Number(capacity) <= 16384));
            for (const capacity of capacities) {
                const atCapacity = probes.filter(request => request.options.num_ctx === capacity);
                assert.equal(atCapacity.filter(request => request.prompt.includes('A safe runtime already provides increment(value)')).length, 1);
                assert.equal(atCapacity.filter(request => request.prompt.includes('Review this exact TEST_FILE')).length, 1);
            }
            const second = result.targets[1];
            assert.ok(second.events.some((event: any) => event.stage === 'model-runtime' && event.status === 'batch-context-reused'));
            assert.ok(!second.events.some((event: any) => event.stage === 'model-request' && event.status === 'requested'
                && event.detail.phase === 'context-qualification'), 'the second target reuses the exact capacity instead of reprobes');
            assert.ok(result.targets.some((item: any) => item.events.some((event: any) =>
                event.stage === 'context-qualification' && event.status === 'cache-hit')));
            for (const item of result.targets) {
                const requested = item.events.filter((event: any) => event.stage === 'model-request' && event.status === 'requested');
                const qualificationRequests = requested.filter((event: any) => event.detail.phase === 'context-qualification').length;
                assert.equal(item.target.modelRequests, requested.length);
                assert.equal(item.target.qualificationRequests, qualificationRequests);
                assert.equal(item.target.formalRequests, requested.length - qualificationRequests);
                assert.equal(item.target.transportAttempts, item.events.filter((event: any) => event.stage === 'model-request'
                    && event.status === 'timing' && event.detail.kind === 'transport').length);
                assert.equal(item.knowledge.terminalStatus, 'passed');
                assert.equal(item.knowledge.mutationScore, 100);
                const checkpoint = JSON.parse(fs.readFileSync(path.join(item.data, 'quality_baseline.json'), 'utf8'));
                assert.equal(checkpoint.codeHash, evidenceHash(checkpoint.code));
                const approval = item.events.findIndex((event: any) => event.stage === 'reviewer' && event.status === 'approved');
                const mutation = item.events.findIndex((event: any) => event.stage === 'mutation' && event.status === 'measured');
                assert.ok(approval >= 0 && mutation > approval);
                assert.equal(item.events[approval].detail.approvedCodeHash, checkpoint.codeHash);
            }
        });
        await t.test('a second batch reprobes; manual availability cannot substitute for valid actual candidate review', async () => {
            rejectActualReviewer = true;
            const result = await run('manual-rejected-actual-review', 'tier2');
            assert.equal(result.manifest.allTargetsPassed, false);
            assert.ok(result.wire.some(request => request.prompt.includes('Review this exact TEST_FILE')),
                'a new batch cannot borrow the preceding batch runtime cache');
            assert.ok(result.wire.some(request => request.roleInstructions.includes('You are the test Reviewer')),
                'manual policy permits the actual review attempt');
            for (const item of result.targets) {
                assert.ok(!item.events.some((event: any) => event.stage === 'reviewer' && event.status === 'approved'));
                assert.ok(!item.events.some((event: any) => event.stage === 'mutation' && event.status === 'measured'));
                assert.notEqual(item.knowledge.terminalStatus, 'passed');
            }
        });
        await t.test('Auto cannot borrow original capacity Reviewer qualification after new-capacity contract failure', async () => {
            setInitialProfile('verified');
            rejectActualReviewer = false;
            const result = await run('auto-invalid-new-reviewer', 'auto');
            assert.equal(result.manifest.allTargetsPassed, false);
            assert.ok(result.wire.some(request => request.prompt.includes('Review this exact TEST_FILE')));
            assert.ok(!result.wire.some(request => request.roleInstructions.length > 0),
                'no formal Analyst/Writer/Reviewer request follows failed Auto full qualification');
            assert.ok(result.targets.every((item: any) => !item.events.some((event: any) => event.stage === 'mutation' && event.status === 'measured')));
        });
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
