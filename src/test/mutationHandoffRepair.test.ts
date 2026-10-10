import { readOllamaRoleRequest } from './ollamaRequestFixture';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { functionReportDirectory } from '../pipeline/resultLayout';
import { setLanguage } from '../i18n/core';

test('orchestrator shares the execution import environment and reports mutation process failures', async () => {
    const repo = path.resolve(__dirname, '../..');
    const python = path.join(repo, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-handoff-'));
    fs.mkdirSync(path.join(root, 'pkg/sub'), { recursive: true });
    for (const name of ['pkg/__init__.py', 'pkg/sub/__init__.py']) { fs.writeFileSync(path.join(root, name), ''); }
    fs.writeFileSync(path.join(root, 'shared.py'), 'VALUE = 1\n');
    const sourceFile = path.join(root, 'pkg/sub/sample.py');
    fs.writeFileSync(sourceFile, 'import shared\ndef combine(a, b):\n    return a + b\n');
    const candidate = 'import unittest\nfrom pkg.sub.sample import combine\nclass Cases(unittest.TestCase):\n'
        + '    def test_sum(self):\n        self.assertEqual(combine(2, 3), 5)\n';
    const settings: Record<string, unknown> = { pythonPath: python, projectPath: root, language: 'en', mutationEngine: 'builtin' };
    const handlers = new Map<string, (...args: any[]) => any>();
    const logs: string[] = [];
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const processRunner = require('../utils/processRunner'), originalSpawn = processRunner.runSpawn;
    let mutationRuns = 0;
    let executionEnv: NodeJS.ProcessEnv | undefined;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        env: { openExternal: async () => true },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { if (message.text) { logs.push(message.text); } return true; } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    // All model requests are local deterministic fixtures; no network request is forwarded.
    globalThis.fetch = async (_url, options) => {
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        const response = request.roleInstructions.includes('dependency_behaviors') ? '{"dependency_behaviors":[]}'
            : request.roleInstructions.includes('You are the test Reviewer') ? '{"findings":[]}' : '```python\n' + candidate + '\n```';
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    processRunner.runSpawn = async (command: string, args: string[], options: any) => {
        if (args.some(arg => arg.endsWith('generated_test_runner.py'))) { executionEnv = options.env; }
        if (args[0]?.endsWith('basic_mutation_runner.py')) {
            mutationRuns++;
            assert.equal(command, python);
            assert.ok(executionEnv, 'a real isolated unittest must run before the mutation handoff');
            assert.deepEqual(options.env, executionEnv);
            assert.ok(options.env.PYTHONPATH.split(path.delimiter).includes(root));
            assert.ok(fs.statSync(options.cwd).isDirectory());
            // Stop at the process boundary: no mutant trials are executed by this test.
            return { code: 2, stdout: '{"error":"invalid-arguments"}',
                stderr: 'Traceback (most recent call last):\nValueError: fixture process failure\n' };
        }
        assert.ok(!args[0]?.endsWith('external_mutation_runner.py') || args.includes('--probe'));
        return originalSpawn(command, args, options);
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'handoff-fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture', paramSize: '13B', contextLength: 32768 });
        const outputPath = path.join(root, 'result');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: sourceFile,
            funcName: 'combine', outputPath, promptStrategy: 'tier2', validationMode: 'full', maxLoops: 1, timeoutSeconds: 30, mutpyTimeout: 60 });
        const relative = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json');
        assert.ok(relative, logs.join('\n'));
        const directory = path.dirname(path.join(outputPath, relative));
        const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
        assert.equal(mutationRuns, 1, JSON.stringify(knowledge.lastFailure));
        assert.notEqual(knowledge.terminalStatus, 'passed');
        assert.equal(knowledge.lastFailure.category, 'mutation');
        assert.equal(knowledge.failureStage, 'mutation-execution', JSON.stringify(knowledge.lastFailure));
        assert.equal(knowledge.diagnostic.exitCode, 2);
        assert.equal(knowledge.diagnostic.stderr.exceptionType, 'ValueError');
        const report = fs.readFileSync(path.join(functionReportDirectory(directory), 'final_report.md'), 'utf8');
        assert.match(report, /exitCode=2/);
        assert.doesNotMatch(report, /Final outcome: Fully passed/);
    } finally {
        setLanguage('zh-tw'); Module._load = originalLoad; globalThis.fetch = originalFetch; processRunner.runSpawn = originalSpawn;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
