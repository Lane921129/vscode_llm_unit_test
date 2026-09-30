import { resultArtifactPath } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';

test('BMI no-op method repair hands off to Writer through real command, gates and guarded execution', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmi-repair-'));
    const file = path.join(root, 'bmi.py');
    // A builtin outside the bounded arithmetic subset keeps this test on the
    // model fallback path. The raw laboratory candidate is covered separately.
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8')
        .replace('height_cm / 100', 'float(height_cm) / 100');
    fs.writeFileSync(file, source);
    const python = resolvePythonExecutable(undefined, repo);
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const settings: Record<string, unknown> = { pythonPath: python, projectPath: root, validationMode: 'execution' };
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    const method = `    def test_calculate_bmi(self):
        weight_kg = 50
        height_cm = 160
        expected_bmi = 18.5
        expected_status = "體重過輕"
        result = calculate_bmi(weight_kg, height_cm)
        self.assertEqual(result[0], expected_bmi)
        self.assertEqual(result[1], expected_status)
`;
    const keep = '    def test_keep(self):\n        self.assertEqual(calculate_bmi(80, 200), (20.0, "健康體位"))\n';
    const wrong = 'import unittest\nfrom bmi import calculate_bmi\nclass TestCalculateBmi(unittest.TestCase):\n' + method + keep;
    const initial = wrong.replace('import unittest', 'import unittest\nfrom unittest.mock import patch')
        .replace('    def test_calculate_bmi', '    @patch("bmi.calculate_bmi")\n    def test_calculate_bmi');
    const corrected = wrong.replace('expected_bmi = 18.5', 'expected_bmi = 19.53')
        .replace('expected_status = "體重過輕"', 'expected_status = "健康體位"');
    // Reproduce the observed class-wrapped, unchanged method. Use one extra
    // passing case to verify immutable candidate filenames do not lose it.
    const noChange = 'class TestCalculateBmi(unittest.TestCase):\n' + method.replace('        expected_bmi', '\n        expected_bmi');
    const fence = (code: string) => '```python\n' + code + '\n```';
    let replies: string[] = [], requests: any[] = [];
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(String(options?.body)); requests.push(request);
        assert.ok(!/You are the test Reviewer|SEMANTIC_ANALYZER|QUALITY_TASK/.test(request.system));
        assert.ok(replies.length > 0, 'no unbounded extra request');
        return new Response(JSON.stringify({ response: fence(replies.shift()!), done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture',
            paramSize: '13B', contextLength: 32768 });
        for (const [name, recovery, expectedPass] of [
            ['corrected', corrected, true], ['dropped-case', corrected.replace(keep, ''), false],
            ['unchanged-again', wrong, false], ['target-mocked-again', initial, false]
        ] as const) {
            requests = []; replies = [initial, wrong, noChange, recovery];
            const outputPath = path.join(root, name);
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: file,
                funcName: 'calculate_bmi', outputPath, promptStrategy: 'tier2', maxLoops: 2, timeoutSeconds: 30 });
            const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json')!;
            const directory = path.dirname(path.join(outputPath, report));
            const read = (name: string) => JSON.parse(fs.readFileSync(resultArtifactPath(directory, name), 'utf8'));
            const knowledge = read('function_knowledge.json');
            const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            assert.equal(requests.length, 4, name + ': ' + JSON.stringify(knowledge.lastFailure));
            assert.match(requests[2].system, /BUG_FIX_REQUEST_V5/);
            assert.match(requests[3].prompt, /FOCUSED REPAIR MADE NO EFFECTIVE CHANGE/);
            assert.match(requests[3].prompt, /19.53 != 18.5/);
            assert.equal(events.filter(e => e.detail?.action === 'writer-recovery').length, 1);
            assert.ok(events.some(e => e.status === 'format-normalized' && e.detail.classWrapperRemoved));
            assert.ok(events.some(e => e.status === 'scope-rejected' && e.detail.diagnostic.reasonCodes.includes('no-method-change')));
            assert.equal(fs.readFileSync(file, 'utf8'), source);
            assert.equal(fs.existsSync(path.join(directory, 'execution_baseline.json')), expectedPass, name);
            if (expectedPass) {
                assert.equal(knowledge.terminalStatus, 'execution-passed', JSON.stringify(knowledge.lastFailure));
                assert.equal(knowledge.acceptedTest, 'exec2_test.py');
                assert.equal(verifyExecutionEvidence(directory, file, read('execution_baseline.json'), read('run_manifest.json')), true);
                assert.equal(knowledge.reviewStatus, 'deferred');
                const invocation = read(read('execution_baseline.json').invocationFile);
                assert.equal(invocation.testResult.testsRun, 2);
                assert.equal(invocation.observed, true);
            } else {
                assert.equal(knowledge.terminalStatus, 'failed', name);
                if (name === 'dropped-case') { assert.match(knowledge.failure, /Previously passing tests/); }
            }
        }
    } finally {
        Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
