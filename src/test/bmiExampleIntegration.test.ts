import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';

test('BMI full-file entry discovers four functions and verifies real calls despite another project setup', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = path.join(repo, 'examples/bmi');
    const file = path.join(root, 'src/bmi.py');
    const before = fs.readFileSync(file, 'utf8');
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'bmi-integration-'));
    const python = resolvePythonExecutable(undefined, repo);
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>(), messages: any[] = [];
    const settings: Record<string, unknown> = { pythonPath: python, projectPath: root, validationMode: 'execution',
        importFixtureRoot: path.join(output, 'old-project'), importFixtures: [{ file: 'config.py', mkdir: true }] };
    const savedSettings = JSON.stringify(settings);
    const assertions: Record<string, string> = {
        positive_number: 'self.assertEqual(positive_number(5), 5.0)',
        calculate_bmi: 'self.assertEqual(calculate_bmi(80, 200), 20.0)',
        classify_bmi: 'self.assertEqual(classify_bmi(24), "體重過重")',
        bmi_report: 'self.assertEqual(bmi_report(80, 200), {"bmi": 20.0, "category": "健康體位"})'
    };
    let calls = 0;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { messages.push(message); return true; } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: repo } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    // Deterministic provider substitute: exercises the real command, AST,
    // preflight, validation and runner, not live-model generation quality.
    globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        const binding = request.prompt.match(/Target import: from ([\w.]+) import (\w+)/);
        assert.ok(binding); assert.ok(assertions[binding[2]]);
        calls++;
        const code = `import unittest\nfrom ${binding[1]} import ${binding[2]}\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        ${assertions[binding[2]]}\n`;
        return new Response(JSON.stringify({ response: '```python\n' + code + '\n```', done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: file,
            outputPath: output, promptStrategy: 'tier1', maxLoops: 2, timeoutSeconds: 30 });
        const reports = fs.readdirSync(output, { recursive: true }).map(String).filter(name => path.basename(name) === 'function_knowledge.json');
        assert.equal(reports.length, 4, JSON.stringify(messages));
        assert.equal(calls, 4);
        for (const report of reports) {
            const directory = path.dirname(path.join(output, report));
            const read = (name: string) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
            const knowledge = read('function_knowledge.json');
            assert.equal(knowledge.terminalStatus, 'execution-passed', JSON.stringify(knowledge.lastFailure));
            assert.equal(knowledge.importFixtureId, undefined);
            assert.equal(verifyExecutionEvidence(directory, file, read('execution_baseline.json'), read('run_manifest.json')), true);
        }
        assert.equal(JSON.stringify(settings), savedSettings);
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        assert.ok(messages.some(message => String(message.text).includes('全檔案流程結束')));
        assert.equal(messages.some(message => String(message.text).includes('掃描與測試執行完畢')), false);
    } finally {
        Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(output, { recursive: true, force: true });
    }
});
