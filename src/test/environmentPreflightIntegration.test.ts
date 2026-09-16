import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { clearPreflightFailureCache, preflightFailureCacheSize } from '../pipeline/modulePreflight';

test('missing target dependency stops before all model roles and preserves diagnostics on each retry', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-integration-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module');
    const originalLoad = Module._load;
    const originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    let modelCalls = 0;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        window: {
            registerWebviewViewProvider: (_: string, provider: any) => {
                provider.webview = { postMessage: async () => true }; return { dispose() {} };
            }, showInformationMessage: async () => {}, showTextDocument: async () => {}
        },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: () => python }), openTextDocument: async () => ({}) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }, env: { openExternal: async () => true }, Uri: { file: (file: string) => file }
    };
    Module._load = function(name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    globalThis.fetch = async () => { modelCalls++; throw new Error('Must not request a model before import preflight passes'); };
    try {
        const source = 'import fixture_dependency_not_installed\ndef target(value):\n    return value + 1\n';
        fs.writeFileSync(path.join(directory, 'sample.py'), source);
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        const params = { envType: 'local', modelName: 'fixture-model', filePath: path.join(directory, 'sample.py'),
            funcName: 'target', promptStrategy: 'tier2', maxLoops: 3, timeoutSeconds: 30,
            outputPath: path.join(directory, 'results') };
        await handlers.get('llm-unit-test.runCaptureAndTest')!(params);
        await handlers.get('llm-unit-test.runCaptureAndTest')!(params);
        assert.equal(modelCalls, 0);
        assert.equal(preflightFailureCacheSize(), 1);
        const runs = fs.readdirSync(params.outputPath).flatMap(root =>
            fs.readdirSync(path.join(params.outputPath, root)).map(name => path.join(params.outputPath, root, name)));
        assert.equal(runs.length, 2);
        for (const run of runs) {
            const knowledge = JSON.parse(fs.readFileSync(path.join(run, 'function_knowledge.json'), 'utf8'));
            assert.equal(knowledge.terminalStatus, 'failed');
            assert.equal(knowledge.failureCategory, 'environment');
            assert.equal(knowledge.failureStage, 'module-import');
            assert.equal(knowledge.diagnostic.missing_module, 'fixture_dependency_not_installed');
            assert.equal(knowledge.initialTargetObservations.load_diagnostic.missing_module, 'fixture_dependency_not_installed');
            assert.match(knowledge.sourceStructure, /return value \+ 1/);
            assert.match(fs.readFileSync(path.join(run, 'final_report.md'), 'utf8'), /fixture_dependency_not_installed/);
            const events = fs.readFileSync(path.join(run, 'role_events.jsonl'), 'utf8');
            assert.doesNotMatch(events, /"stage":"(?:writer|reviewer|bug-fixer|analyst-planning)"/);
        }
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally {
        clearPreflightFailureCache();
        globalThis.fetch = originalFetch;
        Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
