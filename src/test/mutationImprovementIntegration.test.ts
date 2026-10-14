import { readOllamaRoleRequest, ollamaRuntimeMetadataFixture, readObservedSeedCaseForModelFixture } from './ollamaRequestFixture';
import { functionReportDirectory, roundDirectory } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { setLanguage } from '../i18n/core';
import { evidenceHash } from '../pipeline/analysisJournal';

/** This fixed-response actor copies the final host packet for one microtask.
 * It supplies no production expected values; the real Python gates verify it. */
function currentWriterCase(prompt: string, target: string) {
    const packets = [...prompt.matchAll(/^WRITER_FOCUS_CASE_FACTS_V1\n([^\n]+)/gm)];
    assert.ok(packets.length > 0, 'the current Writer request must end with explicit exact case facts');
    const packet = JSON.parse(packets.at(-1)![1]);
    assert.equal(packet.target, target);
    assert.match(packet.sourceHash, /^[a-f0-9]{64}$/);
    assert.ok(packet.runId);
    assert.match(packet.focusId, /^E[a-f0-9]{16}$/);
    assert.equal(packet.scenarioId, `observations:${packet.focusId}`);
    assert.equal(packet.cases.length, 1, 'one Writer microtask owns exactly one bound literal call');
    const observed = packet.cases[0];
    assert.ok(observed.caseId);
    assert.ok(Array.isArray(observed.args) && observed.args.every((value: unknown) => typeof value === 'string'));
    assert.deepEqual(observed.kwargs, {});
    assert.equal(observed.targetCall, `${target}(${observed.args.join(', ')})`);
    assert.equal(typeof observed.observedResult, 'string');
    const signatures = [...prompt.matchAll(/^REQUIRED NEW METHOD SIGNATURE[^\n]*\n(def (test_[A-Za-z0-9_]+)\(self\):)/gm)];
    const methodName = signatures.at(-1)?.[2];
    return { methodName, sourceHash: packet.sourceHash as string, runId: packet.runId as string, args: observed.args as string[], result: observed.observedResult as string,
        targetCall: observed.targetCall as string, focusId: packet.focusId as string, caseId: observed.caseId as string };
}

