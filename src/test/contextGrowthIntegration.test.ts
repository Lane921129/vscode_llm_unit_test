import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';
import { evidenceHash } from '../pipeline/analysisJournal';

test('formal context growth requalifies the new wire capacity before execution, review and mutation', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-growth-integration-'));
    const source = path.join(directory, 'sample.py');
    const evidenceMarker = 'FULL_SOURCE_EVIDENCE_MUST_SURVIVE';
    const sourceText = `def advance(value):\n    # ${evidenceMarker}\n`
        + Array.from({ length: 90 }, (_, i) => `    # source note ${i}: ${'unchanged evidence '.repeat(4)}\n`).join('')
        + '    return value + 1\n';
    fs.writeFileSync(source, sourceText);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const persisted = new Map<string, unknown>();
    const requests: any[] = [];
    let rejectReviewerProbe = false;
    let writes = 0;
    const probeCode = 'import unittest\nclass TestProbe(unittest.TestCase):\n'
        + '    def test_positive(self):\n        self.assertEqual(increment(1), 2)\n'
        + '    def test_negative(self):\n        self.assertEqual(increment(-1), 0)\n';
    const targetCode = 'import unittest\nfrom sample import advance\nclass Cases(unittest.TestCase):\n'
        + '    def test_integers(self):\n        self.assertEqual(advance(0), 1)\n'
        + '        self.assertEqual(advance(1), 2)\n        self.assertEqual(advance(-1), 0)\n';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? 4096 : key === 'requireRoleQualification' ? true : fallback,
            update: async () => { throw new Error('context growth must not overwrite saved settings'); } }),
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
        const qualificationProbe = wire.prompt.includes('A safe runtime already provides increment(value)')
            || wire.prompt.includes('Review this exact TEST_FILE');
        assert.equal(wire.system, ' ');
        const request = qualificationProbe
            ? { ...wire, roleInstructions: '', transmittedPrompt: wire.prompt }
            : readOllamaRoleRequest(wire);
        requests.push(request);
        let response: string;
        if (request.prompt.includes('A safe runtime already provides increment(value)')) {
            response = probeCode;
        } else if (request.prompt.includes('Review this exact TEST_FILE')) {
            response = rejectReviewerProbe ? 'invalid review' : '{"findings":[]}';
        } else if (request.roleInstructions.includes('dependency_behaviors')) {
            assert.ok(request.prompt.includes(evidenceMarker));
            assert.ok(request.prompt.includes('source note 89'), 'the last source evidence is retained');
            response = JSON.stringify({ test_strategy: { approach: 'Exercise advance with verified integer inputs.' } });
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            response = '{"findings":[]}';
        } else {
            response = targetCode;
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => {
                writes++; persisted.set(key, value);
            } }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-growth',
            paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 4096 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed original context' },
                reviewer: { state: 'verified', reason: 'fixed original context' }, bugFixer: { state: 'unverified', reason: 'not used' } } });
        const beforeWrites = writes;
        const beforeStored = JSON.stringify(persisted.get('llmUnitTest.modelProfiles.v1'));
        const run = async (name: string, requireRoleQualification = true) => {
            requests.length = 0;
            const output = path.join(directory, name);
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-growth',
                filePath: source, funcName: 'advance', promptStrategy: 'auto', requireRoleQualification, validationMode: 'full', maxLoops: 1,
                timeoutSeconds: 60, mutationEngine: 'builtin', outputPath: output });
            const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
            const artifact = (name: string) => path.join(output, artifacts.find(item => path.basename(item) === name)!);
            const events = fs.readFileSync(artifact('role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            const knowledge = JSON.parse(fs.readFileSync(artifact('function_knowledge.json'), 'utf8'));
            assert.equal(writes, beforeWrites);
            assert.equal(JSON.stringify(persisted.get('llmUnitTest.modelProfiles.v1')), beforeStored);
            assert.equal(fs.readFileSync(source, 'utf8'), sourceText);
            return { events, knowledge, artifact };
        };
        await t.test('whole evidence fits after growth and newly verified roles reach real mutation', async () => {
            const result = await run('grown');
            const growth = result.events.filter(event => event.stage === 'model-runtime' && event.status === 'context-grown');
            assert.ok(growth.length > 0, JSON.stringify({ lastFailure: result.knowledge.lastFailure,
                events: result.events.map(event => `${event.stage}:${event.status}`), requests: requests.map(request => request.options) }));
            const capacities = growth.map(event => event.detail.contextWindow);
            assert.ok(capacities.every((capacity, i) => capacity > (i === 0 ? 4096 : capacities[i - 1]) && capacity <= 16384));
            assert.ok(requests.every(request => capacities.includes(request.options.num_ctx)), 'all wire requests use a newly qualified capacity');
            for (const capacity of capacities) {
                const atCapacity = requests.filter(request => request.options.num_ctx === capacity);
                assert.equal(atCapacity.filter(request => request.prompt.includes('A safe runtime already provides increment(value)')).length, 1);
                assert.equal(atCapacity.filter(request => request.prompt.includes('Review this exact TEST_FILE')).length, 1);
                assert.ok(atCapacity.slice(2).every(request => request.roleInstructions.length > 0),
                    'formal requests follow both successful public role probes at their exact capacity');
            }
            assert.equal(result.knowledge.terminalStatus, 'passed', JSON.stringify(result.knowledge.lastFailure));
            assert.equal(result.knowledge.reviewStatus, 'completed');
            assert.equal(result.knowledge.mutationStatus, 'complete');
            assert.equal(result.knowledge.mutationScore, 100);
            const baseline = JSON.parse(fs.readFileSync(result.artifact('quality_baseline.json'), 'utf8'));
            assert.equal(baseline.codeHash, evidenceHash(baseline.code));
            const review = result.events.findIndex(event => event.stage === 'reviewer' && event.status === 'approved');
            const mutation = result.events.findIndex(event => event.stage === 'mutation' && event.status === 'measured');
            assert.ok(review >= 0 && mutation > review);
            assert.equal(result.events[review].detail.approvedCodeHash, baseline.codeHash);
        });
        await t.test('invalid new Reviewer qualification cannot borrow the old capacity approval', async () => {
            rejectReviewerProbe = true;
            const result = await run('rejected');
            assert.equal(result.knowledge.terminalStatus, 'failed');
            assert.ok(!requests.some(request => request.roleInstructions.includes('dependency_behaviors')),
                'no formal role runs after failed capacity qualification');
            assert.ok(!result.events.some(event => event.stage === 'reviewer' && event.status === 'approved'));
            assert.ok(!result.events.some(event => event.stage === 'mutation' && event.status === 'measured'));
            assert.ok(result.events.some(event => event.stage === 'model-runtime' && event.status === 'qualification-failed'),
                JSON.stringify(result.knowledge.lastFailure));
        });
        await t.test('optional qualification grows capacity without probes and still requires actual review before mutation', async () => {
            const result = await run('optional-grown', false);
            assert.equal(result.knowledge.roleQualificationRequired, false);
            assert.equal(result.knowledge.terminalStatus, 'passed', JSON.stringify(result.knowledge.lastFailure));
            assert.ok(!requests.some(request => request.prompt.includes('A safe runtime already provides increment(value)')
                || request.prompt.includes('Review this exact TEST_FILE')));
            assert.ok(!result.events.some(event => event.stage === 'context-qualification' && event.status === 'requested'));
            const grown = result.events.find(event => event.stage === 'model-runtime' && event.status === 'context-grown');
            assert.ok(grown);
            assert.ok(Object.values(grown.detail.roleQualification).every((role: any) => role.state === 'not-run'));
            const reviewed = result.events.find(event => event.stage === 'reviewer' && event.status === 'approved');
            const mutation = result.events.find(event => event.stage === 'mutation' && event.status === 'measured');
            assert.ok(reviewed && mutation && reviewed.sequence < mutation.sequence);
        });
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
