import { resultArtifactPath } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';
import { evidenceHash } from '../pipeline/analysisJournal';

test('laboratory unpacked BMI failures hand arithmetic hypotheses to AI and execute its exact revision', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmi-arithmetic-'));
    const file = path.join(root, 'bmi.py');
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
    const candidate = fs.readFileSync(path.join(repo, 'test/fixtures/repair/bmi_unpack_wrong.py'), 'utf8').replace(/\r\n/g, '\n');
    const keep = '\n\n    def test_keep(self):\n        self.assertEqual(calculate_bmi(80, 200), (20.0, "健康體位"))\n';
    const initial = candidate + keep;
    const corrected = initial.replace('25.62', '19.53').replace('21.22', '17.58')
        .replace('28.96', '23.44').replace('32.72', '31.25')
        .replace('self.assertAlmostEqual(bmi, 23.44, delta=0.01)\n        self.assertEqual(status, "體重過重")',
            'self.assertAlmostEqual(bmi, 23.44, delta=0.01)\n        self.assertEqual(status, "健康體位")');
    fs.writeFileSync(file, source);
    const settings: Record<string, unknown> = { pythonPath: resolvePythonExecutable(undefined, repo), projectPath: root, validationMode: 'execution' };
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let requests = 0;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (_url, options) => {
        requests++;
        assert.ok(requests <= 2, 'the Writer must revise once from bounded arithmetic evidence');
        const request = JSON.parse(String(options?.body));
        assert.doesNotMatch(request.system, /Reviewer|Python unittest Bug Fixer/,
            'multiple failing methods use Writer revision; execution mode does not review');
        if (requests === 2) {
            assert.match(request.prompt, /SOURCE-DERIVED CALCULATION HYPOTHESES \(not independently verified\)/);
            assert.match(request.prompt, /"assertionOracle":false/);
            assert.match(request.prompt, /The AI must revise the test/);
            assert.match(request.prompt, /19\.53 != 25\.62/);
        }
        return new Response(JSON.stringify({ response: '```python\n' + (requests === 1 ? initial : corrected) + '\n```', done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture', paramSize: '13B', contextLength: 32768 });
        const outputPath = path.join(root, 'results');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: file,
            funcName: 'calculate_bmi', outputPath, promptStrategy: 'tier2', maxLoops: 2, timeoutSeconds: 30 });
        const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json')!;
        const directory = path.dirname(path.join(outputPath, report));
        const read = (name: string) => JSON.parse(fs.readFileSync(resultArtifactPath(directory, name), 'utf8'));
        const knowledge = read('function_knowledge.json');
        assert.equal(knowledge.terminalStatus, 'execution-passed', JSON.stringify(knowledge.lastFailure));
        const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(events.some(e => e.stage === 'structure' && e.status === 'passed' && e.detail.attempt === 0));
        assert.ok(events.some(e => e.stage === 'validation' && e.status === 'failed' && /19.53 != 25.62/.test(e.detail.out)));
        assert.equal(requests, 2, 'the saved correction comes from an AI revision');
        assert.equal(events.filter(e => e.stage === 'repair-evidence' && e.status === 'provided').length, 1);
        assert.equal(events.filter(e => e.stage === 'source-expectation-repair' && e.status === 'candidate').length, 0,
            'the arithmetic tool must not substitute a test candidate');
        const proof = read(knowledge.expectationRepair.file);
        assert.equal(proof.basis, 'source-derived-arithmetic-v1');
        assert.equal(proof.sourceHash, knowledge.sourceHash);
        assert.equal(proof.assertionOracle, false, 'execution mode has not independently observed the arithmetic hypotheses');
        assert.equal(proof.candidateTestHash, undefined, 'the tool does not own the repaired candidate');
        assert.equal(proof.corrections.length, 5, 'four numbers and the previously hidden wrong classification');
        assert.deepEqual(proof.corrections.filter((item: any) => typeof item.calculated === 'number').map((item: any) => item.calculated), [19.53, 17.58, 23.44, 31.25]);
        const baseline = read('execution_baseline.json');
        assert.equal(verifyExecutionEvidence(directory, file, baseline, read('run_manifest.json')), true);
        const original = fs.readFileSync(resultArtifactPath(directory, 'exec1_test.py'), 'utf8');
        assert.equal(original.trim(), initial.trim(), 'the first failed AI candidate remains unchanged');
        assert.equal(proof.previousTestHash, evidenceHash(original));
        const actual = fs.readFileSync(resultArtifactPath(directory, baseline.testFile), 'utf8');
        assert.equal(actual.trim(), corrected.trim(), 'only the exact AI revision is accepted and rerun');
        assert.equal(baseline.testHash, evidenceHash(actual));
        assert.doesNotMatch(actual, /TestVerifiedTrace|TestVerifiedState/);
        assert.ok(actual.includes('bmi, status = calculate_bmi'));
        assert.ok(actual.endsWith(keep.trimEnd()));
        assert.equal(read(baseline.invocationFile).testResult.testsRun, 5);
        assert.equal(read(baseline.invocationFile).testResult.failures, 0);
        assert.match(fs.readFileSync(path.join(directory, 'workflow_report.md'), 'utf8'), /預期值修正/);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
