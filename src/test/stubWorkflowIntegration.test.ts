import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { functionReportDirectory } from '../pipeline/resultLayout';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { setLanguage } from '../i18n/core';

test('stub outcomes bypass unused external mutation preflight and accurately identify host or absent tests', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-workflow-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const file = path.join(root, 'sample.py');
    const source = 'def placeholder():\n    pass\n\nclass Service:\n'
        + '    def __init__(self, dependency):\n        self.dependency = dependency\n'
        + '    def pending(self):\n        pass\n';
    fs.writeFileSync(file, source);
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const selection = require('../mutation/mutationSelection'), originalSelection = selection.selectMutationEngine;
    let mutationPreflights = 0, modelRequests = 0;
    const logs: string[] = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { if (message.text) { logs.push(message.text); } return true; } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    selection.selectMutationEngine = async () => { mutationPreflights++; throw Error('selected external engine is not installed'); };
    globalThis.fetch = async () => { modelRequests++; throw Error('stub outcome must not request an AI'); };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        for (const [target, terminal, author] of [
            ['placeholder', 'stub-smoke-generated', 'host-smoke'], ['Service.pending', 'stub-skipped', 'none']
        ]) {
            const outputPath = path.join(root, 'result-' + target);
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'unqualified-fixture',
                filePath: file, funcName: target, outputPath, promptStrategy: 'auto', validationMode: 'full',
                mutationEngine: 'mutatest', maxLoops: 1, timeoutSeconds: 30 });
            const knowledgePath = fs.readdirSync(outputPath, { recursive: true }).map(String)
                .find(name => path.basename(name) === 'function_knowledge.json');
            assert.ok(knowledgePath, logs.join('\n'));
            const directory = path.dirname(path.join(outputPath, knowledgePath));
            const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
            assert.equal(knowledge.terminalStatus, terminal, JSON.stringify(knowledge.lastFailure));
            assert.equal(knowledge.testAuthor, author);
            assert.equal(knowledge.reviewStatus, 'not-required');
            assert.equal(knowledge.mutationStatus, 'not-measured');
            assert.equal(knowledge.mutationScore, null);
            assert.notEqual(knowledge.executionVerified, true);
            assert.equal(knowledge.reviewApproval, undefined);
            assert.equal(knowledge.mutationSelection, undefined);
            assert.equal(fs.existsSync(path.join(functionReportDirectory(directory), 'final_report.md')), false,
                'stub diagnostics must not become a tested-function final report');
        }
        assert.equal(mutationPreflights, 0);
        assert.equal(modelRequests, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        setLanguage('zh-tw'); selection.selectMutationEngine = originalSelection;
        Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
