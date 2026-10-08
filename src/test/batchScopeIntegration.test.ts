import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonEnvironmentActivity } from '../environment/pythonEnvironmentSetup';

test('real batch command respects confirmed files, diagnoses each ambiguous selector once, and cancels before models or initialization locks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-command-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const state = new Map<string, unknown>();
    let choices: string[] | undefined = ['selected.py', 'ambiguous.py'];
    let preflightChoice: string | undefined = '繼續測試並記錄失敗';
    let modelCalls = 0;
    let abortOnSummary = false;
    const vscode = {
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        ExtensionMode: { Development: 2, Test: 3 },
        window: {
            registerWebviewViewProvider: (_name: string, provider: any) => {
                provider.webview = { postMessage: async () => true }; return { dispose() {} };
            },
            showInformationMessage: async () => {}, showTextDocument: async (document: { file?: string }) => {
                if (abortOnSummary && document.file?.endsWith('batch_summary.md')) {
                    handlers.get('llm-unit-test.abortTest')!();
                }
            },
            showQuickPick: async (items: any[]) => choices && items.filter(item => choices!.includes(item.file)),
            showWarningMessage: async () => preflightChoice
        },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback }),
            openTextDocument: async (file: string) => ({ file }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }, env: { openExternal: async () => true }, Uri: { file: (file: string) => file }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async () => { modelCalls++; throw new Error('No model work is authorized in this fixture'); };
    let restorePrepare = () => {};
    try {
        fs.mkdirSync(path.join(root, 'old backup'));
        fs.writeFileSync(path.join(root, 'selected.py'), 'import scope_dependency_not_installed\ndef first(x): return x\ndef second(x): return x + 1\n');
        fs.writeFileSync(path.join(root, 'ambiguous.py'), 'def repeated(x): return x\ndef repeated(x): return x + 1\n');
        fs.writeFileSync(path.join(root, 'old backup', 'excluded.py'), 'def malformed(\n');
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
            secrets: {}, subscriptions: [] });
        const run = handlers.get('llm-unit-test.runBatchAnalysis')!;
        const params = { envType: 'local', modelName: 'fixture', batchPath: root, promptStrategy: 'tier2',
            maxLoops: 1, timeoutSeconds: 30, outputPath: path.join(root, 'results') };
        const manifests = () => fs.readdirSync(params.outputPath).map(name => JSON.parse(
            fs.readFileSync(path.join(params.outputPath, name, 'batch_manifest.json'), 'utf8')));

        await run(params);
        const first = manifests()[0];
        assert.deepEqual(first.scope.selectedFiles, ['ambiguous.py', 'selected.py']);
        assert.deepEqual(first.scope.excludedFiles, ['old backup/excluded.py']);
        assert.deepEqual(first.discoveredFiles, ['ambiguous.py', 'selected.py']);
        assert.equal(first.expectedTargets, 3);
        assert.equal(first.targets.filter((target: any) => target.target === 'repeated').length, 1);
        assert.equal(first.finishedTargets, 3);
        assert.ok(first.targets.every((target: any) => target.terminalStatus === 'failed'));
        assert.deepEqual(first.discoveryFailures, [], 'excluded syntax errors never enter discovery');
        assert.equal(modelCalls, 0);

        choices = undefined;
        const previousState = JSON.stringify([...state]);
        await run(params);
        const cancelled = manifests().find(item => item.batchId !== first.batchId)!;
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.expectedTargets, 0);
        assert.equal(cancelled.scope, undefined);
        assert.equal(JSON.stringify([...state]), previousState);
        assert.equal(modelCalls, 0);

        const { ImportSetupController } = require('../environment/importSetupController');
        const originalPrepare = ImportSetupController.prototype.prepare;
        const prepared: unknown[][] = [];
        restorePrepare = () => { ImportSetupController.prototype.prepare = originalPrepare; };
        ImportSetupController.prototype.prepare = async (...args: unknown[]) => {
            const release = pythonEnvironmentActivity.acquire('setup');
            assert.ok(release, 'analysis must release its use lock before opening initialization setup');
            release(); prepared.push(args);
        };
        choices = ['selected.py']; preflightChoice = '處理初始化設定';
        await run(params);
        assert.deepEqual(prepared, [[root, params.outputPath, [{ file: path.join(root, 'selected.py'), target: 'first' }]]],
            'deferred initialization must receive only this batch\'s confirmed source targets, not rescan excluded files');
        const initialized = manifests().find(item => ![first.batchId, cancelled.batchId].includes(item.batchId))!;
        assert.equal(initialized.status, 'cancelled');
        assert.equal(initialized.expectedTargets, 2);
        assert.equal(initialized.finishedTargets, 0);
        assert.ok(initialized.targets.every((target: any) => target.state === 'pending'));
        assert.equal(modelCalls, 0);

        prepared.length = 0; preflightChoice = undefined;
        await run(params);
        assert.deepEqual(prepared, [], 'dismissing the blocked-preflight dialog must not open initialization or replay a prior scope');
        assert.equal(modelCalls, 0);

        preflightChoice = '處理初始化設定'; abortOnSummary = true;
        await run(params);
        assert.deepEqual(prepared, [], 'cancellation during the final summary cancels deferred initialization too');
        assert.equal(modelCalls, 0);
    } finally {
        restorePrepare(); globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
