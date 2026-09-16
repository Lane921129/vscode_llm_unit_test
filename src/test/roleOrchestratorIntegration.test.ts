import { QUALIFICATION_VERSION } from '../llm/modelQualification';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

test('orchestrator carries measured quality into Writer and verifies improvement with real Python mutation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'role-orchestrator-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module');
    const originalLoad = Module._load;
    const originalFetch = globalThis.fetch;
    const utilities = require('../utils/utils');
    const originalEngine = utilities.detectMutationEngine;
    const handlers = new Map<string, (...args: any[]) => any>();
    const logs: string[] = [];
    const roles: string[] = [];
    let writers = 0;
    const code = `import unittest
from unittest.mock import patch
from sample import target
class Cases(unittest.TestCase):
    def test_true(self):
        with patch('sample.read', return_value={'ready': True, 'kind': 'plain'}):
            self.assertTrue(target())
    def test_false(self):
        with patch('sample.read', return_value={'ready': False, 'kind': 'other'}):
            self.assertFalse(target())
`;
    const stronger = code.replace('self.assertFalse(target())', 'self.assertIs(target(), False)') + `
    def test_mixed(self):
        with patch('sample.read', return_value={'ready': True, 'kind': 'other'}):
            self.assertIs(target(), False)
`;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        window: {
            registerWebviewViewProvider: (_: string, provider: any) => {
                provider.webview = { postMessage: (message: any) => { if (message.text) { logs.push(message.text); } return Promise.resolve(true); } };
                return { dispose() {} };
            },
            showInformationMessage: async () => {}, showTextDocument: async () => {}
        },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: () => python }), openTextDocument: async () => ({}) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } },
        env: { openExternal: async () => true }, Uri: { file: (file: string) => file }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    utilities.detectMutationEngine = () => null;
    globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        let response: string;
        if (request.system.includes('You are the test Reviewer')) {
            roles.push('reviewer'); response = '{"issues":[]}';
        } else if (request.system.includes('Analyst after successful')) {
            roles.push('analyst-quality'); response = '{"tasks":[]}';
        } else if (request.system.includes('dependency_behaviors')) {
            roles.push('analyst-planning'); response = '{"dependency_behaviors":[]}';
        } else {
            roles.push('writer'); writers++;
            if (writers > 1) { assert.match(request.prompt, /mixed truth values|Return-value survivor/); }
            response = '```python\n' + (writers === 1 ? code : stronger) + '\n```';
        }
        return new Response(JSON.stringify({ response }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        fs.writeFileSync(path.join(directory, 'sample.py'), "def read(): return {'ready': True, 'kind': 'plain'}\ndef target():\n    state = read()\n    if state['ready'] and state['kind'] == 'plain':\n        return True\n    return False\n");
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture-model',
            paramSize: '32B', contextLength: 32768, qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true, testGenerationMode: 'plain-unittest' });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 3, timeoutSeconds: 60, outputPath: path.join(directory, 'results') });
        const roots = fs.readdirSync(path.join(directory, 'results'));
        const output = path.join(directory, 'results', roots[0], 'target');
        const report = fs.readFileSync(path.join(output, 'final_report.md'), 'utf8');
        assert.doesNotMatch(report, /執行中斷/, logs.join('\n'));
        const manifest = JSON.parse(fs.readFileSync(path.join(output, 'run_manifest.json'), 'utf8'));
        assert.equal(manifest.promptVersion, 'role-contracts-v4');
        assert.equal(manifest.roleContracts.reviewer, 'review-v4');
        assert.equal(manifest.evidenceContracts.analystEvidence, 'analysis-evidence-v2');
        assert.equal(manifest.evidenceContracts.semanticPlan, 'semantic-plan-v2');
        assert.equal(manifest.evidenceContracts.ruleSelection, 'rule-selection-v2');
        assert.equal(manifest.evidenceContracts.writerEvidence, 'writer-evidence-v3');
        const events = fs.readFileSync(path.join(output, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const firstStage = (stage: string) => events.findIndex(event => event.stage === stage);
        assert.ok(firstStage('evidence-collection') < firstStage('analyst-planning'));
        assert.ok(firstStage('analyst-planning') < firstStage('rule-dispatcher'));
        assert.ok(firstStage('rule-dispatcher') < firstStage('writer-handoff'));
        assert.ok(firstStage('writer-handoff') < firstStage('writer'));
        assert.equal(events[firstStage('rule-dispatcher')].detail.provenance, 'deterministic');
        const mutations = events.filter(event => event.stage === 'mutation');
        assert.equal(mutations.length, 2, logs.join('\n'));
        assert.ok(mutations[0].detail.score < 100);
        assert.equal(mutations[1].detail.score, 100);
        assert.deepEqual(roles.filter(role => role !== 'analyst-planning'), ['writer', 'reviewer', 'analyst-quality', 'writer', 'reviewer']);
        const knowledge = JSON.parse(fs.readFileSync(path.join(output, 'function_knowledge.json'), 'utf8'));
        assert.equal(knowledge.schemaVersion, 2);
        assert.equal(knowledge.selectedRules.schemaVersion, 'rule-selection-v2');
        assert.equal(knowledge.planningHypotheses.schemaVersion, 'semantic-plan-v2');
        assert.ok('initialTargetObservations' in knowledge);
        assert.ok('supplementalTargetObservations' in knowledge);
        assert.equal(knowledge.mutationScore, 100);
        assert.deepEqual(knowledge.survivors, []);
        assert.ok(knowledge.scenarios.length >= 3);
    } finally {
        globalThis.fetch = originalFetch;
        Module._load = originalLoad;
        utilities.detectMutationEngine = originalEngine;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

