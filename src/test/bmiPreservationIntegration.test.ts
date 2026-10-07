import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

test('real BMI workflow preserves exact passed assertions during review repair and across Tier fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmi-preservation-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const targetFile = path.join(root, 'bmi.py');
    const source = `def calculate_bmi(weight, height):
    height_m = height / 100
    value = round(weight / (height_m ** 2), 2)
    if value < 18.5:
        status = 'underweight'
    elif value < 24:
        status = 'normal'
    elif value < 27:
        status = 'overweight'
    else:
        status = 'obese'
    return value, status
`;
    const seed = `import unittest
from bmi import calculate_bmi
class Cases(unittest.TestCase):
    def test_normal(self):
        value, status = calculate_bmi(70, 170)
        self.assertAlmostEqual(value, 24.22, places=2)
        self.assertEqual(status, 'overweight')
`;
    const exceptionMethod = `    def test_zero_height(self):
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(70, 0)
`;
    const complete = seed + exceptionMethod;
    const wrongException = seed + `    def test_zero_height(self):
        self.assertEqual(calculate_bmi(70, 0), 0)
`;
    const weakened = complete.replace("self.assertEqual(status, 'overweight')", "self.assertGreaterEqual(status, 'overweight')");
    const dropped = 'import unittest\nfrom bmi import calculate_bmi\nclass Cases(unittest.TestCase):\n' + exceptionMethod;
    fs.writeFileSync(targetFile, source);
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let scenario: 'weakened' | 'dropped' = 'weakened';
    let writers = 0, revisions = 0, reviews = 0, requests = 0, fixes = 0;
    const writerPrompts: string[] = [], reviewPrompts: string[] = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (_url, options) => {
        requests++;
        assert.ok(requests <= 8, 'a rejected rewrite must not start unbounded model retries');
        const request = JSON.parse(String(options?.body));
        let response: string;
        if (request.system?.includes('You are the test Reviewer')) {
            reviews++; reviewPrompts.push(request.prompt);
            assert.doesNotMatch(request.prompt, /self\.assertGreaterEqual\(status/,
                'the weakened candidate must be rejected before review');
            response = JSON.stringify({ findings: reviews === 1 ? [{ category: 'missing-scenario', test_line: 'L5',
                reason: 'This case uses a positive height; a separate zero-height input is not tested.',
                action: 'Add a separate zero-height exception case while preserving this passing normal-input case and its exact assertions.' }] : [] });
        } else if (request.system?.includes('dependency_behaviors')) {
            response = '{"dependency_behaviors":[]}';
        } else if (request.system?.includes('Python unittest Bug Fixer')) {
            assert.equal(scenario, 'dropped');
            fixes++;
            // A real execution failure exhausts the ordinary Tier 2 repair
            // allowance; Reviewer unavailability never triggers a downgrade.
            response = '```python\ndef test_zero_height(self):\n    self.assertIsNone(calculate_bmi(70, 0))\n```';
        } else if (request.system?.includes('Analyst after successful')) {
            assert.fail('one measurement round must not request an unused quality plan');
        } else if (request.system?.includes('Revise the current tests')) {
            revisions++; writerPrompts.push(request.prompt);
            const code = scenario === 'weakened' ? revisions === 1 ? weakened : complete
                : revisions === 1 ? wrongException : complete;
            response = '```python\n' + code + '\n```';
        } else {
            writers++; writerPrompts.push(request.prompt);
            if (writers > 1) {
                assert.equal(scenario, 'dropped');
                assert.match(request.prompt, /def test_normal\(self\)/,
                    'Tier fallback must receive the complete retained executable method');
                assert.match(request.prompt, /self\.assertEqual\(status, 'overweight'\)/);
            }
            response = '```python\n' + (writers === 1 ? seed : dropped) + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture', paramSize: '13B', contextLength: 32768 });
        for (const selected of ['weakened', 'dropped'] as const) {
            scenario = selected; writers = 0; revisions = 0; reviews = 0; requests = 0; fixes = 0;
            writerPrompts.length = 0; reviewPrompts.length = 0;
            const output = path.join(root, 'results-' + scenario);
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: targetFile,
                funcName: 'calculate_bmi', outputPath: output, promptStrategy: 'tier2', maxLoops: 1,
                timeoutSeconds: 60, mutpyTimeout: 30, mutationEngine: 'builtin', validationMode: 'full' });
            const knowledgeFile = fs.readdirSync(output, { recursive: true }).map(String).find(name => path.basename(name) === 'function_knowledge.json');
            assert.ok(knowledgeFile, 'journal must exist');
            const runRoot = path.dirname(path.join(output, knowledgeFile));
            const knowledge = JSON.parse(fs.readFileSync(path.join(runRoot, 'function_knowledge.json'), 'utf8'));
            const events = fs.readFileSync(path.join(runRoot, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            const diagnostic = JSON.stringify({ scenario, writers, revisions, reviews, requests, fixes, failure: knowledge.lastFailure,
                preservation: events.filter(event => event.stage === 'passing-tests').map(event => event.detail) });
            assert.equal(revisions, 2, diagnostic);
            assert.equal(reviews, 2, diagnostic);
            assert.equal(writers, scenario === 'weakened' ? 1 : 2, diagnostic);
            assert.equal(fixes, scenario === 'weakened' ? 0 : 1, diagnostic);
            const rejected = events.filter(event => event.stage === 'passing-tests' && event.status === 'preservation-rejected');
            assert.equal(rejected.length, 1, diagnostic);
            assert.ok(rejected.every(event => event.detail.reasonCode === (scenario === 'weakened' ? 'assertion-weakened' : 'removed-passing-method')));
            const executedHashes = events.filter(event => event.stage === 'scenarios' && event.status === 'observed')
                .map(event => event.detail.codeHash);
            assert.equal(executedHashes.length, scenario === 'weakened' ? 2 : 4, diagnostic);
            assert.equal(new Set(executedHashes).size, executedHashes.length);
            assert.ok(!executedHashes.includes(evidenceHash(weakened.trim())));
            assert.ok(!executedHashes.includes(evidenceHash(dropped.trim())));
            assert.equal(events.filter(event => event.stage === 'mutation' && event.status === 'measured').length, 1, diagnostic);
            assert.equal(knowledge.reviewStatus, 'completed', diagnostic);
            assert.equal(knowledge.mutation.counts.executed, knowledge.mutation.counts.selected);
            assert.ok(knowledge.mutation.counts.executed > 0, 'real Python mutation engine must execute candidates');
            const checkpoint = JSON.parse(fs.readFileSync(path.join(runRoot, 'executable_baseline.json'), 'utf8'));
            const final = fs.readFileSync(path.join(runRoot, checkpoint.testFile), 'utf8');
            assert.equal(final.trim(), complete.trim());
            assert.equal(knowledge.reviewApproval.testHash, evidenceHash(final));
            assert.equal(knowledge.mutation.testHash, evidenceHash(final));
            assert.ok(reviewPrompts.every(prompt => /self\.assertEqual\(status, 'overweight'\)/.test(prompt)),
                'Reviewer must never see a candidate with the retained exact assertion missing');
            assert.equal(knowledge.tierHistory.transitions.length, scenario === 'weakened' ? 0 : 1);
            if (scenario === 'dropped') {
                assert.equal(knowledge.tierHistory.transitions[0].from, 2);
                assert.equal(knowledge.tierHistory.transitions[0].to, 1);
            }
            assert.equal(fs.readFileSync(targetFile, 'utf8'), source);
        }
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
