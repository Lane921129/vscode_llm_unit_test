import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resultDataDirectory } from '../pipeline/resultLayout';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('real batch preflight lets the loaded subset reach review and mutation while blocked targets request no models', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-ready-mutation-'));
    const output = path.join(root, 'results');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const logs: string[] = [];
    const wireRoles: string[] = [];
    let scopePrompts = 0, continuationPrompts = 0;
    let restoreRunner = () => {};
    const source = 'def target():\n    return 2 + 1\n';
    const controlledTest = 'import unittest\nfrom a_loaded import target\nclass Cases(unittest.TestCase):\n'
        + '    def test_target(self):\n        self.assertEqual(target(), 3)\n';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, ConfigurationTarget: { Global: 1 },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        Uri: { file: (fsPath: string) => ({ fsPath }) }, env: { openExternal: async () => true },
        workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }],
            openTextDocument: async (file: string) => ({ file }),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback,
                update: async () => { throw new Error('No environment installation or settings mutation belongs to this fixture'); } }) },
        window: {
            registerWebviewViewProvider: (_name: string, provider: any) => {
                provider.webview = { postMessage: async (message: any) => {
                    if (message.command === 'appendLog') { logs.push(message.text); }
                    return true;
                } };
                return { dispose() {} };
            },
            showInformationMessage: async () => {}, showTextDocument: async () => {},
            showQuickPick: async (items: any[]) => { scopePrompts++; return items.filter(item => item.picked); },
            showWarningMessage: async (_message: string, _options: unknown, ...actions: string[]) => {
                assert.ok(actions.includes('繼續測試並記錄失敗'));
                continuationPrompts++;
                return '繼續測試並記錄失敗';
            }
        },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (_url, options) => {
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        assert.doesNotMatch(request.prompt, /b_blocked|fixture_dependency_not_installed/,
            'blocked source is never handed to any model role');
        let response: string;
        if (request.prompt.startsWith('=== ANALYSIS EVIDENCE V2 ===')) {
            wireRoles.push('analyst');
            response = '{"test_strategy":{"approach":"Exercise the selected neutral target using its verified zero-argument observation, then preserve that exact assertion during quality checks."}}';
        } else if (request.prompt.startsWith('REVIEW_REQUEST_V8')) {
            wireRoles.push('reviewer'); response = '{"findings":[]}';
        } else if (request.prompt.startsWith('QUALITY_TASK_V3')) {
            wireRoles.push('analyst-quality'); response = '{"tasks":[]}';
        } else {
            wireRoles.push('writer'); response = '```python\n' + controlledTest + '\n```';
        }
        return new Response(JSON.stringify({ response }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        fs.writeFileSync(path.join(root, 'a_loaded.py'), source);
        const blockedSource = 'import fixture_dependency_not_installed\ndef target():\n    return 2 + 1\n';
        fs.writeFileSync(path.join(root, 'b_blocked.py'), blockedSource);
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture',
            paramSize: '13B', contextLength: 32768, contextLengthKnown: true });
        await handlers.get('llm-unit-test.runBatchAnalysis')!({ envType: 'local', modelName: 'fixture',
            batchPath: root, promptStrategy: 'tier2', validationMode: 'full', mutationEngine: 'builtin',
            maxLoops: 1, timeoutSeconds: 30, outputPath: output });
        const directories = fs.readdirSync(output).filter(name => fs.existsSync(path.join(output, name, 'batch_manifest.json')));
        assert.equal(directories.length, 1, logs.join('\n'));
        const batchDirectory = path.join(output, directories[0]);
        const manifest = JSON.parse(fs.readFileSync(path.join(batchDirectory, 'batch_manifest.json'), 'utf8'));
        assert.equal(manifest.expectedTargets, 2);
        const loaded = manifest.targets.find((target: any) => target.file === 'a_loaded.py');
        const blocked = manifest.targets.find((target: any) => target.file === 'b_blocked.py');
        assert.ok(loaded && blocked);
        assert.equal(loaded.terminalStatus, 'passed', JSON.stringify({ loaded, logs }));
        assert.equal(blocked.terminalStatus, 'environment-blocked');
        assert.equal(blocked.category, 'environment');
        assert.equal(blocked.state, 'finished');
        assert.equal(blocked.modelRequests, 0);
        assert.equal(blocked.formalRequests, 0);
        assert.equal(blocked.transportAttempts, 0);
        assert.equal(blocked.reportDirectory, undefined);
        assert.equal(manifest.allTargetsPassed, false);
        assert.equal(manifest.status, 'partial');
        assert.deepEqual(manifest.statusCounts, { passed: 1, 'environment-blocked': 1 });
        assert.equal(scopePrompts, 1);
        assert.equal(continuationPrompts, 1);
        assert.ok(wireRoles.includes('analyst') && wireRoles.includes('writer') && wireRoles.includes('reviewer'));
        const data = resultDataDirectory(path.join(batchDirectory, loaded.reportDirectory));
        const knowledge = JSON.parse(fs.readFileSync(path.join(data, 'function_knowledge.json'), 'utf8'));
        assert.equal(knowledge.reviewStatus, 'completed');
        assert.equal(knowledge.mutationScore, 100);
        const events = fs.readFileSync(path.join(data, 'role_events.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
        assert.ok(events.some((event: any) => event.stage === 'mutation' && event.status === 'measured'));
        const snapshot = JSON.parse(fs.readFileSync(path.join(batchDirectory, 'preflight', 'final_import_check.json'), 'utf8'));
        assert.equal(snapshot.actualImports, true, 'the production Python preflight really ran; planning is not an import receipt');
        assert.equal(snapshot.rows.find((row: any) => row.file === 'a_loaded.py')?.status, 'loaded');
        assert.equal(snapshot.rows.find((row: any) => row.file === 'b_blocked.py')?.status, 'blocked');
        assert.equal(fs.readFileSync(path.join(root, 'a_loaded.py'), 'utf8'), source);
        assert.equal(fs.readFileSync(path.join(root, 'b_blocked.py'), 'utf8'), blockedSource);

        // The static-tool fault is a deterministic fixture, while every import,
        // Trace, execution and mutation above used the production Python tools.
        const runner = require('../utils/processRunner');
        const originalRunSpawn = runner.runSpawn;
        restoreRunner = () => { runner.runSpawn = originalRunSpawn; };
        let staticToolFailures = 0;
        runner.runSpawn = async (command: string, args: string[], options: unknown) => {
            if (args[0]?.endsWith('validate_test_bindings.py')) {
                staticToolFailures++;
                return { code: 1, stdout: '', stderr: 'Controlled AST validator failure.' };
            }
            return originalRunSpawn(command, args, options);
        };
        wireRoles.length = 0;
        await handlers.get('llm-unit-test.runBatchAnalysis')!({ envType: 'local', modelName: 'fixture',
            batchPath: root, promptStrategy: 'tier2', validationMode: 'full', mutationEngine: 'builtin',
            maxLoops: 2, timeoutSeconds: 30, outputPath: output });
        const faultDirectory = fs.readdirSync(output).map(name => path.join(output, name))
            .filter(directory => directory !== batchDirectory && fs.existsSync(path.join(directory, 'batch_manifest.json')));
        assert.equal(faultDirectory.length, 1);
        const faultManifest = JSON.parse(fs.readFileSync(path.join(faultDirectory[0], 'batch_manifest.json'), 'utf8'));
        const faultTarget = faultManifest.targets.find((target: any) => target.file === 'a_loaded.py');
        assert.equal(faultTarget.terminalStatus, 'failed');
        const faultData = resultDataDirectory(path.join(faultDirectory[0], faultTarget.reportDirectory));
        const faultKnowledge = JSON.parse(fs.readFileSync(path.join(faultData, 'function_knowledge.json'), 'utf8'));
        assert.equal(faultKnowledge.failureCategory, 'validation');
        assert.equal(faultKnowledge.failureStage, 'static-analysis');
        const faultEvents = fs.readFileSync(path.join(faultData, 'role_events.jsonl'), 'utf8').trim()
            .split(/\r?\n/).map(line => JSON.parse(line));
        assert.equal(staticToolFailures, 1);
        assert.deepEqual(wireRoles, ['analyst', 'writer'], 'tool faults do not ask a model to repair its otherwise valid candidate');
        assert.ok(!faultEvents.some((event: any) => event.stage === 'tier' && event.status === 'fallback'));
        assert.ok(!faultEvents.some((event: any) => ['writer-revision', 'bug-fixer', 'mutation'].includes(event.stage)));
        assert.equal(faultManifest.targets.find((target: any) => target.file === 'b_blocked.py').modelRequests, 0);
    } finally {
        restoreRunner();
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
