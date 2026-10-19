import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture } from './ollamaRequestFixture';

test('sidebar abort waits for its active transport and batch cleanup before publishing one finished message', { timeout: 60_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-cancellation-'));
    const source = path.join(root, 'sample.py');
    fs.writeFileSync(source, 'def first(value):\n    return value + 1\n\ndef second(value):\n    return value - 1\n');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const messages: any[] = [];
    const settingsUpdates: Array<{ key: string; value: unknown }> = [];
    let sidebar: any, settingsGate: Promise<void> | undefined, finishSettingsUpdate: (() => void) | undefined;
    const modelName = 'neutral-cancellation-fixture';
    let receiveMessage!: (message: any) => Promise<void>;
    let notifyStarted!: () => void, finishTransport!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const draining = new Promise<void>(resolve => { finishTransport = resolve; });
    let signal: AbortSignal | undefined, requests = 0, aborts = 0, drained = false;
    const webview = { options: {}, html: '', postMessage: async (message: any) => { messages.push(message); return true; },
        onDidReceiveMessage: (callback: typeof receiveMessage) => { receiveMessage = callback; } };
    const vscode = {
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            sidebar = provider;
            provider.resolveWebviewView({ webview }); return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {},
        showQuickPick: async (items: any[]) => items.filter(item => item.picked) },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback,
                update: async (key: string, value: unknown) => { settingsUpdates.push({ key, value }); await settingsGate; } }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        }, executeCommand: async (name: string, ...args: any[]) => handlers.get(name)?.(...args) }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName });
        if (metadata) { return metadata; }
        requests++;
        signal = options?.signal as AbortSignal;
        assert.ok(signal);
        notifyStarted();
        return new Promise<Response>((_resolve, reject) => {
            signal!.addEventListener('abort', () => {
                aborts++;
                void draining.then(() => { drained = true; reject(new DOMException('Cancelled fixture transport', 'AbortError')); });
            }, { once: true });
        });
    };
    let run: Promise<void> | undefined, lateBusyAttempt: Promise<void> | undefined, finishBusyNotice: (() => void) | undefined;
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        const params = { envType: 'local', modelName, promptStrategy: 'tier1', validationMode: 'execution',
            maxLoops: 1, timeoutSeconds: 30, outputPath: path.join(root, 'results') };
        run = handlers.get('llm-unit-test.runBatchAnalysis')!({ ...params, batchPath: root });
        await started;
        const runningMarkup = webview.html;
        await receiveMessage({ command: 'setPromptStrategy', strategy: 'tier2' });
        assert.deepEqual(settingsUpdates, [], 'an active analysis must reject strategy changes even if the UI message is sent');
        assert.equal(webview.html, runningMarkup, 'changing Tier cannot rebuild the running view and remove its stop button');
        await receiveMessage({ command: 'abortTest' });
        assert.equal(signal?.aborted, true);
        assert.equal(aborts, 1);
        assert.equal(drained, false);
        assert.equal(messages.filter(message => message.command === 'analysisStopping').length, 1);
        assert.equal(messages.filter(message => message.command === 'analysisFinished').length, 0,
            'the sidebar bridge and command must not claim completion before the owned HTTP transport settles');
        await receiveMessage({ command: 'setPromptStrategy', strategy: 'tier3' });
        assert.deepEqual(settingsUpdates, [], 'the reservation also protects a stopping analysis');
        assert.equal(webview.html, runningMarkup);
        const restartOutput = path.join(root, 'restart-while-stopping');
        const activity = require('../environment/pythonEnvironmentSetup').pythonEnvironmentActivity;
        const originalAcquire = activity.acquire;
        activity.acquire = () => undefined;
        try {
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ ...params, filePath: source, funcName: 'first', outputPath: restartOutput });
            assert.equal(messages.filter(message => message.command === 'analysisFinished').length, 0,
                'a busy environment during cancellation must not finish the still-owned analysis');
        } finally { activity.acquire = originalAcquire; }
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ ...params, filePath: source, funcName: 'first', outputPath: restartOutput });
        assert.equal(requests, 1, 'a cancelled but still draining run retains the analysis reservation');
        assert.equal(fs.existsSync(restartOutput), false);
        assert.equal(messages.filter(message => message.command === 'analysisFinished').length, 0);
        vscode.window.showInformationMessage = () => new Promise<void>(resolve => { finishBusyNotice = resolve; });
        activity.acquire = () => undefined;
        try {
            lateBusyAttempt = handlers.get('llm-unit-test.runCaptureAndTest')!({ ...params, filePath: source, funcName: 'first', outputPath: restartOutput });
        } finally { activity.acquire = originalAcquire; }
        finishTransport();
        await run;
        assert.equal(drained, true);
        assert.equal(messages.filter(message => message.command === 'analysisFinished').length, 1);
        finishBusyNotice!();
        await lateBusyAttempt;
        assert.equal(messages.filter(message => message.command === 'analysisFinished').length, 1,
            'a rejected restart whose notice closes after cleanup cannot duplicate the owner acknowledgement');
        const batchDirectory = path.join(params.outputPath, fs.readdirSync(params.outputPath)[0]);
        const manifest = JSON.parse(fs.readFileSync(path.join(batchDirectory, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.status, 'cancelled');
        assert.equal(manifest.attemptedTargets, 1);
        assert.equal(manifest.targets[0].terminalStatus, 'cancelled');
        assert.equal(manifest.targets[1].state, 'pending');
        assert.equal(manifest.complete, false);
        assert.equal(requests, 1, 'cancellation must not start Writer repair or the next target');
        await receiveMessage({ command: 'setPromptStrategy', strategy: 'tier2' });
        assert.deepEqual(settingsUpdates, [{ key: 'promptStrategy', value: 'tier2' }]);
        assert.notEqual(webview.html, runningMarkup, 'strategy changes become available after the actual owner has finished');
        const idleMarkup = webview.html;
        settingsGate = new Promise<void>(resolve => { finishSettingsUpdate = resolve; });
        const delayedChange = receiveMessage({ command: 'setPromptStrategy', strategy: 'tier3' });
        sidebar.beginAnalysis('next-analysis-during-settings-save');
        finishSettingsUpdate!();
        await delayedChange;
        assert.deepEqual(settingsUpdates.at(-1), { key: 'promptStrategy', value: 'tier3' }, 'the setting was requested while idle');
        assert.equal(webview.html, idleMarkup, 'a setting save finishing after another analysis starts cannot rebuild its active view');
        sidebar.endAnalysis('next-analysis-during-settings-save');
    } finally {
        handlers.get('llm-unit-test.abortTest')?.();
        finishTransport();
        finishBusyNotice?.();
        finishSettingsUpdate?.();
        await run;
        await lateBusyAttempt;
        Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
