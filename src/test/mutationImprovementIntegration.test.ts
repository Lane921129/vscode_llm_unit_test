import { functionReportDirectory, roundDirectory } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { setLanguage } from '../i18n/core';

test('fallback history, measured boundary probes and incomplete roles survive real mutation rounds', async () => {
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
    const valid = `import unittest
from sample import categorize
class Cases(unittest.TestCase):
    def test_interior(self):
        self.assertEqual(categorize(20, 10), (20.0, 'high'))
`;
    let writers = 0, quality = 0, fixer = 0;
    // Keep exercising model repair/fallback: compound contexts are outside the
    // numeric skill. The reserved Writer repeats the failure so this test still
    // exercises outer Tier fallback. Arithmetic correction is covered separately.
    const unsupportedWrong = valid.replace('        self.assertEqual',
        '        with self.subTest():\n            self.assertEqual').replace('(20.0,', '(19.0,');
    globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        let response: string;
        if (request.system.includes('dependency_behaviors')) { response = '{"dependency_behaviors":[]}'; }
        else if (request.system.includes('You are the test Reviewer')) { response = 'invalid reviewer reply'; }
        else if (request.system.includes('Analyst after successful')) { quality++; response = 'invalid quality reply'; }
        else if (request.system.includes('Python unittest Bug Fixer')) { fixer++; response = '```python\npass\n```'; }
        else { writers++; response = '```python\n' + (writers <= 2 ? unsupportedWrong : valid) + '\n```'; }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        fs.writeFileSync(path.join(directory, 'sample.py'), source);
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture',
            paramSize: '13B', contextLength: 32768, qualificationVersion: QUALIFICATION_VERSION,
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture',
            filePath: path.join(directory, 'sample.py'), funcName: 'categorize', promptStrategy: 'tier2',
            validationMode: 'full', maxLoops: 4, mutpyTimeout: 120, timeoutSeconds: 60, outputPath: path.join(directory, 'results') });
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
        assert.equal(state.terminalStatus, 'execution-passed-review-incomplete', JSON.stringify({last:state.lastFailure, first:state.firstFailure, tiers:state.tierHistory}));
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
        assert.equal(quality, 0, 'meeting the 80% policy must stop further quality-model requests');
        assert.equal(measured.length, 2, 'stop once the complete measurement meets the fixed threshold');
        assert.equal(state.qualityPolicy.policyId, 'standard80-v1');
        assert.equal(state.qualityAssessment.toolsSatisfied, true);
        assert.equal(state.terminalStatus, 'execution-passed-review-incomplete');
        assert.match(report, /threshold ≥ 80%/);
        assert.doesNotMatch(report, /surviving mutants/);
        assert.equal(state.reviewStatus, 'incomplete');
        assert.equal(state.qualityAssessment.fullyPassed, false);
        assert.ok(state.mutationInputPlan.diagnostics.some((item: any) => item.status === 'conditional-equivalence' && item.excludedFromScore === false));
        const survivedIds = new Set(state.mutation.mutants.filter((m: any) => m.status === 'SURVIVED').map((m: any) => m.id));
        assert.equal(state.mutation.counts.survived, survivedIds.size);
        for (const item of state.mutationInputPlan.diagnostics.filter((d: any) => d.status === 'conditional-equivalence')) {
            assert.ok(survivedIds.has(item.mutantId), 'conditional-equivalence candidates remain in the measured survivors');
        }
        assert.match(logs.join('\n'), /Review incomplete.*continuing tool measurements/);
        assert.equal(fs.readFileSync(path.join(directory, 'sample.py'), 'utf8'), source);
    } finally {
        setLanguage('zh-tw');
        globalThis.fetch = fetch; Module._load = load;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
