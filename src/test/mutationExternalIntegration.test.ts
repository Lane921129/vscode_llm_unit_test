import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { functionReportDirectory, roundDirectory } from '../pipeline/resultLayout';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { setLanguage } from '../i18n/core';

test('full orchestrator uses real Mutatest and retains rejected source/test identity evidence', async t => {
    const repo = path.resolve(__dirname, '../..');
    const projectPython = resolvePythonExecutable(undefined, repo);
    const python = process.env.LLM_TEST_EXTERNAL_PYTHON || projectPython;
    const adapter = path.join(repo, 'python_scripts/external_mutation_runner.py');
    const probe = spawnSync(python, ['-B', adapter, '--probe', 'mutatest'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
    const availability = JSON.parse(probe.stdout);
    if (process.env.LLM_TEST_EXTERNAL_PYTHON) { assert.equal(availability.supported, true, availability.diagnosticCode); }
    if (!availability.supported) { t.skip('verified mutatest AST API is absent from this test Python'); return; }

    // The optional external test venv contains Mutatest only. Share the test
    // workspace's installed coverage without changing either environment.
    const sites = spawnSync(projectPython, ['-B', '-c', 'import json,site;print(json.dumps(site.getsitepackages()))'],
        { encoding: 'utf8', timeout: 10000 });
    assert.equal(sites.status, 0, sites.stderr || sites.error?.message);
    const originalPythonPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = [...JSON.parse(sites.stdout), ...(originalPythonPath ? [originalPythonPath] : [])].join(path.delimiter);
    const prefix = path.join(os.tmpdir(), 'external-full-');
    const root = fs.mkdtempSync(prefix);
    const sourceFile = path.join(root, 'sample.py');
    const source = 'def combine(a, b):\n    return a + b\n';
    fs.writeFileSync(sourceFile, source);
    const candidate = 'import unittest\nfrom sample import combine\nclass Cases(unittest.TestCase):\n'
        + '    def test_sum(self):\n        self.assertEqual(combine(2, 3), 5)\n';
    const settings: Record<string, unknown> = { pythonPath: python, projectPath: root, language: 'en',
        mutationEngine: 'mutatest', mutationWorkers: 2 };
    const handlers = new Map<string, (...args: any[]) => any>();
    const logs: string[] = [];
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const processRunner = require('../utils/processRunner'), originalSpawn = processRunner.runSpawn;
    let corrupt: 'sourceHash' | 'testHash' | undefined;
    let externalRuns = 0, builtinRuns = 0;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        env: { openExternal: async () => true },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { if (message.text) { logs.push(message.text); } return true; } };
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
        const request = JSON.parse(String(options?.body));
        const response = request.system.includes('dependency_behaviors') ? '{"dependency_behaviors":[]}'
            : request.system.includes('You are the test Reviewer') ? '{"findings":[]}' : '```python\n' + candidate + '\n```';
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    processRunner.runSpawn = async (command: string, args: string[], options: any) => {
        if (args[0]?.endsWith('basic_mutation_runner.py')) { builtinRuns++; }
        const result = await originalSpawn(command, args, options);
        if (args[0]?.endsWith('external_mutation_runner.py') && !args.includes('--probe')) {
            externalRuns++;
            assert.equal(args[1], 'mutatest');
            if (corrupt) {
                const wire = JSON.parse(result.stdout); wire[corrupt] = 'f'.repeat(64);
                return { ...result, stdout: JSON.stringify(wire) };
            }
        }
        return result;
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'external-fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture', paramSize: '13B', contextLength: 32768 });
        for (const changedHash of [undefined, 'testHash', 'sourceHash'] as const) {
            corrupt = changedHash;
            const outputPath = path.join(root, changedHash || 'valid');
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: sourceFile,
                funcName: 'combine', outputPath, promptStrategy: 'tier2', validationMode: 'full',
                maxLoops: 1, timeoutSeconds: 30, mutpyTimeout: 60 });
            const relative = fs.readdirSync(outputPath, { recursive: true }).map(String)
                .find(p => path.basename(p) === 'function_knowledge.json');
            assert.ok(relative, logs.join('\n'));
            const directory = path.dirname(path.join(outputPath, relative));
            const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
            const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            assert.equal(knowledge.mutationSelection.requested, 'mutatest');
            assert.equal(knowledge.mutationSelection.actual, 'mutatest');
            const mutationPath = path.join(roundDirectory(directory, 1), 'loop1_mutation.json');
            assert.ok(fs.existsSync(mutationPath), JSON.stringify(knowledge.lastFailure));
            const mutation = JSON.parse(fs.readFileSync(mutationPath, 'utf8'));
            const report = fs.readFileSync(path.join(functionReportDirectory(directory), 'final_report.md'), 'utf8');
            if (!changedHash) {
                assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.qualityAssessment || knowledge.lastFailure));
                assert.equal(knowledge.qualityAssessment.fullyPassed, true);
                assert.equal(knowledge.reviewStatus, 'completed');
                assert.equal(knowledge.coverage.assessment.targetFullyCovered, true);
                assert.equal(mutation.engine, 'mutatest');
                assert.equal(mutation.engineVersion, '3.1.0');
                assert.equal(mutation.operatorSetVersion, 'mutatest-ast-3.1.0-v1');
                assert.equal(mutation.executionBackend, 'isolated-unittest-v1');
                assert.equal(mutation.counts.available, 6); assert.equal(mutation.counts.killed, 6);
                assert.ok(mutation.mutants.every((item: any) => item.killedBy.length > 0));
                assert.ok(events.find(e => e.stage === 'mutation-engine').sequence < events.find(e => e.stage === 'model-request').sequence);
                assert.match(report, /Final outcome: Fully passed/);
                assert.match(report, /mutatest.*mutatest-ast-3.1.0-v1/);
                assert.match(report, /Mutation execution diagnostics/);
            } else {
                assert.notEqual(knowledge.terminalStatus, 'passed');
                assert.notEqual(knowledge.qualityAssessment?.fullyPassed, true);
                assert.equal(mutation.engine, 'mutatest');
                assert.equal(mutation.status, 'failed'); assert.equal(mutation.scoreAvailable, false);
                assert.match(mutation.diagnostic, /source\/test identity does not match/);
                assert.equal(knowledge.latestMutation.diagnostic, mutation.diagnostic);
                assert.doesNotMatch(knowledge.failure, /rules version differs|規則版本與預檢不一致/);
                assert.doesNotMatch(report, /Final outcome: Fully passed/);
            }
            assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
        }
        assert.equal(externalRuns, 3); assert.equal(builtinRuns, 0, 'external failures must never silently select builtin');
    } finally {
        setLanguage('zh-tw'); Module._load = originalLoad; globalThis.fetch = originalFetch; processRunner.runSpawn = originalSpawn;
        if (originalPythonPath === undefined) { delete process.env.PYTHONPATH; } else { process.env.PYTHONPATH = originalPythonPath; }
        assert.ok(root.startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true });
    }
});
