import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
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
    let failBuiltinMutation = false;
    let mutateDuringMutation: 'source' | 'test' | undefined;
    let changeBeforeNextRound = false;
    let externalEvidence: 'passed' | 'isolation-blocked' | 'missing' = 'passed';
    processRunner.runSpawn = (command: string, args: string[], options: any) => {
        if (externalEngine && (args[1] === 'from mutatest.cli import cli_main'
            || (args[1] === 'mutmut' && args[2] === '--version'))) {
            return Promise.resolve({ code: 0, stderr: '', stdout: '' });
        }
        if (externalEngine && (args.includes('mutmut') || args.some(arg => arg.includes('mutatest.cli')))) {
            assert.equal(options.timeout, expectedMutationSeconds * 1000);
            assert.ok(!args.includes('--timeout_factor'));
            assert.ok(!args.includes('--test-time-multiplier'));
            const runner = args[args.indexOf(externalEngine === 'mutmut' ? '--runner' : '-t') + 1];
            const report = runner.match(/["']--violation-report["'] ["']([^"']+)["']/)?.[1];
            assert.ok(report, 'native engines must invoke the guarded runner with an evidence report');
            const runId = 'a'.repeat(32);
            if (externalEvidence !== 'missing') {
                fs.writeFileSync(report, [JSON.stringify({ runId, event: 'started' }),
                    JSON.stringify({ runId, event: 'completed', status: externalEvidence })].join('\n'));
            }
            externalRuns++;
            return Promise.resolve({ code: 0, stderr: '', stdout: externalEngine === 'mutmut'
                ? '1 mutants\n0 survived\n' : 'TOTAL RUNS: 1\nSURVIVED: 0\n' });
        }
        if (args[0]?.endsWith('basic_mutation_runner.py')) {
            if (failBuiltinMutation) { return Promise.reject(new Error('mutation stage timeout')); }
            mutationRuns.push({ args, timeout: options.timeout });
            assert.equal(options.timeout, (expectedMutationSeconds + 5) * 1000);
            assert.equal(args[3], '0', 'selected function measurement enumerates the full candidate set');
            assert.equal(args[4], String(Math.min(5, expectedMutationSeconds)));
            assert.equal(args[7], String(expectedMutationSeconds));
            if (mutateDuringMutation) {
                const changed = args[mutateDuringMutation === 'source' ? 1 : 2];
                return originalSpawn(command, args, options).then((result: unknown) => {
                    fs.appendFileSync(changed, '\n# changed during mutation\n');
                    return result;
                });
            }
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
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback }), openTextDocument: async () => ({}) },
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
            if (changeBeforeNextRound) {
                changeBeforeNextRound = false;
                fs.appendFileSync(path.join(directory, 'sample.py'), '\n# source changed between rounds\n');
            }
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
            paramSize: '13B', contextLength: 32768, qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 3, timeoutSeconds: 60, outputPath: path.join(directory, 'results') });
        const outputFor = (root: string, target = 'target'): string => {
            const matches = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).flatMap(run => {
                const parent = path.join(root, run.name);
                return fs.readdirSync(parent, { withFileTypes: true }).filter(item => item.isDirectory())
                    .map(item => path.join(parent, item.name)).filter(folder => {
                        const location = JSON.parse(fs.readFileSync(path.join(folder, 'target.json'), 'utf8'));
                        return location.target === target;
                    });
            });
            assert.equal(matches.length, 1, 'one result location must identify the requested target');
            return matches[0];
        };
        const output = outputFor(path.join(directory, 'results'));
        const report = fs.readFileSync(path.join(output, 'final_report.md'), 'utf8');
        assert.doesNotMatch(report, /執行中斷/, logs.join('\n'));
        const manifest = JSON.parse(fs.readFileSync(path.join(output, 'run_manifest.json'), 'utf8'));
        assert.equal(manifest.promptVersion, 'role-contracts-v7');
        assert.equal(manifest.roleContracts.reviewer, 'review-v7');
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
        const incompleteOutput = outputFor(incompleteRoot);
        const incomplete = JSON.parse(fs.readFileSync(path.join(incompleteOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(incomplete.mutationScore, 100, JSON.stringify({ failure: incomplete.failure, stage: incomplete.failureStage, diagnostic: incomplete.diagnostic }));
        assert.equal(incomplete.reviewStatus, 'incomplete');
        assert.equal(incomplete.terminalStatus, 'execution-passed-review-incomplete');
        assert.equal(roles.filter(role => role === 'reviewer').length, 2);
        const incompleteEvents = fs.readFileSync(path.join(incompleteOutput, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(incompleteEvents.some(event => event.stage === 'reviewer' && event.status === 'invalid-response'
            && event.detail.diagnostics.includes('invalid-json')));

        // The first executable candidate must survive even if mutation never returns a score.
        failBuiltinMutation = true;
        reviewerAvailable = true;
        writers = 1;
        const interruptedRoot = path.join(directory, 'first-mutation-timeout');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 1, mutpyTimeout: 40, timeoutSeconds: 60, outputPath: interruptedRoot });
        const interruptedOutput = outputFor(interruptedRoot);
        const interrupted = JSON.parse(fs.readFileSync(path.join(interruptedOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(interrupted.terminalStatus, 'retained-after-failure');
        assert.equal(interrupted.mutationScore, null);
        assert.equal(interrupted.reviewStatus, 'completed');
        assert.equal(interrupted.mutationStatus, 'incomplete');
        const checkpoint = JSON.parse(fs.readFileSync(path.join(interruptedOutput, 'executable_baseline.json'), 'utf8'));
        assert.equal(interrupted.acceptedCodeHash, checkpoint.codeHash);
        assert.equal(fs.readFileSync(path.join(interruptedOutput, 'loop1_test.py'), 'utf8'), checkpoint.code);
        assert.ok(fs.existsSync(path.join(interruptedOutput, checkpoint.testFile)));
        assert.match(fs.readFileSync(path.join(interruptedOutput, 'final_report.md'), 'utf8'), /尚未完成有效測量/);
        failBuiltinMutation = false;
        for (const changed of ['source', 'test'] as const) {
            mutateDuringMutation = changed;
            writers = 1;
            const sourceFile = path.join(directory, 'sample.py');
            const originalSource = fs.readFileSync(sourceFile, 'utf8');
            const changedRoot = path.join(directory, 'changed-' + changed);
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
                filePath: sourceFile, funcName: 'target', promptStrategy: 'tier1',
                maxLoops: 1, mutpyTimeout: 40, timeoutSeconds: 60, outputPath: changedRoot });
            const changedOutput = outputFor(changedRoot);
            const changedKnowledge = JSON.parse(fs.readFileSync(path.join(changedOutput, 'function_knowledge.json'), 'utf8'));
            const saved = JSON.parse(fs.readFileSync(path.join(changedOutput, 'executable_baseline.json'), 'utf8'));
            assert.equal(changedKnowledge.mutationScore, null);
            assert.equal(fs.existsSync(path.join(changedOutput, 'quality_baseline.json')), false);
            assert.equal(fs.readFileSync(path.join(changedOutput, 'loop1_test.py'), 'utf8'), saved.code);
            if (changed === 'source') {
                assert.equal(changedKnowledge.terminalStatus, 'source-changed');
                assert.equal(changedKnowledge.evidenceValid, false);
                assert.equal(changedKnowledge.coverage, null);
            } else { assert.equal(changedKnowledge.failureStage, 'candidate-changed'); }
            fs.writeFileSync(sourceFile, originalSource, 'utf8');
        }
        mutateDuringMutation = undefined;

        // A previously measured baseline becomes historical when the next round sees changed source.
        writers = 0;
        changeBeforeNextRound = true;
        const betweenSource = path.join(directory, 'sample.py');
        const beforeBetweenChange = fs.readFileSync(betweenSource, 'utf8');
        const betweenRoot = path.join(directory, 'changed-between-rounds');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: betweenSource, funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 2, mutpyTimeout: 40, timeoutSeconds: 60, outputPath: betweenRoot });
        const betweenOutput = outputFor(betweenRoot);
        const betweenKnowledge = JSON.parse(fs.readFileSync(path.join(betweenOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(changeBeforeNextRound, false, 'fixture changes source after measurement and before the next Writer');
        assert.equal(writers, 1);
        assert.equal(betweenKnowledge.terminalStatus, 'source-changed');
        assert.equal(betweenKnowledge.evidenceValid, false);
        assert.equal(betweenKnowledge.mutationScore, null);
        assert.equal(betweenKnowledge.coverage, null);
        assert.equal(betweenKnowledge.historicalBaseline.artifactOnly, true);
        assert.ok(fs.existsSync(path.join(betweenOutput, 'quality_baseline.json')));
        fs.writeFileSync(betweenSource, beforeBetweenChange, 'utf8');

        // Available module-scope engines must not substitute for a selected function measurement.
        reviewerAvailable = true;
        expectedMutationSeconds = 25;
        for (const engine of ['mutatest', 'mutmut'] as const) {
            externalEngine = engine;
            utilities.detectMutationEngine = () => engine;
            writers = 0;
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
                filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
                maxLoops: 1, mutpyTimeout: 25, timeoutSeconds: 60, outputPath: path.join(directory, engine + '-results') });
            const scopeRoot = path.join(directory, engine + '-results');
            const scopeOutput = outputFor(scopeRoot);
            const measured = JSON.parse(fs.readFileSync(path.join(scopeOutput, 'loop1_mutation.json'), 'utf8'));
            assert.equal(measured.engine, 'builtin');
            assert.equal(measured.targetScope.kind, 'function');
            assert.equal(measured.targetScope.qualifiedName, 'target');
        }
        assert.equal(externalRuns, 0, 'module engines cannot certify function scope');
        externalEvidence = 'passed';
        externalEngine = undefined;
        utilities.detectMutationEngine = () => null;

        rejectAllModelRequests = true;
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture-model',
            paramSize: '1B', contextLength: 128, qualificationVersion: QUALIFICATION_VERSION,
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier1',
            maxLoops: 1, timeoutSeconds: 60, outputPath: path.join(directory, 'oversize-results') });
        const oversizeRoot = path.join(directory, 'oversize-results');
        const oversizeOutput = outputFor(oversizeRoot);
        const oversizeEvents = fs.readFileSync(path.join(oversizeOutput, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(oversizeEvents.some(event => event.stage === 'model-request' && event.status === 'budget-exceeded'));
        assert.ok(!oversizeEvents.some(event => event.stage === 'model-request' && event.status === 'requested'));

        // Service failures retain their category and never launch lower-Tier Writer retries.
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture-model',
            paramSize: '13B', contextLength: 32768, qualificationVersion: QUALIFICATION_VERSION,
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON });
        let serviceCalls = 0;
        globalThis.fetch = async () => { serviceCalls++; return new Response('PROVIDER_BODY_MUST_REMAIN_PRIVATE', { status: 500 }); };
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier3',
            maxLoops: 1, timeoutSeconds: 60, outputPath: path.join(directory, 'service-failure') });
        const serviceRoot = path.join(directory, 'service-failure');
        const serviceOutput = outputFor(serviceRoot);
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
        const scaffoldOutput = outputFor(scaffoldRoot);
        const scaffoldKnowledge = JSON.parse(fs.readFileSync(path.join(scaffoldOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(scaffoldKnowledge.terminalStatus, 'passed', scaffoldKnowledge.failure);
        assert.equal(scaffoldKnowledge.resolvedTier, 3);
        assert.deepEqual(roles, ['analyst-planning', 'writer', 'reviewer'], 'complete scaffold output needs no wrapping repair or Tier fallback');

        // Partial progress must survive even while coverage/mutation remain below 100.
        fs.writeFileSync(path.join(directory, 'partial.py'), `def read(): return {'mode': 'a'}
class Widget:
    @staticmethod
    def normalize():
        state = read()
        if state['mode'] == 'a':
            return 1
        if state['mode'] == 'b':
            return 2
        if state['mode'] == 'c':
            return 3
        return 0
`);
        const partialFirst = `import unittest
from unittest.mock import patch
from partial import Widget
class Cases(unittest.TestCase):
    def test_keep(self):
        with patch('partial.read', return_value={'mode': 'a'}):
            self.assertEqual(Widget.normalize(), 1)
`;
        const partialSecond = partialFirst + `    def test_more(self):
        with patch('partial.read', return_value={'mode': 'b'}):
            self.assertEqual(Widget.normalize(), 2)
`;
        let partialWriters = 0, partialReviews = 0, qualityCalls = 0;
        globalThis.fetch = async (_url, options) => {
            const request = JSON.parse(String(options?.body));
            let response: string;
            if (request.system.includes('You are the test Reviewer')) {
                partialReviews++;
                response = partialReviews === 1 ? '{"findings":[]}' : JSON.stringify({ findings: [{
                    category: 'target-binding', test_line: 'L7', reason: 'The target function is not static.',
                    action: 'Add @staticmethod to Widget.normalize.'
                }] });
            } else if (request.system.includes('Analyst after successful')) {
                qualityCalls++;
                assert.equal(request.format, undefined, 'plain-unittest profiles retain text transport');
                const focus = JSON.parse(request.prompt.split('FOCUS\n')[1].split('\n')[0]);
                response = qualityCalls === 1 ? 'INVALID_PRIVATE_RESPONSE' : JSON.stringify({ tasks: [{
                    evidence_id: focus.id, hypothesis: 'Another controlled input may cover the next branch.',
                    scenario: 'Mock read with mode b.', verification: 'Run original and mutants with the same mock.'
                }] });
                if (qualityCalls === 2) {
                    assert.match(request.prompt, /FORMAT CORRECTION/);
                    assert.doesNotMatch(request.prompt, /INVALID_PRIVATE_RESPONSE/);
                }
            } else if (request.system.includes('dependency_behaviors')) {
                response = '{"dependency_behaviors":[]}';
            } else {
                partialWriters++;
                if (partialWriters === 2) { assert.match(request.prompt, /Mock read with mode b/); }
                response = '```python\n' + (partialWriters === 1 ? partialFirst : partialSecond) + '\n```';
            }
            return new Response(JSON.stringify({ response }), { status: 200 });
        };
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
            filePath: path.join(directory, 'partial.py'), funcName: 'Widget.normalize', promptStrategy: 'tier1',
            maxLoops: 2, timeoutSeconds: 60, outputPath: path.join(directory, 'partial-results') });
        const partialRoot = path.join(directory, 'partial-results');
        const partialOutput = outputFor(partialRoot, 'Widget.normalize');
        const partialKnowledge = JSON.parse(fs.readFileSync(path.join(partialOutput, 'function_knowledge.json'), 'utf8'));
        const partialEvents = fs.readFileSync(path.join(partialOutput, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const accepted = partialEvents.filter(event => event.stage === 'baseline' && event.status === 'accepted');
        const covered = partialEvents.filter(event => event.stage === 'coverage' && event.status === 'measured');
        assert.equal(accepted.length, 2, JSON.stringify({ failure: partialKnowledge.failure, baseline: accepted }));
        assert.ok(accepted[1].detail.score > accepted[0].detail.score);
        assert.ok(covered[1].detail.missingTargetLines.length < covered[0].detail.missingTargetLines.length);
        assert.ok(covered[1].detail.missingTargetLines.length > 0, 'this is partial improvement, not a full pass');
        assert.equal(partialKnowledge.mutationScore, accepted[1].detail.score);
        assert.equal(partialKnowledge.reviewStatus, 'incomplete');
        assert.equal(partialWriters, 2, JSON.stringify(partialEvents.filter(event =>
            (event.stage === 'model-request' && event.status === 'requested') || ['rejected', 'tier-failed', 'failed'].includes(event.status))
            .map(event => ({ stage: event.stage, status: event.status, role: event.detail.role, reason: event.detail.reason }))));
        assert.equal(qualityCalls, 2, 'one invalid response receives one bounded format repair');
        assert.ok(partialEvents.some(event => event.stage === 'reviewer' && event.status === 'invalid-response'
            && event.detail.diagnostics.includes('target-binding-contradiction')));
        assert.ok(!partialEvents.some(event => event.stage === 'baseline' && event.status === 'rollback'));
        assert.match(fs.readFileSync(path.join(partialOutput, partialKnowledge.acceptedTest), 'utf8'), /test_more/);
        globalThis.fetch = fixtureFetcher;

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
        const badOutput = outputFor(badRoot);
        const badKnowledge = JSON.parse(fs.readFileSync(path.join(badOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(badKnowledge.failureStage, 'trace-baseline');
        assert.deepEqual(roles, ['analyst-planning', 'writer'], 'runner-owned failure never consumes model repair or review');

        traceBuilder.buildTier1TestFile = originalTraceBuilder;
        for (const mode of ['format', 'scope'] as const) {
            const marker = 'PRIVATE_FIXER_REPLY_MUST_NOT_APPEAR';
            let fixerCalls = 0;
            globalThis.fetch = async (_url, options) => {
                const request = JSON.parse(String(options?.body));
                let response: string;
                if (request.system.includes('dependency_behaviors')) { response = '{"dependency_behaviors":[]}'; }
                else if (request.system.includes('Python unittest Bug Fixer')) {
                    fixerCalls++;
                    assert.equal(request.format, undefined);
                    const fragment = "def test_false(self):\n    with patch('sample.read', return_value={'ready': False, 'kind': 'other'}):\n        self.assertFalse(target())";
                    response = mode === 'format' ? marker + '\n```python\n' + fragment + '\n```'
                        : '```python\nfrom datetime import datetime\n' + fragment + '\n```';
                } else if (request.system.includes('You are the test Reviewer')) { response = '{"findings":[]}'; }
                else {
                    response = '```python\n' + (mode === 'scope' ? 'import datetime\n' : '')
                        + code.replace('self.assertFalse(target())', 'self.assertTrue(target())') + '\n```';
                }
                return new Response(JSON.stringify({ response }), { status: 200 });
            };
            const repairRoot = path.join(directory, 'repair-' + mode);
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture-model',
                filePath: path.join(directory, 'sample.py'), funcName: 'target', promptStrategy: 'tier2',
                maxLoops: 1, timeoutSeconds: 60, outputPath: repairRoot });
            const repairOutput = outputFor(repairRoot);
            const eventText = fs.readFileSync(path.join(repairOutput, 'role_events.jsonl'), 'utf8');
            const repairEvents = eventText.trim().split('\n').map(line => JSON.parse(line));
            const repairKnowledge = JSON.parse(fs.readFileSync(path.join(repairOutput, 'function_knowledge.json'), 'utf8'));
            const repairReport = fs.readFileSync(path.join(repairOutput, 'final_report.md'), 'utf8');
            const reason = mode === 'format' ? 'extra-text' : 'import-conflict';
            assert.ok(fixerCalls > 0, mode);
            const rejected = repairEvents.filter(event => event.detail?.diagnostic?.reasonCodes.includes(reason));
            assert.ok(rejected.length > 0, JSON.stringify(repairEvents.map(event => [event.stage, event.status])));
            assert.equal(rejected[0].stage, 'bug-fixer');
            assert.ok(repairKnowledge.repairFailureCounts[reason] > 0);
            assert.match(repairReport, /修復失敗診斷/);
            assert.match(repairReport, new RegExp(reason));
            assert.match(repairReport, /修復後續處理/);
            assert.equal(repairKnowledge.terminalStatus, 'failed');
            assert.ok(!eventText.includes(marker) && !repairReport.includes(marker));
            assert.ok(!fs.readFileSync(path.join(repairOutput, 'loop1_test.py'), 'utf8').includes('from datetime import datetime'));
            if (mode === 'format') {
                assert.equal(repairKnowledge.failureCategory, 'model-format');
                assert.equal(repairKnowledge.failureStage, 'bug-fixer-response');
                assert.equal(repairKnowledge.repairFailureCounts[reason], fixerCalls, 'each response refusal must be journaled once');
                assert.ok(repairEvents.some(event => event.stage === 'repair-routing' && event.detail.action === 'tier-fallback'));
            }
        }
    } finally {
        globalThis.fetch = originalFetch;
        Module._load = originalLoad;
        utilities.detectMutationEngine = originalEngine;
        processRunner.runSpawn = originalSpawn;
        traceBuilder.buildTier1TestFile = originalTraceBuilder;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

