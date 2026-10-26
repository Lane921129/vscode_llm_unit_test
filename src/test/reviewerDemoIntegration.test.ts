import { ollamaRuntimeMetadataFixture, readObservedSeedCaseForModelFixture, readOllamaRoleRequest } from './ollamaRequestFixture';
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

/** Fixture diagnostics contain lifecycle codes/counts only, never source/provider text. */
function safeReviewFlowDiagnostic(scenario: string, knowledge: any, events: any[], requests: object): string {
    const code = (value: unknown): string | undefined => typeof value === 'string'
        && /^[a-z][a-z0-9-]{0,79}$/i.test(value) ? value : undefined;
    const failure = (value: any) => value ? { stage: code(value.stage), category: code(value.category), status: code(value.status),
        reasonCode: code(value.reasonCode) || code(value.reason) } : undefined;
    const mutation = knowledge.latestMutation || knowledge.mutation;
    const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    return JSON.stringify({ scenario, terminalStatus: code(knowledge.terminalStatus),
        firstFailure: failure(knowledge.firstFailure), lastFailure: failure(knowledge.lastFailure),
        diagnosticReasonCode: code(knowledge.diagnostic?.reasonCode), requests,
        mutation: mutation ? { engine: code(mutation.engine), status: code(mutation.status), baselineStatus: code(mutation.baselineStatus),
            stageTimeoutSeconds: numeric(mutation.stageTimeoutSeconds), elapsedMs: numeric(mutation.elapsedMs), workers: numeric(mutation.workers),
            baselineAllocatedSeconds: numeric(mutation.baselineAllocatedSeconds), baselineElapsedMs: numeric(mutation.baselineElapsedMs),
            configuredMutantTimeoutSeconds: numeric(mutation.configuredMutantTimeoutSeconds),
            effectiveMutantTimeoutSeconds: numeric(mutation.effectiveMutantTimeoutSeconds),
            counts: mutation.counts && Object.fromEntries(Object.entries(mutation.counts)
                .filter(([key, value]) => !!code(key) && numeric(value) !== undefined)) } : undefined,
        assessments: events.filter(event => event.stage === 'reviewer' && event.status === 'assessed').map(event => ({
            sequence: event.sequence, findingCount: Array.isArray(event.detail?.review?.issues) ? event.detail.review.issues.length : undefined })),
        events: events.slice(-60).map(event => ({ sequence: event.sequence, stage: code(event.stage), status: code(event.status),
            role: code(event.detail?.role), reasonCode: code(event.detail?.reasonCode) })) });
}

