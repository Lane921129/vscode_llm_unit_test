import { resultArtifactPath } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';

test('laboratory unpacked BMI candidate reaches execution and all arithmetic corrections are rerun with evidence', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmi-arithmetic-'));
    const file = path.join(root, 'bmi.py');
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
    const candidate = fs.readFileSync(path.join(repo, 'test/fixtures/repair/bmi_unpack_wrong.py'), 'utf8');
    const keep = '\n\n    def test_keep(self):\n        self.assertEqual(calculate_bmi(80, 200), (20.0, "健康體位"))\n';
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
    globalThis.fetch = async () => {
        requests++;
        assert.equal(requests, 1, 'proven arithmetic corrections must not depend on another guessed model answer');
        return new Response(JSON.stringify({ response: '```python\n' + candidate + keep + '\n```', done: true }), { status: 200 });
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
        assert.equal(events.filter(e => e.stage === 'source-expectation-repair' && e.status === 'candidate').length, 1);
        const proof = read(knowledge.expectationRepair.file);
        assert.equal(proof.basis, 'source-derived-arithmetic-v1');
        assert.equal(proof.sourceHash, knowledge.sourceHash);
        assert.equal(proof.corrections.length, 5, 'four numbers and the previously hidden wrong classification');
        assert.deepEqual(proof.corrections.filter((item: any) => typeof item.calculated === 'number').map((item: any) => item.calculated), [19.53, 17.58, 23.44, 31.25]);
        const baseline = read('execution_baseline.json');
        assert.equal(verifyExecutionEvidence(directory, file, baseline, read('run_manifest.json')), true);
        assert.equal(baseline.testHash, proof.candidateTestHash);
        const actual = fs.readFileSync(resultArtifactPath(directory, baseline.testFile), 'utf8');
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
