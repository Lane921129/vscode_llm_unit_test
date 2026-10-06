import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { evidenceHash } from '../pipeline/analysisJournal';

test('real quality loop preserves a passed seed and improves object-state mutants without another Writer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-loop-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const targetFile = path.join(root, 'ledger.py');
    const source = `class Ledger:
    def __init__(self):
        self.entries = {}
    def increase(self, name: str, units: int = 1):
        if name in self.entries:
            self.entries[name] += units
        else:
            self.entries[name] = units
`;
    const weak = `import unittest
from ledger import Ledger
class ModelCases(unittest.TestCase):
    def setUp(self):
        self.ledger = Ledger()
    def test_real_calls(self):
        self.assertIsNone(self.ledger.increase('entry', 2))
        self.assertIsNone(self.ledger.increase('entry', 3))
`;
    fs.writeFileSync(targetFile, source);
    const handlers = new Map<string, (...args: any[]) => any>();
    const roles: string[] = [];
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
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
        const request = JSON.parse(String(options?.body));
        let response: string;
        if (request.system?.includes('You are the test Reviewer')) {
            roles.push('reviewer'); response = '{"findings":[]}';
        } else if (request.system?.includes('Analyst after successful')) {
            roles.push('quality-analyst'); response = '{"tasks":[]}';
        } else if (request.system?.includes('dependency_behaviors')) {
            roles.push('planning'); response = '{"dependency_behaviors":[]}';
        } else {
            roles.push('writer'); response = '```python\n' + weak + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture', paramSize: '13B', contextLength: 32768 });
        const output = path.join(root, 'results');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: targetFile,
            funcName: 'Ledger.increase', outputPath: output, promptStrategy: 'tier2', maxLoops: 3,
            timeoutSeconds: 30, mutpyTimeout: 30, mutationEngine: 'builtin', validationMode: 'full' });
        const knowledgeFile = fs.readdirSync(output, { recursive: true }).map(String).find(name => path.basename(name) === 'function_knowledge.json');
        assert.ok(knowledgeFile, 'journal must exist');
        const runRoot = path.dirname(path.join(output, knowledgeFile));
        const knowledge = JSON.parse(fs.readFileSync(path.join(runRoot, 'function_knowledge.json'), 'utf8'));
        const events = fs.readFileSync(path.join(runRoot, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify({ failure: knowledge.lastFailure, roles }));
        const seedAccepted = events.findIndex(e => e.stage === 'writer-seed' && e.status === 'accepted');
        const review = events.findIndex(e => e.stage === 'reviewer' && e.status === 'parsed');
        assert.ok(seedAccepted >= 0 && review > seedAccepted);
        const measurements = events.filter(e => e.stage === 'mutation' && e.status === 'measured');
        assert.equal(measurements.length, 2, JSON.stringify(roles));
        assert.ok(measurements[1].detail.score > measurements[0].detail.score);
        assert.equal(measurements[1].detail.score, 100);
        assert.ok(events.some(e => e.stage === 'quality-experiment' && e.status === 'observed'));
        assert.ok(events.some(e => e.stage === 'quality-experiment-baseline' && e.status === 'passed'));
        assert.ok(events.some(e => e.stage === 'quality-experiment' && e.status === 'improved'));
        assert.equal(roles.filter(role => role === 'writer').length, 1, 'tool-observed candidate must skip a redundant Writer request');
        assert.equal(roles.filter(role => role === 'quality-analyst').length, 0);
        assert.equal(roles.filter(role => role === 'reviewer').length, 2);
        const final = fs.readFileSync(path.join(runRoot, knowledge.acceptedTest), 'utf8');
        assert.ok(final.includes('class ModelCases'));
        assert.ok(final.includes('class TestVerifiedState_'));
        assert.ok(final.includes('instance.entries'));
        assert.equal(knowledge.acceptedCodeHash, evidenceHash(final));
        assert.equal(knowledge.mutation.testHash, knowledge.acceptedCodeHash);
        assert.equal(knowledge.mutation.counts.error + knowledge.mutation.counts.timeout + knowledge.mutation.counts.notRun, 0);
        assert.equal(fs.readFileSync(targetFile, 'utf8'), source);

        // A synthetic credential-shaped response must stop before it becomes a
        // candidate file, executable seed, mutation input, or report detail.
        const syntheticCredential = 'sk-' + 'x'.repeat(32);
        let rejectedRequests = 0;
        globalThis.fetch = async () => {
            rejectedRequests++;
            return new Response(JSON.stringify({ response: syntheticCredential, done: true }), { status: 200 });
        };
        const rejectedOutput = path.join(root, 'rejected-results');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: targetFile,
            funcName: 'Ledger.increase', outputPath: rejectedOutput, promptStrategy: 'tier2', maxLoops: 3,
            timeoutSeconds: 30, mutpyTimeout: 30, mutationEngine: 'builtin', validationMode: 'full' });
        const rejectedFiles = fs.readdirSync(rejectedOutput, { recursive: true }).map(String)
            .map(name => path.join(rejectedOutput, name)).filter(file => fs.statSync(file).isFile());
        const rejectedKnowledgeFile = rejectedFiles.find(file => path.basename(file) === 'function_knowledge.json');
        assert.ok(rejectedKnowledgeFile);
        const rejectedKnowledge = JSON.parse(fs.readFileSync(rejectedKnowledgeFile, 'utf8'));
        assert.equal(rejectedKnowledge.failureStage, 'sensitive-output');
        assert.equal(rejectedRequests, 1);
        const rejectedEvents = rejectedFiles.filter(file => path.basename(file) === 'role_events.jsonl')
            .flatMap(file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
        assert.ok(!rejectedEvents.some(e => e.stage === 'writer-seed' && e.status === 'accepted'));
        assert.ok(!rejectedEvents.some(e => e.stage === 'mutation'));
        for (const file of rejectedFiles) {
            assert.ok(!fs.readFileSync(file).includes(Buffer.from(syntheticCredential)), path.relative(rejectedOutput, file));
        }
        assert.ok(!rejectedFiles.some(file => /(?:^|[\\/])loop\d+_(?:seed|test)\.py$/.test(file)));
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
