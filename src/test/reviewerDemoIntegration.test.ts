import { readOllamaRoleRequest } from './ollamaRequestFixture';
import { functionReportDirectory } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { BatchJournal } from '../pipeline/batchJournal';
import { evidenceHash } from '../pipeline/analysisJournal';
import { setLanguage } from '../i18n/core';

test('full workflow blocks mutation on invalid review and requires AI revision plus fresh approval for quality findings', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-'));
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
    const revised = candidate.replaceAll('self.assertEqual(', 'self.assertTupleEqual(');
    fs.writeFileSync(file, source);
    const settings: Record<string, unknown> = { pythonPath: resolvePythonExecutable(undefined, repo), projectPath: root, language: 'en' };
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let scenario: 'invalid' | 'quality' = 'invalid';
    let writers = 0, revisions = 0, fixes = 0, reviews = 0;
    const logs: string[] = [];
    const outcomes: any[] = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { if (message.text) { logs.push(message.text); } if (message.outcome) { outcomes.push(message.outcome); } return true; } };
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
        else if (request.roleInstructions.includes('You are the test Reviewer')) {
            reviews++;
            assert.match(request.prompt, /ISOLATED_EXECUTION_PASSED/);
            if (scenario === 'invalid') {
                response = JSON.stringify({ findings: [{ category: 'target-binding', test_line: 'L1',
                    reason: 'The target import is incorrect; use import bmi.', action: 'Replace with import bmi.' }] });
            } else {
                response = JSON.stringify({ findings: revisions > 0 ? [] : [{ category: 'assertion-quality', test_line: 'L5',
                    reason: 'The expected tuple structure should be explicit in this assertion.',
                    action: 'Use assertTupleEqual for the verified tuple results while preserving all current input cases.' }] });
            }
        } else if (request.roleInstructions.includes('Python unittest Bug Fixer')) {
            fixes++; throw Error('passing candidates must not request method repair');
        } else if (request.roleInstructions.includes('Revise the current tests')) {
            revisions++;
            assert.equal(scenario, 'quality');
            assert.match(request.prompt, /assertTupleEqual/);
            response = '```python\n' + revised + '\n```';
        } else { writers++; response = '```python\n' + candidate + '\n```'; }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture', paramSize: '13B', contextLength: 32768 });
        for (const selected of ['invalid', 'quality'] as const) {
            scenario = selected; writers = 0; revisions = 0; fixes = 0; reviews = 0; logs.length = 0;
            const outputPath = path.join(root, 'results-' + scenario);
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: file,
                funcName: 'calculate_bmi', outputPath, promptStrategy: 'tier2', validationMode: 'full',
                maxLoops: 1, timeoutSeconds: 60, mutpyTimeout: 30 });
            const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json')!;
            assert.ok(report, logs.join('\n'));
            const directory = path.dirname(path.join(outputPath, report));
            const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
            const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, 'executable_baseline.json'), 'utf8'));
            const final = fs.readFileSync(path.join(functionReportDirectory(directory), 'final_report.md'), 'utf8');
            assert.equal(writers, 1);
            assert.equal(fixes, 0);
            assert.equal(reviews, 2, 'contract correction or review of a revised candidate consumes the second request');
            assert.deepEqual(knowledge.tierHistory.transitions, []);
            if (scenario === 'invalid') {
                assert.equal(knowledge.terminalStatus, 'review-blocked', JSON.stringify(knowledge.lastFailure || knowledge.failure));
                assert.equal(knowledge.failureStage, 'reviewer');
                assert.equal(knowledge.reviewStatus, 'incomplete');
                assert.equal(checkpoint.mutationScore, null);
                assert.equal(checkpoint.mutationStatus, 'not-measured');
                assert.equal(checkpoint.reviewStatus, 'incomplete');
                assert.equal(revisions, 0, 'invalid findings cannot instruct the Writer');
                assert.equal(events.filter(e => e.stage === 'validation' && e.status === 'passed').length, 1,
                    'the seed is executed only once');
                assert.equal(events.some(e => e.stage === 'mutation'), false, 'no mutation process starts before approval');
                assert.ok(events.some(e => e.stage === 'reviewer' && e.status === 'invalid-response'));
                assert.ok(events.some(e => e.stage === 'reviewer' && e.status === 'unavailable'));
                assert.doesNotMatch(final, /measurements met the thresholds|Fully passed/);
                assert.match(final, /Reviewer|review/);
                assert.notEqual(outcomes.at(-1).kind, 'passed');
                const batch = new BatchJournal(outputPath, root, { model: 'local/neutral-fixture', buildTimestamp: 'fixture', python: String(settings.pythonPath) });
                batch.discover(file, ['calculate_bmi']); batch.start(); batch.begin(0);
                batch.attach(0, functionReportDirectory(directory)); batch.refresh(0); batch.finish('completed');
                const summary = JSON.parse(fs.readFileSync(path.join(outputPath, 'batch_manifest.json'), 'utf8'));
                assert.equal(summary.allTargetsPassed, false);
            } else {
                assert.equal(revisions, 1);
                assert.equal(knowledge.reviewStatus, 'completed', JSON.stringify(knowledge.failure));
                const executed = events.map((event, index) => ({ event, index }))
                    .filter(({ event }) => event.stage === 'validation' && event.status === 'passed');
                const reviewAssessments = events.map((event, index) => ({ event, index }))
                    .filter(({ event }) => event.stage === 'reviewer' && event.status === 'assessed');
                const revisionIndex = events.findIndex((e, index) => index > reviewAssessments[0].index
                    && e.stage === 'writer' && e.status === 'candidate');
                const approvalIndex = events.findIndex(e => e.stage === 'reviewer' && e.status === 'approved');
                const mutationIndex = events.findIndex(e => e.stage === 'mutation' && e.status === 'measured');
                assert.equal(executed.length, 2);
                assert.equal(reviewAssessments.length, 2);
                assert.ok(executed[0].index < reviewAssessments[0].index);
                assert.ok(reviewAssessments[0].index < revisionIndex);
                assert.ok(revisionIndex < executed[1].index);
                assert.ok(executed[1].index < reviewAssessments[1].index);
                assert.ok(reviewAssessments[1].index < approvalIndex && approvalIndex < mutationIndex,
                    'only a fresh review of the executed revision permits mutation');
                const approvedCode = fs.readFileSync(path.join(directory, checkpoint.testFile), 'utf8');
                assert.equal(events[approvalIndex].detail.approvedCodeHash, evidenceHash(approvedCode));
                assert.equal(knowledge.mutation.counts.executed, knowledge.mutation.counts.selected);
                assert.ok(knowledge.mutation.counts.executed > 0, 'the approved path uses the real mutation engine');
                assert.match(approvedCode, /assertTupleEqual/);
                assert.doesNotMatch(approvedCode, /TestVerifiedState|Trace_/);
            }
            assert.equal(fs.readFileSync(file, 'utf8'), source);
        }
    } finally {
        setLanguage('zh-tw'); Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
