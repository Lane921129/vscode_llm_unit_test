import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, LOCAL_RUNTIME_QUALIFICATION_VERSION, qualificationEndpointKey } from '../llm/modelQualification';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture } from './ollamaRequestFixture';

test('public analysis commands reject unqualified Auto before setup and stop scheduling after the first terminal failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-fail-fast-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const file = path.join(root, 'sample.py');
    const source = 'def first(value):\n    return value + 1\n\ndef second(value):\n    return value - 1\n';
    fs.writeFileSync(file, source);
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const runner = require('../utils/processRunner'), originalSpawn = runner.runSpawn;
    const handlers = new Map<string, (...args: any[]) => any>();
    const messages: any[] = [], spawns: string[][] = [], requests: any[] = [];
    let savedProfiles: unknown[] = [], responseCode = '';
    const modelName = 'neutral-fixture';
    const verified = { state: 'verified', reason: 'fixed executable fixture passed' };
    const notRun = { state: 'not-run', reason: 'not probed' };
    const profile = () => ({ envType: 'local', modelName, paramSize: '3B', contextLength: 32768, contextLengthKnown: true,
        endpointKey: qualificationEndpointKey('local'), testGenerationReady: true,
        qualificationVersion: QUALIFICATION_VERSION,
        qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 16384 },
        roleQualification: { writer: verified, reviewer: notRun, bugFixer: notRun } });
    const vscode = {
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { messages.push(message); return true; } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {},
        showQuickPick: async (items: any[]) => items.filter(item => item.picked) },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python
                : key === 'requireRoleQualification' ? true : fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    runner.runSpawn = (command: string, args: string[], options: any) => {
        spawns.push(args);
        return originalSpawn(command, args, options);
    };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName });
        if (metadata) { return metadata; }
        requests.push(JSON.parse(String(options?.body)));
        return new Response(JSON.stringify({ response: '```python\n' + responseCode + '\n```', done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        const activate = () => require('../orchestrator').activate({
            extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => key === 'llmUnitTest.modelProfiles.v1' ? savedProfiles : undefined,
                update: async () => {} }, secrets: {}, subscriptions: []
        });
        const base = { envType: 'local', modelName, maxLoops: 2, timeoutSeconds: 30,
            promptStrategy: 'auto', validationMode: 'full' };
        const finished = () => messages.filter(item => item.command === 'analysisFinished').length;
        for (const [name, profiles, mode] of [
            ['focused-boundary-unprobed', [], 'full'],
            ['unprobed-full', [], 'full'],
            ['writer-only-full', [profile()], 'full'],
            ['wrong-context', [{ ...profile(), qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 8192 } }], 'execution'],
            ['wrong-endpoint', [{ ...profile(), endpointKey: qualificationEndpointKey('local', 'http://example.invalid') }], 'execution'],
            ['old-contract', [{ ...profile(), qualificationVersion: 'expired-contract' }], 'execution']
        ] as const) {
            savedProfiles = [...profiles]; activate();
            const beforeFinished = finished(), beforeSpawns = spawns.length, beforeRequests = requests.length;
            const outputPath = path.join(root, name);
            await handlers.get('llm-unit-test.runBatchAnalysis')!({ ...base,
                ...(name.startsWith('focused-') ? { promptStrategy: 'boundary' } : {}), batchPath: root, outputPath, validationMode: mode });
            assert.equal(spawns.length, beforeSpawns, name + ': no source scan, import, setup or Trace before Auto readiness');
            assert.equal(requests.length, beforeRequests, name + ': no model generation or qualification request');
            assert.equal(fs.existsSync(outputPath), false, name + ': no fictitious target result');
            assert.equal(finished(), beforeFinished + 1, name + ': immediately releases busy state');
        }
        savedProfiles = []; activate();
        const beforeSingle = spawns.length, beforeSingleFinished = finished();
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ ...base, filePath: file, funcName: 'first', outputPath: path.join(root, 'single-unprobed') });
        assert.equal(spawns.length, beforeSingle + 1, 'explicit target only reads static AST to preserve the inert-stub fast path');
        assert.match(path.basename(spawns.at(-1)![0]), /^ast_extractor\.py$/);
        assert.equal(finished(), beforeSingleFinished + 1);
        assert.equal(requests.length, 0);
        assert.ok(messages.some(item => item.text?.includes('完整流程的 Auto 需要先完成 Writer 與 Reviewer')));

        // Writer-only qualification is enough for execution mode. This run
        // also proves the failed prerequisite released the environment lease.
        savedProfiles = [profile()]; activate();
        responseCode = 'import unittest\nfrom sample import first\nclass Cases(unittest.TestCase):\n'
            + '    def test_value(self):\n        self.assertEqual(first(2), 3)\n';
        const passedOutput = path.join(root, 'writer-only-execution');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ ...base, validationMode: 'execution',
            filePath: file, funcName: 'first', outputPath: passedOutput });
        const knowledgeFiles = (output: string) => fs.readdirSync(output, { recursive: true }).map(String)
            .filter(name => path.basename(name) === 'function_knowledge.json');
        const passed = JSON.parse(fs.readFileSync(path.join(passedOutput, knowledgeFiles(passedOutput)[0]), 'utf8'));
        assert.equal(passed.terminalStatus, 'execution-passed', JSON.stringify(passed.lastFailure));
        assert.equal(passed.reviewStatus, 'deferred');

        // A malformed Writer candidate exhausts its bounded repair policy.
        // The next target must remain pending, with the first failure saved.
        savedProfiles = []; activate();
        responseCode = 'import unittest\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertTrue(True)\n';
        const failedOutput = path.join(root, 'batch-failure');
        const beforeBatchFinished = finished();
        await handlers.get('llm-unit-test.runBatchAnalysis')!({ ...base, requireRoleQualification: false, promptStrategy: 'tier1', validationMode: 'execution',
            batchPath: root, outputPath: failedOutput });
        const batchDirectory = path.join(failedOutput, fs.readdirSync(failedOutput)[0]);
        const manifest = JSON.parse(fs.readFileSync(path.join(batchDirectory, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.status, 'failed');
        assert.equal(manifest.expectedTargets, 2, JSON.stringify({ manifest,
            logs: messages.filter(item => item.command === 'appendLog').slice(-8) }));
        assert.equal(manifest.targets[0].terminalStatus, 'failed');
        assert.equal(manifest.targets[1].state, 'pending');
        assert.equal(manifest.attemptedTargets, 1);
        assert.equal(manifest.complete, false);
        assert.equal(manifest.allTargetsExecutionVerified, false);
        assert.equal(knowledgeFiles(failedOutput).length, 1);
        assert.ok(fs.readdirSync(failedOutput, { recursive: true }).map(String).some(name => path.basename(name) === 'failure_report.md'));
        assert.equal(finished(), beforeBatchFinished + 1);

        const wholeOutput = path.join(root, 'whole-file-failure');
        const beforeWholeFinished = finished();
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ ...base, requireRoleQualification: false, promptStrategy: 'tier1', validationMode: 'execution',
            filePath: file, funcName: '', outputPath: wholeOutput });
        assert.equal(knowledgeFiles(wholeOutput).length, 1, 'whole-file scheduling also stops before second target');
        assert.equal(finished(), beforeWholeFinished + 1);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        Module._load = originalLoad; globalThis.fetch = originalFetch; runner.runSpawn = originalSpawn;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
