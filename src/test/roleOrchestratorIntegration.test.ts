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
    const processRunner = require('../utils/processRunner');
    const originalSpawn = processRunner.runSpawn;
    const traceBuilder = require('../tier/tier1TestFileBuilder');
    const originalTraceBuilder = traceBuilder.buildTier1TestFile;
    const mutationRuns: Array<{ args: string[]; timeout: number }> = [];
    let expectedMutationSeconds = 20;
    let externalEngine: 'mutatest' | 'mutmut' | undefined;
    let externalRuns = 0;
    processRunner.runSpawn = (command: string, args: string[], options: any) => {
        if (externalEngine && (args[1] === 'from mutatest.cli import cli_main'
            || (args[1] === 'mutmut' && args[2] === '--version'))) {
            return Promise.resolve({ code: 0, stderr: '', stdout: '' });
        }
        if (externalEngine && (args.includes('mutmut') || args.some(arg => arg.includes('mutatest.cli')))) {
            assert.equal(options.timeout, expectedMutationSeconds * 1000);
            assert.ok(!args.includes('--timeout_factor'));
            assert.ok(!args.includes('--test-time-multiplier'));
            externalRuns++;
            return Promise.resolve({ code: 0, stderr: '', stdout: externalEngine === 'mutmut'
                ? '1 mutants\n0 survived\n' : 'TOTAL RUNS: 1\nSURVIVED: 0\n' });
        }
        if (args[0]?.endsWith('basic_mutation_runner.py')) {
            mutationRuns.push({ args, timeout: options.timeout });
            assert.equal(options.timeout, expectedMutationSeconds * 1000);
            assert.equal(args[4], String(expectedMutationSeconds));
        }
        return originalSpawn(command, args, options);
    };
    const handlers = new Map<string, (...args: any[]) => any>();
    const logs: string[] = [];
    const roles: string[] = [];
    let writers = 0;
    let reviewerAvailable = true;
    let rejectedReviewSchema = false;
    let rejectAllModelRequests = false;
    let scaffoldMode = false;
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
        assert.equal(rejectAllModelRequests, false, 'oversize evidence must never reach the provider');
        const request = JSON.parse(String(options?.body));
        assert.equal(request.options.num_ctx, 8572);
        let response: string;
        if (request.system.includes('You are the test Reviewer')) {
            if (!rejectedReviewSchema && typeof request.format === 'object') {
                assert.equal(request.format.properties.findings.maxItems, 5);
                rejectedReviewSchema = true;
                return new Response('unsupported schema', { status: 400 });
            }
            roles.push('reviewer'); response = reviewerAvailable ? '{"findings":[]}' : 'invalid review';
        } else if (request.system.includes('Analyst after successful')) {
            roles.push('analyst-quality'); response = '{"tasks":[]}';
        } else if (request.system.includes('dependency_behaviors')) {
            roles.push('analyst-planning'); response = '{"dependency_behaviors":[]}';
        } else {
            roles.push('writer'); writers++;
            assert.match(request.prompt, scaffoldMode ? /Complete Writer evidence/ : /^compact-writer-v1/);
            assert.match(request.prompt, scaffoldMode ? /def read/ : /RETRIEVED DEPENDENCY read/);
            if (writers > 1 && !scaffoldMode) { assert.match(request.prompt, /mixed truth values|Return-value survivor/); }
            response = '```python\n' + (writers === 1 ? code : stronger) + '\n```';
        }
        return new Response(JSON.stringify({ response }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const fixtureFetcher = globalThis.fetch;
    try {
        fs.writeFileSync(path.join(directory, 'helper.py'), "def read(): return {'ready': True, 'kind': 'plain'}\n");
        fs.writeFileSync(path.join(directory, 'sample.py'), "from helper import read\ndef target():\n    state = read()\n    if state['ready'] and state['kind'] == 'plain':\n        return True\n    return False\ndef unrelated():\n    return 'not selected'\n");
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture-model',
            paramSize: '13B', contextLength: 32768, qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true, testGenerationMode: 'plain-unittest' });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 3, timeoutSeconds: 60, outputPath: path.join(directory, 'results') });
        const roots = fs.readdirSync(path.join(directory, 'results'));
        const output = path.join(directory, 'results', roots[0], 'target');
        const report = fs.readFileSync(path.join(output, 'final_report.md'), 'utf8');
        assert.doesNotMatch(report, /執行中斷/, logs.join('\n'));
        const manifest = JSON.parse(fs.readFileSync(path.join(output, 'run_manifest.json'), 'utf8'));
        assert.equal(manifest.promptVersion, 'role-contracts-v5');
        assert.equal(manifest.roleContracts.reviewer, 'review-v5');
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
        assert.equal(events[firstStage('evidence-collection')].detail.dependencyCount, 1);
        assert.ok(firstStage('validation') < firstStage('reviewer'));
        const requests = events.filter(event => event.stage === 'model-request' && event.status === 'requested');
        assert.ok(requests.length > 0);
        assert.ok(requests.every(event => event.detail.estimatedInputTokens <= event.detail.inputBudget));
        assert.ok(events.some(event => event.stage === 'model-request' && event.status === 'completed'
            && event.detail.elapsedMs >= 0 && event.detail.writerContext === 'compact-writer-v1'));
        assert.equal(rejectedReviewSchema, true);
        const mutations = events.filter(event => event.stage === 'mutation');
        assert.equal(mutations.length, 2, logs.join('\n'));
        assert.equal(mutationRuns.length, 2);
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
        assert.equal(knowledge.reviewStatus, 'completed');
        assert.equal(knowledge.terminalStatus, 'passed');
        assert.notEqual(knowledge.coverage.coverageText, '100%', 'unrelated callable remains outside target scope');
        assert.equal(knowledge.coverage.selectedTarget.qualifiedName, 'target');
        assert.deepEqual(knowledge.coverage.selectedTarget.missingLines, []);
        assert.equal(knowledge.resolvedTier, 1);
        assert.match(report, /Reviewer status\*\*: completed/);

        reviewerAvailable = false;
        expectedMutationSeconds = 40;
        writers = 0;
        roles.length = 0;
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 3, mutpyTimeout: 40, timeoutSeconds: 60, outputPath: path.join(directory, 'incomplete-results') });
        const incompleteRoot = path.join(directory, 'incomplete-results');
        const incompleteOutput = path.join(incompleteRoot, fs.readdirSync(incompleteRoot)[0], 'target');
        const incomplete = JSON.parse(fs.readFileSync(path.join(incompleteOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(incomplete.mutationScore, 100);
        assert.equal(incomplete.reviewStatus, 'incomplete');
        assert.equal(incomplete.terminalStatus, 'execution-passed-review-incomplete');
        assert.equal(roles.filter(role => role === 'reviewer').length, 2);
        const incompleteEvents = fs.readFileSync(path.join(incompleteOutput, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(incompleteEvents.some(event => event.stage === 'reviewer' && event.status === 'invalid-response'
            && event.detail.diagnostics.includes('invalid-json')));

        // External executables are replaced only at their process boundary;
        // real coverage/target setup and production option routing still run.
        reviewerAvailable = true;
        expectedMutationSeconds = 25;
        for (const engine of ['mutatest', 'mutmut'] as const) {
            externalEngine = engine;
            utilities.detectMutationEngine = () => engine;
            writers = 0;
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
                filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
                maxLoops: 1, mutpyTimeout: 25, timeoutSeconds: 60, outputPath: path.join(directory, engine + '-results') });
        }
        assert.equal(externalRuns, 2);
        externalEngine = undefined;
        utilities.detectMutationEngine = () => null;

        rejectAllModelRequests = true;
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture-model',
            paramSize: '1B', contextLength: 128, qualificationVersion: QUALIFICATION_VERSION,
            testGenerationReady: true, testGenerationMode: 'plain-unittest' });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 1, timeoutSeconds: 60, outputPath: path.join(directory, 'oversize-results') });
        const oversizeRoot = path.join(directory, 'oversize-results');
        const oversizeOutput = path.join(oversizeRoot, fs.readdirSync(oversizeRoot)[0], 'target');
        const oversizeEvents = fs.readFileSync(path.join(oversizeOutput, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(oversizeEvents.some(event => event.stage === 'model-request' && event.status === 'budget-exceeded'));
        assert.ok(!oversizeEvents.some(event => event.stage === 'model-request' && event.status === 'requested'));

        // Service failures retain their category and never launch lower-Tier Writer retries.
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture-model',
            paramSize: '13B', contextLength: 32768, qualificationVersion: QUALIFICATION_VERSION,
            testGenerationReady: true, testGenerationMode: 'plain-unittest' });
        let serviceCalls = 0;
        globalThis.fetch = async () => { serviceCalls++; return new Response('PROVIDER_BODY_MUST_REMAIN_PRIVATE', { status: 500 }); };
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier3',
            maxLoops: 1, timeoutSeconds: 60, outputPath: path.join(directory, 'service-failure') });
        const serviceRoot = path.join(directory, 'service-failure');
        const serviceOutput = path.join(serviceRoot, fs.readdirSync(serviceRoot)[0], 'target');
        const serviceJournal = fs.readFileSync(path.join(serviceOutput, 'role_events.jsonl'), 'utf8');
        assert.doesNotMatch(serviceJournal, /PROVIDER_BODY_MUST_REMAIN_PRIVATE/);
        const serviceEvents = serviceJournal.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(serviceCalls, 6, 'three bounded attempts each for planning and Writer');
        assert.equal(serviceEvents.filter(event => event.stage === 'model-request' && event.status === 'requested' && event.detail.role === 'writer').length, 1);
        assert.ok(serviceEvents.filter(event => event.stage === 'model-request' && event.status === 'error').every(event => event.detail.category === 'model-api'));

        globalThis.fetch = fixtureFetcher;
        rejectAllModelRequests = false;
        scaffoldMode = true;
        writers = 1;
        roles.length = 0;
        expectedMutationSeconds = 20;
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier3',
            maxLoops: 1, timeoutSeconds: 60, outputPath: path.join(directory, 'scaffold-results') });
        const scaffoldRoot = path.join(directory, 'scaffold-results');
        const scaffoldOutput = path.join(scaffoldRoot, fs.readdirSync(scaffoldRoot)[0], 'target');
        const scaffoldKnowledge = JSON.parse(fs.readFileSync(path.join(scaffoldOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(scaffoldKnowledge.terminalStatus, 'passed', scaffoldKnowledge.failure);
        assert.equal(scaffoldKnowledge.resolvedTier, 3);
        assert.deepEqual(roles, ['analyst-planning', 'writer', 'reviewer'], 'complete scaffold output needs no wrapping repair or Tier fallback');

        traceBuilder.buildTier1TestFile = (...args: any[]) => {
            const built = originalTraceBuilder(...args);
            return { ...built, code: built.code?.replace('import unittest', "import unittest\n__import__('math')") };
        };
        scaffoldMode = false;
        writers = 0;
        roles.length = 0;
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 1, timeoutSeconds: 60, outputPath: path.join(directory, 'bad-runner-baseline') });
        const badRoot = path.join(directory, 'bad-runner-baseline');
        const badOutput = path.join(badRoot, fs.readdirSync(badRoot)[0], 'target');
        const badKnowledge = JSON.parse(fs.readFileSync(path.join(badOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(badKnowledge.failureStage, 'trace-baseline');
        assert.deepEqual(roles, ['analyst-planning', 'writer'], 'runner-owned failure never consumes model repair or review');
    } finally {
        globalThis.fetch = originalFetch;
        Module._load = originalLoad;
        utilities.detectMutationEngine = originalEngine;
        processRunner.runSpawn = originalSpawn;
        traceBuilder.buildTier1TestFile = originalTraceBuilder;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

