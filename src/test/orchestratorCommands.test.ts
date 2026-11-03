import * as assert from 'assert';
import { test } from 'node:test';

test('public commands without Webview parameters open configuration and keep profile updates internal', async () => {
    const Module = require('module');
    const originalLoad = Module._load;
    const handlers = new Map<string, (...args: any[]) => any>();
    const executed: string[] = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        window: { registerWebviewViewProvider: () => ({ dispose() {} }) },
        commands: {
            registerCommand: (name: string, handler: (...args: any[]) => any) => {
                handlers.set(name, handler);
                return { dispose() {} };
            },
            executeCommand: async (name: string) => { executed.push(name); }
        }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    try {
        const { activate } = require('../orchestrator');
        activate({
            extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } },
            extensionMode: 3,
            globalState: { get: () => undefined },
            secrets: {}, subscriptions: []
        });
        await handlers.get('llm-unit-test.runCaptureAndTest')!();
        await handlers.get('llm-unit-test.runBatchAnalysis')!();
        assert.deepStrictEqual(executed, ['mutation-test-view.focus', 'mutation-test-view.focus']);
        const manifest = require('../../package.json');
        const publicCommands = manifest.contributes.commands.map((entry: { command: string }) => entry.command);
        assert.ok(publicCommands.includes('llm-unit-test.abortTest'));
        assert.ok(publicCommands.includes('llm-unit-test.runBatchAnalysis'));
        assert.ok(!publicCommands.includes('llm-unit-test.updateModelProfile'));
    } finally {
        Module._load = originalLoad;
    }
});