test('AI-authored boundary improvements preserve fallback history and require approval before each mutation round', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-improvement-'));
    const Module = require('module');
    const load = Module._load, fetch = globalThis.fetch;
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const handlers = new Map<string, (params: any) => Promise<void>>();
    const logs: string[] = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: (message: any) => { if (message.text) { logs.push(message.text); } return Promise.resolve(true); } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : key === 'language' ? 'en' : fallback }), openTextDocument: async () => ({}) },
        commands: { registerCommand: (name: string, handler: (params: any) => Promise<void>) => { handlers.set(name, handler); return { dispose() {} }; } },
        env: { openExternal: async () => true }, Uri: { file: (file: string) => file }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : load.call(this, name, ...args); };
    const source = `def categorize(amount, scale):
    factor = scale / 10
    value = round(amount / factor ** 2, 2)
    if value < 7.5:
        label = 'low'
    elif 7.5 <= value < 13:
        label = 'middle'
    elif 13 <= value < 21:
        label = 'high'
    else:
        label = 'end'
    return value, label
`;
    let valid = `import unittest
from sample import categorize
class Cases(unittest.TestCase):
    def test_interior(self):
        self.assertEqual(categorize(20, 10), (20.0, 'high'))
`;
    let writers = 0, quality = 0, fixer = 0;
    const observedCases = new Map<string, { args: string[]; result: string }>();
    const writerEvidence: string[] = [];
    const authoredMethodNames: string[] = [];
    const analystEvidence: string[] = [];
    // Keep exercising model repair/fallback: compound contexts are outside the
    // numeric skill. The reserved Writer repeats the failure so this test still
    // exercises outer Tier fallback. Arithmetic correction is covered separately.
    let unsupportedWrong = valid.replace('        self.assertEqual',
        '        with self.subTest():\n            self.assertEqual').replace('(20.0,', '(19.0,');
    globalThis.fetch = async (_url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(_url, options, { modelName: 'neutral-fixture', observedContextTokens: 8572 });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) { response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the real selected target with controlled inputs and use only verified observations for assertions."}}'; }
        else if (request.roleInstructions.includes('You are the test Reviewer')) { response = '{"findings":[]}'; }
        else if (request.roleInstructions.includes('Analyst after successful')) {
            quality++;
            analystEvidence.push(request.prompt);
            const focus = JSON.parse(request.prompt.match(/FOCUS\n([^\n]+)/)[1]);
            const bound = request.prompt.match(/BOUND FOCUS OBSERVATIONS \(executed inputs, not model proposals\)\n([^\n]+)/)?.[1];
            response = JSON.stringify({ tasks: [{ evidence_id: focus.id,
                hypothesis: 'The current interior case does not distinguish a measured comparison boundary.',
                scenario: bound ? JSON.parse(bound).scenario_id : 'Use the exact newly observed boundary inputs and preserve earlier passing cases.',
                verification: bound ? 'verify-observed-behavior'
                    : 'Verify each exact result by execution, have the Reviewer approve, then measure the complete mutant set.' }] });
        }
        else if (request.roleInstructions.includes('Python unittest Bug Fixer')) { fixer++; response = '```python\npass\n```'; }
        else {
            writers++;
            const seed = readObservedSeedCaseForModelFixture(request.prompt, 'categorize');
            if (seed) {
                assert.equal(seed.observedOutcome, 'returned');
                assert.deepEqual(seed.kwargs, {});
                valid = `import unittest\nfrom sample import categorize\nclass Cases(unittest.TestCase):\n`
                    + `    def test_interior(self):\n        self.assertEqual(categorize(${seed.args.join(', ')}), ${seed.observedResult})\n`;
                const number = /^\((-?\d+(?:\.\d+)?)/.exec(seed.observedResult!)?.[1];
                assert.ok(number);
                unsupportedWrong = valid.replace('        self.assertEqual', '        with self.subTest():\n            self.assertEqual')
                    .replace(seed.observedResult!, seed.observedResult!.replace(number!, String(Number(number) + 1)));
            }
            let candidate = writers <= 2 ? unsupportedWrong : valid;
            if (writers > 3) {
                writerEvidence.push(request.prompt);
                // The final packet owns this single case; earlier family/Trace
                // envelopes remain evidence, but cannot change this request.
                const observation = currentWriterCase(request.prompt, 'categorize');
                assert.equal(observation.args.length, 2);
                observedCases.set(JSON.stringify(observation.args), observation);
                const methodName = observation.methodName ?? `test_observed_${writers}`;
                authoredMethodNames.push(methodName);
                candidate = `import unittest\nfrom sample import categorize\nclass Cases(unittest.TestCase):\n    def ${methodName}(self):\n`
                    + `        self.assertEqual(${observation.targetCall}, ${observation.result})\n`;
            }
            response = '```python\n' + candidate + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        fs.writeFileSync(path.join(directory, 'sample.py'), source);
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture',
            paramSize: '13B', contextLength: 32768, qualificationVersion: QUALIFICATION_VERSION,
            qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8572 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture',
            filePath: path.join(directory, 'sample.py'), funcName: 'categorize', promptStrategy: 'tier2',
            validationMode: 'full', maxLoops: 5, mutpyTimeout: 120, timeoutSeconds: 60, outputPath: path.join(directory, 'results') });
        const relative = fs.readdirSync(path.join(directory, 'results'), { recursive: true }).map(String)
            .find(name => path.basename(name) === 'function_knowledge.json');
        assert.ok(relative, logs.join('\n'));
        const output = path.dirname(path.join(directory, 'results', relative));
        const state = JSON.parse(fs.readFileSync(path.join(output, 'function_knowledge.json'), 'utf8'));
        const events = fs.readFileSync(path.join(output, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const report = fs.readFileSync(path.join(functionReportDirectory(output), 'final_report.md'), 'utf8');
        const failureReport = fs.readFileSync(path.join(output, 'workflow_report.md'), 'utf8');
        const writerEvents = events.filter(event => event.stage === 'writer' && event.status === 'candidate'
            && event.detail.tier !== undefined);
        assert.ok(writerEvents.length > 0);
        assert.ok(writerEvents.every(event => !Object.hasOwn(event.detail, 'raw')
            && /^[a-f0-9]{64}$/.test(event.detail.responseHash) && event.detail.responseCharacters >= 0));
        assert.equal(fixer, 1, JSON.stringify({ state: state.terminalStatus, first: state.firstFailure, last: state.lastFailure }));
        const recovery = events.filter(event => event.stage === 'repair-routing' && event.detail.action === 'writer-recovery');
        assert.equal(recovery.length, 1);
        assert.equal(recovery[0].detail.reasonCode, 'response-format');
        assert.ok(recovery[0].sequence < events.find(event => event.stage === 'tier' && event.status === 'fallback').sequence);
        assert.equal(state.tierHistory.transitions[0].from, 2);
        assert.equal(state.tierHistory.transitions[0].to, 1);
        assert.equal(state.tierHistory.rounds[1].start, 2);
        assert.match(failureReport, /Automatic fallback occurred: Yes.*Round 1: Tier 2 → 1/);
        assert.equal(state.terminalStatus, 'passed', JSON.stringify({last:state.lastFailure, first:state.firstFailure, tiers:state.tierHistory,
            writers, quality, cases: [...observedCases.values()], stages: events.filter(e => e.status === 'failed' || e.status === 'budget-exceeded').map(e => e.detail) }));
        assert.match(failureReport, /Currently retained candidate: Tier 2/);
        assert.match(failureReport, /Full workflow \(event order\)/);
        assert.doesNotMatch(report, /Automatic fallback|Role event|Semantic Analyst report/);
        assert.match(report, /failure_report.md/);
        const firstRound = fs.readFileSync(path.join(roundDirectory(output, 1), 'report.md'), 'utf8');
        const secondRound = fs.readFileSync(path.join(roundDirectory(output, 2), 'report.md'), 'utf8');
        assert.match(firstRound, /Round 1: Tier 2 → 1/);
        assert.doesNotMatch(secondRound, /Round 1: Tier 2 → 1/);
        assert.match(secondRound, /Round 2 results/);
        assert.deepEqual(fs.readdirSync(functionReportDirectory(output)).sort(), ['failure_report.md', 'final_report.md', 'loop']);
        assert.match(report, /### Test cases/);
        assert.match(report, /### Mutation cases/);
        assert.match(report, /threshold ≥ 80%/);
        assert.match(report, /builtin-ast-v2/);
        assert.match(report, /## Final outcome: /);
        const measured = events.filter(event => event.stage === 'mutation' && event.status === 'measured');
        assert.ok(measured.length >= 2, logs.join('\n'));
        assert.ok(measured[1].detail.score > measured[0].detail.score, JSON.stringify(measured.map(event => event.detail.score)));
        assert.ok(events.some(event => event.stage === 'mutation-inputs' && event.status === 'observed'));
        assert.ok(quality >= 1, 'the Analyst must assess the measured gap before the Writer expands tests');
        assert.ok(measured.length >= 2 && measured.length <= 5, 'measured gap improvements stay within the configured limit');
        assert.ok(writers > 3, 'observed inputs still require a Writer to author additions after fallback');
        assert.ok(writerEvidence.every(prompt => prompt.includes('WRITER_FOCUS_CASE_FACTS_V1')),
            'each Writer request receives explicit exact-case facts rather than inferring a case from the earlier family');
        for (const prompt of writerEvidence) {
            const current = currentWriterCase(prompt, 'categorize');
            assert.equal(current.args.length, 2);
            assert.equal(current.sourceHash, state.sourceHash);
            assert.deepEqual(observedCases.get(JSON.stringify(current.args))?.result, current.result,
                'each Writer addition uses the exact result of its own current input');
        }
        const formalWriters = events.filter(event => event.stage === 'model-request' && event.status === 'requested'
            && ['writer', 'writer-revision'].includes(event.detail.role) && event.detail.phase !== 'context-qualification');
        assert.equal(formalWriters.length, writers);
        assert.equal(writers, 3 + writerEvidence.length, 'two rejected seed requests plus a valid fallback precede the exact-case additions');
        assert.ok(!formalWriters.some(event => event.sequence > measured.at(-1).sequence),
            'no Writer request is allowed after the final quality measurement passes');
        assert.ok(analystEvidence.some(prompt => prompt.includes('VERIFIED BOUNDARY OBSERVATIONS (the AI must write tests):')),
            'an Analyst without the full Trace must still receive the complete exact observations');
        for (const measurement of measured) {
            assert.ok(events.some(event => event.stage === 'reviewer' && event.status === 'parsed'
                && event.loop === measurement.loop && event.sequence < measurement.sequence), 'mutation follows approval for this candidate');
        }
        for (let round = 1; round < measured.length; round++) {
            const plan = JSON.parse(fs.readFileSync(path.join(roundDirectory(output, round), `loop${round}_mutation_input_plan.json`), 'utf8'));
            assert.equal(new Set(plan.inputs.map((input: any) => input.mutantId)).size, 1, 'only one selected gap is probed per round');
        }
        assert.equal(state.qualityPolicy.policyId, 'standard80-v1');
        assert.equal(state.qualityAssessment.toolsSatisfied, true);
        assert.equal(state.terminalStatus, 'passed');
        assert.match(report, /threshold ≥ 80%/);
        assert.doesNotMatch(report, /surviving mutants/);
        assert.equal(state.reviewStatus, 'completed');
        assert.equal(state.qualityAssessment.fullyPassed, true);
        assert.equal(state.mutation.status, 'complete');
        assert.equal(state.mutation.counts.executed, state.mutation.counts.selected);
        assert.ok(state.mutationInputPlan.diagnostics.some((item: any) => item.status === 'conditional-equivalence' && item.excludedFromScore === false));
        const survivedIds = new Set(state.mutation.mutants.filter((m: any) => m.status === 'SURVIVED').map((m: any) => m.id));
        assert.equal(state.mutation.counts.survived, survivedIds.size);
        for (const item of state.mutationInputPlan.diagnostics.filter((d: any) => d.status === 'conditional-equivalence')) {
            assert.ok(survivedIds.has(item.mutantId), 'conditional-equivalence candidates remain in the measured survivors');
        }
        assert.doesNotMatch(logs.join('\n'), /Review incomplete.*continuing tool measurements/);
        const accepted = fs.readFileSync(path.join(output, state.acceptedTest), 'utf8');
        assert.equal(state.mutation.testHash, evidenceHash(accepted));
        assert.equal(state.reviewApproval.testHash, evidenceHash(accepted));
        assert.equal(state.mutation.sourceHash, state.sourceHash);
        assert.equal(state.reviewApproval.sourceHash, state.sourceHash);
        assert.ok(authoredMethodNames.length > 0);
        assert.ok(authoredMethodNames.every(name => accepted.includes(`def ${name}(self):`)),
            'the retained suite contains every exact-case method authored by the mocked Writer');
        assert.doesNotMatch(accepted, /class TestVerifiedState_|class TestTrace/);
        t.diagnostic(JSON.stringify({ writers, measurements: measured.length, quality, fixer,
            counts: state.mutation.counts, policy: state.qualityPolicy.policyId,
            reviewedAcceptedHash: state.reviewApproval.testHash === evidenceHash(accepted) }));
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally {
        setLanguage('zh-tw');
        globalThis.fetch = fetch; Module._load = load;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
