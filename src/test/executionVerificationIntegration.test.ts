import { readOllamaRoleRequest } from './ollamaRequestFixture';
import { functionReportDirectory, resultArtifactPath } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { verifyExecutionEvidence } from '../pipeline/executionEvidence';
import { BatchJournal } from '../pipeline/batchJournal';
import { presentOutcome } from '../pipeline/resultPresentation';
import { verificationMode } from '../pipeline/verificationMode';
import { setLanguage } from '../i18n/core';

test('execution mode runs real guarded tests, preserves failures, and never invokes deferred tools', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-mode-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const runner = require('../utils/processRunner'), originalSpawn = runner.runSpawn;
    const handlers = new Map<string, (...args: any[]) => any>(), messages: any[] = [], requests: any[] = [];
    let replies: string[] = [], changeSource = false, cancel = false;
    const settings: Record<string, unknown> = { validationMode: 'execution', language: 'en' };
    const file = path.join(root, 'sample.py');
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { messages.push(message); return true; } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : settings[key] ?? fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    runner.runSpawn = (command: string, args: string[], options: any) => {
        assert.ok(!args.some(arg => /dynamic_tracer|basic_mutation_runner|mock_scaffold|--coverage-source|^import coverage$/.test(arg)), args.join(' '));
        assert.ok(!args.includes('coverage') && !args.includes('mutmut'));
        return originalSpawn(command, args, options);
    };
    globalThis.fetch = async (_url, options) => {
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body))); requests.push(request);
        assert.ok(!/You are the test Reviewer|SEMANTIC_ANALYZER|QUALITY_TASK/.test(request.roleInstructions));
        if (changeSource) { fs.appendFileSync(file, '\n# source changed\n'); }
        if (cancel) { handlers.get('llm-unit-test.abortTest')!(); }
        const response = replies.length > 1 ? replies.shift()! : replies[0];
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    const good = 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(target(2), 3)\n';
    const source = 'def target(value):\n    return value + 1\n';
    const fence = (code: string) => '```python\n' + code + '\n```';
    const run = async (name: string, code = good, targetSource = source, strategy = 'tier1', repair?: string) => {
        fs.writeFileSync(file, targetSource); replies = [fence(code), ...(repair ? [fence(repair)] : [])];
        const outputPath = path.join(root, name);
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: file,
            funcName: 'target', outputPath, promptStrategy: strategy, maxLoops: 3, timeoutSeconds: 30 });
        const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(name => path.basename(name) === 'function_knowledge.json')!;
        const directory = path.dirname(path.join(outputPath, report));
        return { directory, knowledge: JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8')) };
    };
    try {
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        assert.equal(verificationMode(), 'full'); assert.throws(() => verificationMode('fast'));
        const passed = await run('pass');
        const englishReport = fs.readFileSync(path.join(functionReportDirectory(passed.directory), 'final_report.md'), 'utf8');
        assert.match(englishReport, /## Final outcome: Execution verified/);
        assert.match(englishReport, /\*\*Mutation score\*\*: N\/A \(Not run\)/);
        assert.match(englishReport, /\*\*Target function\*\*: target/);
        assert.doesNotMatch(englishReport, /\*\*(?:目標檔案|測試函式|驗證目標)\*\*/);
        assert.equal(passed.knowledge.terminalStatus, 'execution-passed', JSON.stringify(passed.knowledge.lastFailure));
        assert.equal(passed.knowledge.validationMode, 'execution');
        assert.equal(passed.knowledge.qualityAssessment, null); assert.equal(passed.knowledge.coverage, null);
        assert.equal(passed.knowledge.mutationScore, null); assert.equal(passed.knowledge.reviewStatus, 'deferred');
        assert.equal(presentOutcome(passed.knowledge).kind, 'executed');
        assert.equal(requests.length, 1); assert.match(requests[0].roleInstructions, /EXECUTION_VERIFICATION_V1/);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
        assert.ok(messages.some(message => message.outcome?.kind === 'executed'));
        const baseline = JSON.parse(fs.readFileSync(path.join(passed.directory, 'execution_baseline.json'), 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(path.join(passed.directory, 'run_manifest.json'), 'utf8'));
        assert.equal(manifest.validationMode, 'execution'); assert.equal(manifest.qualityPolicy, undefined);
        assert.equal(verifyExecutionEvidence(passed.directory, file, baseline, manifest), true);
        for (const [field, value] of Object.entries({ target: 'other', testHash: '0'.repeat(64), runId: 'old',
            testFile: '../sample.py', invocationFile: 'missing.json', sourceHash: '0'.repeat(64) })) {
            assert.equal(verifyExecutionEvidence(passed.directory, file, { ...baseline, [field]: value }, manifest), false, field);
        }
        const invocationPath = resultArtifactPath(passed.directory, baseline.invocationFile);
        const invocation = JSON.parse(fs.readFileSync(invocationPath, 'utf8'));
        for (const override of [{ observed: false }, { profileIntact: false }, { status: 'running' },
            { testResult: { ...invocation.testResult, skipped: invocation.testResult.testsRun } },
            { testResult: { ...invocation.testResult, expectedFailures: invocation.testResult.testsRun } }]) {
            fs.writeFileSync(invocationPath, JSON.stringify({ ...invocation, ...override }));
            assert.equal(verifyExecutionEvidence(passed.directory, file, baseline, manifest), false);
        }
        fs.writeFileSync(invocationPath, JSON.stringify(invocation));
        // Batch recount uses the underlying proof; an execution pass is never a full quality pass.
        const batch = new BatchJournal(path.dirname(functionReportDirectory(passed.directory)), root,
            { model: 'fixture', buildTimestamp: 'test', python, validationMode: 'execution' });
        batch.discover(file, ['target']); batch.start(); batch.begin(0); batch.attach(0, functionReportDirectory(passed.directory)); batch.refresh(0); batch.finish('completed');
        const batchManifest = () => JSON.parse(fs.readFileSync(path.join(batch.directory, 'batch_manifest.json'), 'utf8'));
        assert.equal(batchManifest().allTargetsExecutionVerified, true); assert.equal(batchManifest().allTargetsPassed, false);
        fs.appendFileSync(resultArtifactPath(passed.directory, baseline.testFile), '\n# edited\n'); batch.refresh(0); batch.finish('completed');
        assert.equal(batchManifest().complete, false); assert.equal(batchManifest().allTargetsExecutionVerified, false);

        for (const [name, code, input] of [
            ['assert-failed', good.replace('target(2), 3', 'target(2), 999'), source],
            ['no-target', good.replace('target(2), 3', '3, 3'), source],
            ['target-mocked', good.replace('from sample import target', 'from sample import target\nfrom unittest.mock import patch')
                .replace('        self.assertEqual(target(2), 3)', "        with patch('sample.target', return_value=3):\n            self.assertEqual(target(2), 3)"), source],
            ['all-skipped', good.replace('    def test_value', "    @unittest.skip('skip')\n    def test_value"), source],
            ['isolation', good, 'from pathlib import Path\ndef target(value):\n    Path("must_not_exist").mkdir()\n    return value + 1\n'],
            ['import-failed', good, 'import module_that_does_not_exist_987\n' + source]
        ]) {
            const failed = await run(name, code, input);
            assert.equal(failed.knowledge.terminalStatus, 'failed', name);
            assert.notEqual(presentOutcome(failed.knowledge).kind, 'executed', name);
            assert.equal(fs.existsSync(path.join(failed.directory, 'execution_baseline.json')), false, name);
            assert.equal(fs.readFileSync(file, 'utf8'), input);
        }
        assert.equal(fs.existsSync(path.join(root, 'must_not_exist')), false);
        settings.importFixtures = [{ file: 'sample.py', mkdir: true }]; settings.importFixtureRoot = root;
        const initializedSource = 'from pathlib import Path\nPath("must_not_exist").mkdir()\n' + source;
        const initialized = await run('initialization', good, initializedSource);
        assert.equal(initialized.knowledge.terminalStatus, 'execution-passed', JSON.stringify(initialized.knowledge.lastFailure));
        assert.ok(initialized.knowledge.importFixtureId);
        assert.equal(fs.readFileSync(file, 'utf8'), initializedSource);
        assert.equal(fs.existsSync(path.join(root, 'must_not_exist')), false);
        settings.importFixtureRoot = path.join(root, 'unrelated-removed-project');
        const foreignRules = JSON.stringify(settings.importFixtures);
        const unrelated = await run('unrelated-setup', good, source);
        assert.equal(unrelated.knowledge.terminalStatus, 'execution-passed');
        assert.equal(unrelated.knowledge.importFixtureId, undefined);
        const stillBlocked = await run('unrelated-setup-blocked', good, initializedSource);
        assert.equal(stillBlocked.knowledge.terminalStatus, 'failed');
        assert.equal(fs.existsSync(path.join(root, 'must_not_exist')), false);
        assert.equal(JSON.stringify(settings.importFixtures), foreignRules);
        settings.importFixtureRoot = root;
        const restored = await run('restored-setup', good, initializedSource);
        assert.equal(restored.knowledge.importFixtureId, initialized.knowledge.importFixtureId);
        delete settings.importFixtures; delete settings.importFixtureRoot;
        const repaired = await run('repair', good.replace('target(2), 3', 'target(2), 999'), source, 'tier1',
            'def test_value(self):\n    self.assertEqual(target(2), 3)');
        assert.equal(repaired.knowledge.terminalStatus, 'execution-passed', JSON.stringify(repaired.knowledge.lastFailure));
        assert.ok(fs.existsSync(resultArtifactPath(repaired.directory, 'exec1_test.py')));
        assert.equal(repaired.knowledge.acceptedTest, 'exec2_test.py');
        changeSource = true;
        const changed = await run('changed'); changeSource = false;
        assert.equal(changed.knowledge.evidenceValid, false);
        assert.equal(changed.knowledge.failureStage, 'source-changed');
        assert.equal(changed.knowledge.terminalStatus, 'source-changed');
        const before = requests.length;
        const unqualified = await run('unqualified', good, source, 'auto');
        assert.equal(requests.length, before); assert.equal(unqualified.knowledge.failureStage, 'writer-qualification');
        cancel = true;
        const cancelled = await run('cancelled'); cancel = false;
        assert.equal(cancelled.knowledge.terminalStatus, 'cancelled');
    } finally {
        setLanguage('zh-tw');
        Module._load = originalLoad; globalThis.fetch = originalFetch; runner.runSpawn = originalSpawn;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
