import { readOllamaRoleRequest } from './ollamaRequestFixture';
import { functionReportDirectory } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { BatchJournal } from '../pipeline/batchJournal';
import { setLanguage } from '../i18n/core';

test('80 percent policy accepts real surviving mutants and verifies the same completed result in batch', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-full-'));
    const file = path.join(root, 'bmi.py');
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
    const candidate = `import unittest
from bmi import calculate_bmi
class Cases(unittest.TestCase):
    def test_value_0(self):
        self.assertEqual(calculate_bmi(50, 160), (19.53, "健康體位"))
    def test_value_1(self):
        self.assertEqual(calculate_bmi(17, 100), (17.0, "體重過輕"))
    def test_value_2(self):
        self.assertEqual(calculate_bmi(18.5, 100), (18.5, "健康體位"))
    def test_value_3(self):
        self.assertEqual(calculate_bmi(24, 100), (24.0, "體重過重"))
    def test_value_4(self):
        self.assertEqual(calculate_bmi(27, 100), (27.0, "肥胖"))
    def test_value_5(self):
        self.assertEqual(calculate_bmi(-1, -1), (-10000.0, "體重過輕"))
    def test_zero_height(self):
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(0, 0)
    def test_string(self):
        with self.assertRaises(TypeError):
            calculate_bmi("a", "a")
`;
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
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) { response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the real selected target with controlled inputs and use only verified observations for assertions."}}'; }
        else if (request.roleInstructions.includes('You are the test Reviewer')) { response = '{"findings":[]}'; }
        else if (request.roleInstructions.includes('Python unittest Bug Fixer')) { fixes++; response = '```python\npass\n```'; }
        else { writers++; response = '```python\n' + candidate + '\n```'; }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture', paramSize: '13B', contextLength: 32768 });
        settings.mutationEngine = 'mutmut';
        const blockedOutput = path.join(root, 'blocked');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: file,
            funcName: 'calculate_bmi', outputPath: blockedOutput, promptStrategy: 'tier2', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 60, mutpyTimeout: 120 });
        const blockedRelative = fs.readdirSync(blockedOutput, { recursive: true }).map(String)
            .find(p => path.basename(p) === 'function_knowledge.json')!;
        const blocked = JSON.parse(fs.readFileSync(path.join(blockedOutput, blockedRelative), 'utf8'));
        assert.equal(blocked.firstFailure.category, 'environment');
        assert.equal(writers, 0, 'an unavailable selected engine must stop before model generation');
        assert.equal(fixes, 0);
        assert.equal(blocked.mutation, undefined, 'cannot silently measure with builtin');
        settings.mutationEngine = 'builtin';
        const outputPath = path.join(root, 'results');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: file,
            funcName: 'calculate_bmi', outputPath, promptStrategy: 'tier2', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 60, mutpyTimeout: 120 });
        const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json')!;
        assert.ok(report, logs.join('\n'));
        const directory = path.dirname(path.join(outputPath, report));
        const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
        assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.qualityAssessment || knowledge.lastFailure));
        assert.equal(knowledge.qualityPolicy.policyId, 'standard80-v1');
        assert.equal(knowledge.qualityAssessment.fullyPassed, true);
        assert.equal(knowledge.reviewStatus, 'completed');
        assert.equal(knowledge.mutation.operatorSetVersion, 'builtin-ast-v2');
        assert.ok(knowledge.mutation.counts.selected > 19);
        assert.ok(knowledge.mutation.counts.survived > 0, 'surviving mutants remain in the full denominator');
        assert.equal(knowledge.mutation.counts.killed + knowledge.mutation.counts.survived, knowledge.mutation.counts.available);
        assert.ok(knowledge.mutation.mutants.filter((m: any) => m.status === 'KILLED').every((m: any) => m.killedBy.length));
        assert.equal(writers, 1, 'meeting the policy must not trigger a second generation');
        assert.equal(fixes, 0);
        assert.equal(events.filter(e => e.stage === 'mutation' && e.status === 'measured').length, 1);
        const final = fs.readFileSync(path.join(functionReportDirectory(directory), 'final_report.md'), 'utf8');
        assert.match(final, /Final outcome: Fully passed/);
        assert.match(final, /threshold ≥ 80%/);
        assert.match(final, /builtin-ast-v2/);
        assert.match(final, /Mutation execution diagnostics/);
        assert.match(final, /SURVIVED/);
        const batch = new BatchJournal(outputPath, root, { model: 'local/neutral-fixture', buildTimestamp: 'fixture', python: String(settings.pythonPath) });
        batch.discover(file, ['calculate_bmi']); batch.start(); batch.begin(0);
        batch.attach(0, functionReportDirectory(directory)); batch.refresh(0); batch.finish('completed');
        const summary = JSON.parse(fs.readFileSync(path.join(outputPath, 'batch_manifest.json'), 'utf8'));
        assert.equal(summary.allTargetsPassed, true, JSON.stringify(summary.statusCounts));
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        setLanguage('zh-tw'); Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
