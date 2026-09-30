import { functionReportDirectory, roundDirectory } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { setLanguage } from '../i18n/core';

test('full mode calculates laboratory BMI failures, verifies exact calls, reruns tests and measures real mutations', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-full-'));
    const file = path.join(root, 'bmi.py');
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
    const correctException = '    def test_zero_height(self):\n        with self.assertRaises(ZeroDivisionError):\n            calculate_bmi(70, 0)\n';
    const candidate = fs.readFileSync(path.join(repo, 'test/fixtures/repair/bmi_unpack_wrong.py'), 'utf8')
        + '\n    def test_seventy(self):\n        bmi, status = calculate_bmi(70, 170)\n'
        + '        self.assertEqual(bmi, 24.9)\n        self.assertEqual(status, "健康體位")\n'
        + '    def test_zero_weight(self):\n        with self.assertRaises(ZeroDivisionError):\n            calculate_bmi(0, 1)\n'
        + correctException;
    fs.writeFileSync(file, source);
    const settings: Record<string, unknown> = { pythonPath: resolvePythonExecutable(undefined, repo), projectPath: root, language: 'en' };
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let writers = 0, fixes = 0;
    const logs: string[] = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
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
    globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        let response: string;
        if (request.system.includes('dependency_behaviors')) { response = '{"dependency_behaviors":[]}'; }
        else if (request.system.includes('You are the test Reviewer')) { response = 'invalid reviewer reply'; }
        else if (request.system.includes('Python unittest Bug Fixer')) { fixes++; response = '```python\npass\n```'; }
        else { writers++; response = '```python\n' + candidate + '\n```'; }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture', paramSize: '13B', contextLength: 32768 });
        const outputPath = path.join(root, 'results');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: file,
            funcName: 'calculate_bmi', outputPath, promptStrategy: 'tier2', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 60, mutpyTimeout: 30 });
        const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json')!;
        assert.ok(report, logs.join('\n'));
        const directory = path.dirname(path.join(outputPath, report));
        const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const numeric = events.find(e => e.stage === 'numeric-skill' && e.status === 'verified');
        assert.ok(numeric, JSON.stringify(events.filter(e => /numeric|failed|rejected/.test(e.stage + e.status))));
        assert.equal(writers, 1, 'tool correction must not require another model generation');
        assert.equal(fixes, 0, 'verified arithmetic correction precedes model repair');
        const proof = JSON.parse(fs.readFileSync(path.join(roundDirectory(directory, 1), numeric.detail.file), 'utf8'));
        assert.equal(proof.corrections.length, 8, 'five numeric mismatches, two classifications and zero-weight expectation');
        assert.equal(new Set(proof.corrections.map((item: any) => JSON.stringify(item.basis.call))).size, 6);
        assert.ok(proof.trace.cases.length >= 6);
        assert.equal(proof.trace.cases.filter((item: any) => item.source.kind === 'semantic_guided'
            && item.source.detail === 'numeric-calculation').length, 6, 'model-selected inputs must not be labeled as source callers');
        const baseline = JSON.parse(fs.readFileSync(path.join(directory, 'executable_baseline.json'), 'utf8'));
        const actual = fs.readFileSync(path.join(directory, baseline.testFile), 'utf8');
        assert.equal(baseline.codeHash, proof.candidateTestHash);
        assert.ok(actual.includes(correctException.trimEnd()));
        assert.match(actual, /self.assertEqual\(bmi, 24.22\)/);
        assert.match(actual, /self.assertEqual\(calculate_bmi\(0, 1\), \(0.0, '體重過輕'\)\)/);
        assert.ok(events.some(e => e.stage === 'mutation' && e.status === 'measured'));
        assert.ok(fs.existsSync(path.join(roundDirectory(directory, 1), 'loop1_mutation.json')));
        const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
        assert.equal(knowledge.reviewStatus, 'incomplete', 'numeric skill does not waive Reviewer completion');
        assert.notEqual(knowledge.terminalStatus, 'passed');
        assert.match(logs.join('\n'), /Calculation agrees with isolated execution/);
        assert.match(fs.readFileSync(path.join(roundDirectory(directory, 1), 'failure_report.md'), 'utf8'), /numeric-skill/);
        assert.ok(fs.existsSync(path.join(functionReportDirectory(directory), 'final_report.md')));
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        setLanguage('zh-tw'); Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