test('full workflow blocks mutation on invalid review and requires AI revision plus fresh approval for quality findings', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-'));
    const file = path.join(root, 'bmi.py');
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
    let candidate = '';
    fs.writeFileSync(file, source);
    const settings: Record<string, unknown> = { pythonPath: resolvePythonExecutable(undefined, repo), projectPath: root, language: 'en' };
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let scenario: 'invalid' | 'fixed-value' | 'quality' = 'invalid';
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
    globalThis.fetch = async (url, options) => {
        // This fixture intentionally exercises the captured 8572-token allocation,
        // without treating metadata exploration as a generation or role request.
        const metadata = ollamaRuntimeMetadataFixture(url, options,
            { modelName: 'neutral-fixture', metadataAvailable: false });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        assert.equal(request.options.num_ctx, 8572,
            'the fixture runtime allocation, not the model maximum, owns the input budget');
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) { response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the real selected target with controlled inputs and use only verified observations for assertions."}}'; }
        else if (request.roleInstructions.includes('You are the test Reviewer')) {
            reviews++;
            assert.match(request.prompt, /ISOLATED_EXECUTION_PASSED/);
            if (scenario === 'invalid') {
                response = JSON.stringify({ findings: [{ category: 'target-binding', test_line: 'L1',
                    reason: 'The target import is incorrect; use import bmi.', action: 'Replace with import bmi.' }] });
            } else if (scenario === 'fixed-value') {
                assert.match(request.prompt, /"expectedOrigin":"static-literal"/);
                response = JSON.stringify({ findings: [{ category: 'assertion-quality', test_line: 'L5',
                    reason: 'The expected result is not a fixed value, but rather a calculated value based on the input parameters. This could lead to false positives or false negatives in the test.',
                    action: 'Replace the expected result with a fixed value that is calculated based on the input parameters.' }] });
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
            assert.ok(candidate, 'a real executed seed precedes its review-driven revision');
            response = '```python\n' + candidate.replaceAll('self.assertEqual(', 'self.assertTupleEqual(') + '\n```';
        } else {
            writers++;
            const observed = readObservedSeedCaseForModelFixture(request.prompt, 'calculate_bmi');
            assert.ok(observed, 'the fixed-response Writer needs the exact source-bound selected seed observation');
            assert.equal(observed.observedOutcome, 'returned', 'this review-quality fixture strengthens a verified tuple assertion');
            const callArguments = [...observed.args,
                ...Object.entries(observed.kwargs).map(([name, value]) => `${name}=${value}`)].join(', ');
            // Match the formal first-case contract. Expected values come from the
            // supplied executed observation, never a fixture-side calculation.
            candidate = `import unittest
from bmi import calculate_bmi
class Cases(unittest.TestCase):
    def test_value_0(self):
        self.assertEqual(calculate_bmi(${callArguments}), ${observed.observedResult})
`;
            response = '```python\n' + candidate + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        // Fixed-response transport declares its actual runtime allocation separately:
        // 8572 preserves this review-gate fixture's original 6000-token input budget.
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture', paramSize: '13B', contextLength: 32768,
            effectiveRuntimeContextTokens: 8572, runtimeContextSource: 'ollama-num-ctx' });
        for (const selected of ['invalid', 'fixed-value', 'quality'] as const) {
            scenario = selected; candidate = ''; writers = 0; revisions = 0; fixes = 0; reviews = 0; logs.length = 0;
            const outputPath = path.join(root, 'results-' + scenario);
            // The builtin-v2 full universe contains 96 candidates here. This
            // fixture verifies review/approval ordering, not a 30-second speed
            // limit; give the real engine the current default stage budget.
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: file,
                funcName: 'calculate_bmi', outputPath, promptStrategy: 'tier2', validationMode: 'full',
                maxLoops: 1, timeoutSeconds: 60, mutpyTimeout: 60 });
            const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json')!;
            assert.ok(report, logs.join('\n'));
            const directory = path.dirname(path.join(outputPath, report));
            const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
            const checkpointPath = path.join(directory, 'executable_baseline.json');
            assert.ok(fs.existsSync(checkpointPath), 'the selected seed must really execute before review: '
                + safeReviewFlowDiagnostic(scenario, knowledge, events, { writers, revisions, fixes, reviews }));
            const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
            const final = fs.readFileSync(path.join(functionReportDirectory(directory), 'final_report.md'), 'utf8');
            assert.equal(writers, 1);
            assert.equal(fixes, 0);
            assert.equal(reviews, 2, 'contract correction or review of a revised candidate consumes the second request');
            assert.deepEqual(knowledge.tierHistory.transitions, []);
            if (scenario !== 'quality') {
                assert.equal(knowledge.terminalStatus, 'review-blocked', JSON.stringify(knowledge.lastFailure || knowledge.failure));
                assert.equal(knowledge.failureStage, 'reviewer');
                assert.equal(knowledge.reviewStatus, 'incomplete');
                assert.equal(knowledge.mutationStatus, 'not-measured', 'unapproved tests cannot acquire a measured journal status');
                assert.equal(checkpoint.mutationScore, null);
                assert.equal(checkpoint.mutationStatus, 'not-measured');
                assert.equal(checkpoint.reviewStatus, 'incomplete');
                assert.equal(revisions, 0, 'invalid findings cannot instruct the Writer');
                assert.equal(events.filter(e => e.stage === 'validation' && e.status === 'passed').length, 1,
                    'the seed is executed only once');
                assert.equal(events.some(e => e.stage === 'mutation'), false, 'no mutation process starts before approval');
                assert.ok(events.some(e => e.stage === 'reviewer' && e.status === 'invalid-response'));
                assert.ok(events.some(e => e.stage === 'reviewer' && e.status === 'unavailable'));
                if (scenario === 'fixed-value') {
                    const invalid = events.filter(e => e.stage === 'reviewer' && e.status === 'invalid-response');
                    assert.equal(invalid.length, 2);
                    assert.ok(invalid.every(e => e.detail.diagnostics.includes('expected-fixed-value-contradiction')));
                }
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
                    'only a fresh review of the executed revision permits mutation: '
                    + safeReviewFlowDiagnostic(scenario, knowledge, events, { writers, revisions, fixes, reviews }));
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
