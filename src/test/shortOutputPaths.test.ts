import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ROW_RUN_DIRECTORY, CASE_TABLE_TEST_FILE, INVOCATION_SUFFIX, ISOLATION_SUFFIX, RUNNER_RESULT_SUFFIX,
    rowTestModule, candidateTestModule, mergedTestModule, coverageTestModule } from '../pipeline/caseTable/artifactNames';
import { estimateBatchOutputPath, preflightBatchOutputPath } from '../pipeline/batchOutputPath';
import { checkOutputPath } from '../pipeline/artifactPaths';
import { runTestFile } from '../pipeline/caseTable/rowExecution';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

test('v2 short names cover rows, retries, follow-up, candidates, merged tests and coverage', () => {
    assert.equal(ROW_RUN_DIRECTORY, 'r');
    assert.equal(CASE_TABLE_TEST_FILE, 't.py');
    assert.equal(rowTestModule('C3', 0) + '.py', 'c3_0.py');
    assert.equal(rowTestModule('C3', 2), 'c3_2');
    assert.equal(rowTestModule('C3', 0, '_followup'), 'c3_0f');
    assert.equal(candidateTestModule('C3'), 'k_c3');
    assert.equal(candidateTestModule('C3', '_followup'), 'k_c3f');
    assert.equal(mergedTestModule(), 't');
    assert.equal(mergedTestModule('_followup'), 'tf');
    assert.equal(coverageTestModule('12345678'), 'g_12345678');
    assert.deepEqual([INVOCATION_SUFFIX, ISOLATION_SUFFIX, RUNNER_RESULT_SUFFIX], ['.inv.json', '.iso.jsonl', '.res.json']);
});

test('Windows path preflight rejects a long root and allows a short root for both versions; other platforms only log', () => {
    const targets = [{ file: 'validators_utils.py', target: '_func_args_as_dict' }, { file: 'a.py', target: 'f' }];
    for (const pipelineVersion of ['v1', 'v2-case-table']) {
        const logs: string[] = [];
        const options = { batchDirectory: 'C:/r/eval_screening_2026_11_15_01_00', targets, pipelineVersion, platform: 'win32' as const };
        const short = preflightBatchOutputPath(options, line => logs.push(line));
        assert.equal(short.blocked, false);
        assert.equal(short.temporaryAllowance, 60);
        const longest = path.win32.join('validators_utils_00000000', '_func_args_as_dict_00000000');
        assert.equal(short.estimatedLength, path.win32.resolve(options.batchDirectory, longest, short.longestArtifact).length + 60);
        const long = { ...options, batchDirectory: 'C:/' + 'long-output/'.repeat(16) };
        const estimate = estimateBatchOutputPath(long);
        assert.throws(() => preflightBatchOutputPath(long, line => logs.push(line)), /250.*C:/);
        assert.ok(logs.at(-1)?.includes(String(estimate.estimatedLength)));
        assert.ok(logs.at(-1)?.includes('250'));
        assert.ok(logs.at(-1)?.includes('C:'));
        assert.equal(preflightBatchOutputPath({ ...long, platform: 'linux' }, line => logs.push(line)).blocked, false);
    }
    assert.doesNotThrow(() => checkOutputPath('/' + 'x'.repeat(300), 0, 'linux'));
});

test('250 characters passes while 251 stops before dispatch', () => {
    const options = { batchDirectory: 'C:/', pipelineVersion: 'v2-case-table', targets: [{ file: 'a.py', target: 'f' }], platform: 'win32' as const };
    const fixed = estimateBatchOutputPath(options).estimatedLength;
    const directory = 'C:/' + 'x'.repeat(250 - fixed - 1);
    assert.equal(estimateBatchOutputPath({ ...options, batchDirectory: directory }).estimatedLength, 250);
    assert.doesNotThrow(() => preflightBatchOutputPath({ ...options, batchDirectory: directory }, () => {}));
    assert.throws(() => preflightBatchOutputPath({ ...options, batchDirectory: directory + 'x' }, () => {}), /251/);
});

