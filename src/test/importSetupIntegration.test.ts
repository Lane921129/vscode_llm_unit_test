import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

test('setup needs an exact preview confirmation; blocked batch stops before model calls and keeps targets incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-ui-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const settings: Record<string, unknown> = { pythonPath: python, projectPath: root, importFixtures: [] };
    const messages: any[] = [], handlers = new Map<string, (...args: any[]) => any>();
    let approve = false, changeSource = false, modelCalls = 0, updates = 0;
    const source = 'from pathlib import Path\nPath("must_not_exist").mkdir()\ndef target(value):\n    return value + 1\n';
    const file = path.join(root, 'sample.py'); fs.writeFileSync(file, source);
    const vscode = {
        ConfigurationTarget: { Global: 1 }, ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async (file: string) => ({ file }),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback,
                update: async (key: string, value: unknown, target: number) => { assert.equal(target, 1); updates++; settings[key] = value; } }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { messages.push(message); return true; } }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {},
        showWarningMessage: async (_message: string, _options: unknown, action: string) => {
            if (changeSource && action === '套用此清單並重新檢查') { fs.appendFileSync(file, '# changed\n'); }
            return approve ? action : undefined;
        } }, commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return { dispose() {} }; } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async () => { modelCalls++; throw new Error('No model calls during environment setup'); };
    try {
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        const output = path.join(root, 'results');
        await handlers.get('llm-unit-test.runBatchAnalysis')!({ envType: 'local', modelName: 'fixture', batchPath: root,
            outputPath: output, promptStrategy: 'tier2', maxLoops: 1, timeoutSeconds: 30 });
        const batchDirectory = path.join(output, fs.readdirSync(output)[0]);
        const batch = JSON.parse(fs.readFileSync(path.join(batchDirectory, 'batch_manifest.json'), 'utf8'));
        assert.equal(batch.preflightBlockedModules, 1); assert.equal(batch.finishedTargets, 0);
        assert.equal(batch.allTargetsPassed, false); assert.equal(modelCalls, 0);
        assert.equal(fs.existsSync(path.join(batchDirectory, 'preflight/import_check.json')), true);
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: file,
            funcName: 'target', outputPath: output, promptStrategy: 'tier2', maxLoops: 1, timeoutSeconds: 30 });
        const failedOutcome = messages.find(message => message.command === 'updateOutcome' && message.outcome?.kind === 'failed');
        assert.ok(failedOutcome, 'single import failure updates the final status in the result card');
        assert.match(fs.readFileSync(failedOutcome.reportPath, 'utf8').split('\n')[0], /最終結果：未通過：匯入／環境受阻/);
        assert.equal(modelCalls, 0);

        const setup = handlers.get('llm-unit-test.prepareImportSetup')!;
        await setup({ projectRoot: root, outputPath: output });
        assert.equal(updates, 0, 'closing preview is not confirmation');
        approve = true; changeSource = true;
        await setup({ projectRoot: root, outputPath: output });
        assert.equal(updates, 0, 'changed source invalidates approval');
        fs.writeFileSync(file, source); changeSource = false;
        await setup({ projectRoot: root, outputPath: output });
        assert.equal(updates, 2);
        assert.deepEqual(settings.importFixtures, [{ file: 'sample.py', mkdir: true }]);
        assert.equal(settings.importFixtureRoot, fs.realpathSync(root));
        assert.equal(modelCalls, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
        assert.equal(fs.existsSync(path.join(root, 'must_not_exist')), false);
        assert.ok(messages.some(message => message.text?.includes('0 個受阻')));
    } finally { Module._load = originalLoad; globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); }
});
