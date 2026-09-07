import * as assert from 'assert';
import { test } from 'node:test';
import { currentExecution, ExecutionContext } from '../pipeline/executionContext';

test('abort and immediate restart suppress stale completion and freeze model facts per batch', async () => {
    const Module = require('module');
    const originalLoad = Module._load;
    const handlers = new Map<string, (...args: any[]) => any>();
    const messages: Array<{ command: string }> = [];
    const warnings: string[] = [];
    const scans: Array<{ resume: () => void; context: ExecutionContext<any> }> = [];
    const utilities = require('../utils/utils');
    const originalScan = utilities.findPythonFilesInDir;
    utilities.findPythonFilesInDir = () => new Promise<string[]>(resolve => {
        scans.push({ resume: () => resolve([]), context: currentExecution()! });
    });
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        window: {
            registerWebviewViewProvider: (_: string, provider: any) => {
                provider.webview = { postMessage: (message: { command: string }) => {
                    messages.push(message);
                    return Promise.resolve(true);
                } };
                return { dispose() {} };
            },
            showInformationMessage: async (message: string) => { warnings.push(message); }
        },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler);
            return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    try {
        const { activate } = require('../orchestrator');
        activate({
            extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } },
            extensionMode: 3, globalState: { get: () => undefined, update: async () => {} },
            secrets: {}, subscriptions: []
        });
        const update = handlers.get('llm-unit-test.updateModelProfile')!;
        const batch = handlers.get('llm-unit-test.runBatchAnalysis')!;
        update({ envType: 'local', modelName: 'first', paramSize: '3B', contextLength: 4096 });
        const oldBatch = batch({ batchPath: 'fixture' });
        assert.strictEqual(scans.length, 1);
        handlers.get('llm-unit-test.abortTest')!();
        assert.strictEqual(messages.filter(m => m.command === 'analysisFinished').length, 1);
        update({ envType: 'local', modelName: 'second', paramSize: '8B', contextLength: 8192 });
        const newBatch = batch({ batchPath: 'fixture' });
        assert.strictEqual(scans.length, 2);
        assert.strictEqual(scans[0].context.snapshot.current.modelName, 'first');
        assert.strictEqual(scans[1].context.snapshot.current.modelName, 'second');
        assert.strictEqual(scans[0].context.snapshot.stored.length, 1);
        await batch({ batchPath: 'duplicate' });
        assert.strictEqual(scans.length, 2);
        assert.strictEqual(warnings.length, 1);
        const beforeOldCompletion = messages.length;
        scans[0].resume();
        await oldBatch;
        assert.strictEqual(messages.length, beforeOldCompletion);
        assert.strictEqual(scans[1].context.cancelled, false);
        scans[1].resume();
        await newBatch;
        assert.strictEqual(messages.filter(m => m.command === 'analysisFinished').length, 2);
    } finally {
        Module._load = originalLoad;
        utilities.findPythonFilesInDir = originalScan;
        for (const scan of scans) { scan.resume(); }
    }
});