test('short row files execute with invocation/result/isolation evidence and preserve wx protection', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-short-'));
    try {
        const file = path.join(directory, 'sample.py');
        fs.writeFileSync(file, 'def double(x): return x * 2\n');
        const artifacts = path.join(directory, 'r');
        fs.mkdirSync(artifacts);
        const runtime = { python: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')), sourceFile: file,
            target: 'double', importPaths: [directory], artifacts };
        const code = 'import unittest\nfrom sample import double\nclass Tests(unittest.TestCase):\n    def test_value(self): self.assertEqual(double(3), 6)\n';
        const result = await runTestFile(runtime, 'c3_0f', code, false, 'C3');
        assert.equal(result.passed, true);
        assert.equal(result.targetObserved, true);
        for (const suffix of ['.py', '.inv.json', '.res.json', '.iso.jsonl']) {
            assert.ok(fs.existsSync(path.join(artifacts, 'c3_0f' + suffix)), suffix);
        }
        await assert.rejects(runTestFile(runtime, 'c3_0f', 'overwriting is forbidden'), { code: 'EEXIST' });
        assert.equal(fs.readFileSync(result.testFile, 'utf8'), code);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the Windows batch command reports length and remedy before target dispatch or model requests', { skip: process.platform !== 'win32' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const logs: string[] = [], errors: string[] = [];
    let modelRequests = 0;
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const settings: Record<string, unknown> = { pythonPath: python, pipelineVersion: 'v2-case-table', language: 'zh-tw' };
    const vscode = {
        ExtensionMode: { Test: 3, Development: 2 },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
        window: {
            registerWebviewViewProvider: (_name: string, provider: any) => {
                provider.webview = { postMessage: async (message: any) => {
                    if (message.command === 'appendLog') { logs.push(message.text); }
                    return true;
                } };
                return { dispose() {} };
            },
            showErrorMessage: async (message: string) => { errors.push(message); }, showInformationMessage: async () => {}
        },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async () => { modelRequests++; throw new Error('No model request is allowed'); };
    try {
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        const outputPath = path.join(root, 'x'.repeat(100));
        await handlers.get('llm-unit-test.runBatchAnalysis')!({ envType: 'custom', modelName: 'fixture',
            batchPath: root, outputPath, promptStrategy: 'tier1', maxLoops: 1, timeoutSeconds: 30 });
        assert.equal(modelRequests, 0);
        assert.equal(logs.some(line => line.includes('批次目標：')), false);
        const diagnostic = logs.find(line => line.includes('路徑估算'));
        assert.ok(diagnostic);
        assert.ok(Number(diagnostic.match(/(\d+) 字/)?.[1]) > 250);
        assert.match(diagnostic, /250.*C:/);
        assert.ok(errors.some(line => line.includes('output-path-preflight')));
        assert.equal(fs.existsSync(outputPath), false, 'reservation guard runs before creating even the output root');
        const veryLongOutput = path.join(root, 'x'.repeat(260));
        await handlers.get('llm-unit-test.runBatchAnalysis')!({ envType: 'custom', modelName: 'fixture',
            batchPath: root, outputPath: veryLongOutput, promptStrategy: 'tier1' });
        assert.equal(modelRequests, 0);
        assert.equal(errors.length, 2);
        assert.ok(errors.every(line => /250.*C:/.test(line)), 'even an uncreatable path receives the length diagnostic');
    } finally {
        Module._load = originalLoad;
        globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

for (const sourceName of ['t', 'T', 'tf', 'c1_0']) {
    test(`short artifacts cannot shadow the real target module ${sourceName}.py`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-module-collision-'));
        try {
            const file = path.join(directory, sourceName + '.py');
            fs.writeFileSync(file, sourceName === 'tf' ? 'def double(x):\n    if x > 0:\n        return x * 2\n    return -x\n' : 'def double(x): return x * 2\n', 'utf8');
            let requests = 0;
            const original = fs.readFileSync(file, 'utf8');
            const result = await runCaseTablePipeline({ caseTableReview: 'off', filePath: file, funcName: 'double', projectRoot: directory,
                outputPath: path.join(directory, 'out'), sessionDate: 'collision',
                pythonExecutable: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')),
                specOracle: 'off', qualityAnalyst: 'off', mutation: { engine: 'builtin', workers: 1, stageSeconds: 30 },
                testFocus: sourceName === 'tf' ? 'coverage' : 'full',
                log: () => {}, requestModel: async () => JSON.stringify({ scenario: 'double', category: 'normal',
                    args: ++requests === 1 ? '(3,)' : '(-3,)', kwargs: '{}', mocks: '', requirement: '' }) });
            assert.equal(result.stage!.terminal, 'usable');
            assert.equal(result.rows[0].status, 'test-passed');
            assert.equal(typeof result.stage!.mutation!.score, 'number');
            assert.equal(result.stage!.coverage!.available, true);
            assert.equal(path.basename(result.stage!.testFile!), sourceName === 'tf' ? 'tf.py' : 't.py');
            if (sourceName === 'tf') { assert.equal(requests, 2, 'the follow-up must execute the colliding tf.py'); }
            assert.equal(fs.readFileSync(file, 'utf8'), original);
            const files = fs.readdirSync(path.join(result.directory, 'r'));
            assert.equal(files.some(name => /^m_[0-9a-f]{8}\.py$/.test(name)), sourceName !== 'c1_0');
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
}
