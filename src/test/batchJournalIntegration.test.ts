import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BatchJournal } from '../pipeline/batchJournal';
import { evidenceHash } from '../pipeline/analysisJournal';
import { createStrictQualityPolicy, evaluateQuality } from '../pipeline/qualityPolicy';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { findPythonFilesInDir } from '../utils/utils';

test('real batch command records grouped failures and cancellation, then passes a controlled clock through Python, review and mutation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-integration-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module');
    const originalLoad = Module._load;
    const originalFetch = globalThis.fetch;
    const utilities = require('../utils/utils');
    const originalEngine = utilities.detectMutationEngine;
    const handlers = new Map<string, (...args: any[]) => any>();
    let modelCalls = 0;
    let cancelFirstTarget = false;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => {
                if (cancelFirstTarget && message.text?.includes('批次目標：')) {
                    cancelFirstTarget = false; handlers.get('llm-unit-test.abortTest')!();
                }
                return true;
            } }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {},
        showWarningMessage: async () => '繼續測試並記錄失敗' },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback }), openTextDocument: async () => ({}) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }, env: { openExternal: async () => true }, Uri: { file: (file: string) => file }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async () => { modelCalls++; throw new Error('Environment errors must not request models'); };
    try {
        fs.writeFileSync(path.join(root, 'a_missing.py'), 'import fixture_dependency_not_installed\ndef first(x): return x + 1\ndef second(x): return x - 1\n');
        fs.writeFileSync(path.join(root, 'b_boundary.py'), 'import setup_state\ndef first(x): return x + 1\ndef second(x): return x - 1\n');
        fs.writeFileSync(path.join(root, 'setup_state.py'), 'from pathlib import Path\nPath("must_not_exist").mkdir()\n');
        fs.writeFileSync(path.join(root, 'c_skipped.py'), 'def dummy_noise(): return 1\ndef placeholder(): pass\n');
        const broken = path.join(root, 'broken.py');
        fs.writeFileSync(broken, 'def invalid(\n');
        const { activate } = require('../orchestrator');
        activate({ extension: { id: 'fixture.extension', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        const params = { envType: 'local', modelName: 'fixture', batchPath: root, promptStrategy: 'tier2',
            maxLoops: 1, timeoutSeconds: 30, outputPath: path.join(root, 'results') };
        const run = handlers.get('llm-unit-test.runBatchAnalysis')!;
        const manifests = () => fs.readdirSync(params.outputPath).map(name => {
            const directory = path.join(params.outputPath, name);
            return { directory, manifest: JSON.parse(fs.readFileSync(path.join(directory, 'batch_manifest.json'), 'utf8')) };
        });
        await run(params);
        const first = manifests()[0];
        assert.equal(first.manifest.status, 'incomplete');
        assert.equal(first.manifest.expectedTargets, 6);
        assert.equal(first.manifest.finishedTargets, 6);
        assert.equal(first.manifest.allTargetsPassed, false);
        assert.deepEqual(first.manifest.statusCounts, { failed: 4, 'dummy-skipped': 1, 'stub-smoke-generated': 1 });
        assert.deepEqual(first.manifest.discoveryFailures, [{ file: 'broken.py', stage: 'ast-discovery' }]);
        assert.deepEqual(first.manifest.environmentIssues.map((item: any) => [item.kind, item.issue, item.affectedTargets]), [
            ['missing-dependency', 'fixture_dependency_not_installed', 2],
            ['import-side-effect', 'os.mkdir (setup_state.py:2)', 2]
        ]);
        assert.ok(first.manifest.targets.every((item: any) => !item.modelRequests));
        assert.equal(fs.existsSync(path.join(root, 'must_not_exist')), false);
        const firstBytes = fs.readFileSync(path.join(first.directory, 'batch_manifest.json'), 'utf8');
        fs.writeFileSync(broken, '# corrected syntax, no functions\n');
        await run(params);
        assert.equal(fs.readFileSync(path.join(first.directory, 'batch_manifest.json'), 'utf8'), firstBytes);
        const second = manifests().find(item => item.manifest.batchId !== first.manifest.batchId)!;
        assert.equal(second.manifest.status, 'completed');
        assert.equal(second.manifest.complete, true);
        assert.equal(second.manifest.allTargetsPassed, false);
        assert.equal(second.manifest.expectedTargets, 6, 'nested output folder must not be discovered as source');
        cancelFirstTarget = true;
        await run(params);
        const cancelled = manifests().find(item => item.manifest.status === 'cancelled')!;
        assert.ok(cancelled);
        assert.equal(cancelled.manifest.complete, false);
        assert.equal(cancelled.manifest.statusCounts.pending, 5);
        await run({ ...params, batchPath: path.join(root, 'missing-folder') });
        const unreadable = manifests().find(item => item.manifest.status === 'failed')!;
        assert.equal(unreadable.manifest.complete, false);
        assert.deepEqual(unreadable.manifest.discoveryFailures, [{ file: '.', stage: 'source-discovery' }]);
        assert.equal(modelCalls, 0);

        // Neutral provider fixture supplies controlled tests; the production
        // pipeline still runs actual Python, coverage and mutation gates.
        const clockRoot = path.join(root, 'clock_case');
        fs.mkdirSync(clockRoot);
        fs.writeFileSync(path.join(clockRoot, 'clock_sample.py'),
            'from datetime import datetime\ndef target():\n    return datetime.now().year + 1\n');
        const controlled = `import unittest
from unittest.mock import patch
from clock_sample import target
class Cases(unittest.TestCase):
    def test_fixed_year(self):
        with patch('clock_sample.datetime') as clock:
            clock.now.return_value.year = 2001
            self.assertEqual(target(), 2002)
            clock.now.assert_called_once_with()
`;
        const roles: string[] = [];
        globalThis.fetch = async (_url, options) => {
            const request = JSON.parse(String(options?.body));
            let response: string;
            if (request.system.includes('You are the test Reviewer')) {
                roles.push('reviewer'); response = '{"findings":[]}';
            } else if (request.system.includes('Analyst after successful')) {
                roles.push('analyst-quality'); response = '{"tasks":[]}';
            } else if (request.system.includes('dependency_behaviors')) {
                roles.push('analyst-planning'); response = '{"dependency_behaviors":[]}';
            } else {
                roles.push('writer');
                assert.match(request.prompt, /uncontrolled-ambient-read/);
                response = '```python\n' + controlled + '\n```';
            }
            return new Response(JSON.stringify({ response }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        utilities.detectMutationEngine = () => null;
        await run({ ...params, batchPath: clockRoot });
        const clockRun = manifests().find(item => item.manifest.targets[0]?.file === 'clock_sample.py')!;
        assert.ok(clockRun);
        const clockTarget = clockRun.manifest.targets[0];
        const clockOutput = path.join(clockRun.directory, clockTarget.reportDirectory);
        const knowledge = JSON.parse(fs.readFileSync(path.join(clockOutput, 'function_knowledge.json'), 'utf8'));
        assert.equal(clockTarget.terminalStatus, 'passed', JSON.stringify({ status: knowledge.terminalStatus,
            failure: knowledge.lastFailure, diagnostic: knowledge.diagnostic, gaps: knowledge.qualityGaps }));
        assert.equal(clockRun.manifest.allTargetsPassed, true);
        assert.equal(knowledge.mutationScore, 100);
        assert.equal(knowledge.reviewStatus, 'completed');
        assert.ok(roles.includes('writer') && roles.includes('reviewer'));
        assert.ok(knowledge.initialTargetObservations.examples.every((item: any) => item.call_assertable === false));
        assert.equal(fs.readdirSync(clockOutput).some(name => /^loop\d+_trace_test\.py$/.test(name)), false);

        // These are the production files just created above, including real
        // guarded execution, selected-target coverage and a complete mutation
        // universe. No hand-built score or checkpoint substitutes for them.
        const readClockJson = (name: string) => JSON.parse(fs.readFileSync(path.join(clockOutput, name), 'utf8'));
        const runManifest = readClockJson('run_manifest.json');
        const executable = readClockJson('executable_baseline.json');
        const checkpoint = readClockJson('quality_baseline.json');
        const policy = createStrictQualityPolicy();
        for (const artifact of [runManifest, knowledge, executable, checkpoint]) {
            assert.deepEqual(artifact.qualityPolicy, policy, 'every stage must retain the policy fixed before execution');
        }
        const sourceFile = path.join(clockRoot, 'clock_sample.py');
        const testHash = evidenceHash(fs.readFileSync(path.join(clockOutput, knowledge.acceptedTest), 'utf8'));
        const sourceHash = evidenceHash(fs.readFileSync(sourceFile, 'utf8'));
        const targetScope = { kind: 'function' as const, qualifiedName: 'target' };
        const reassessment = evaluateQuality(policy, {
            identity: { sourcePath: sourceFile, sourceHash, testHash, targetScope, policyHash: policy.policyHash },
            executionPassed: Boolean(knowledge.execution?.trim()),
            coverage: { sourceHash, testHash, targetScope, assessment: knowledge.coverage.assessment },
            mutation: knowledge.mutation, reviewStatus: knowledge.reviewStatus,
            generationMode: knowledge.generationMode, qualityGaps: knowledge.qualityGaps
        });
        assert.equal(reassessment.measurementStatus, 'complete');
        assert.equal(reassessment.policyStatus, 'met');
        assert.equal(reassessment.fullyPassed, true, JSON.stringify(reassessment));
        assert.deepEqual(knowledge.qualityAssessment, reassessment);
        assert.deepEqual(checkpoint.qualityAssessment, reassessment);
        assert.deepEqual(checkpoint.mutation, knowledge.mutation);
        assert.equal(checkpoint.codeHash, testHash);

        const fixtureManifest = path.join(clockOutput, 'neutral_clock_scorecard_manifest.json');
        fs.writeFileSync(fixtureManifest, JSON.stringify({ schema_version: 2, fixtures: [{
            id: 'neutral-clock', tier: knowledge.resolvedTier, source: 'clock_sample.py', target: 'target',
            acceptance: { min_line_coverage: 100, min_mutation_score: 100 }
        }] }));
        const scorecard = () => {
            const scripts = path.resolve(__dirname, '../../python_scripts');
            const script = 'import json,sys;sys.path.insert(0,sys.argv[1]);'
                + 'from fixture_scorecard import build_scorecard;'
                + 'print(json.dumps(build_scorecard(sys.argv[2],manifest_path=sys.argv[3])))';
            const result = spawnSync(python, ['-B', '-c', script, scripts, clockOutput, fixtureManifest], {
                encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            });
            assert.equal(result.status, 0, result.stderr || result.error?.message);
            const card = JSON.parse(result.stdout);
            assert.equal(card.fixture_count, 1);
            return card;
        };
        const card = scorecard();
        assert.deepEqual(card.status_counts, { passed: 1 });
        assert.equal(card.results[0].status, clockTarget.terminalStatus);
        assert.deepEqual(card.results[0].quality_policy, policy);
        assert.deepEqual(card.results[0].quality_assessment, reassessment,
            'Python scorecard must recompute exactly the same assessment from the actual saved run');

        // Read the same report again through BatchJournal. Restore every file
        // in finally, including the batch index that refresh rewrites, so the
        // remaining source-discovery assertions still see the original run.
        const preservedFiles = [
            path.join(clockRun.directory, 'batch_manifest.json'),
            path.join(clockRun.directory, 'batch_summary.md'),
            ...['function_knowledge.json', 'run_manifest.json', 'quality_baseline.json'].map(name => path.join(clockOutput, name))
        ];
        const originalArtifacts = new Map(preservedFiles.map(file => [file, fs.readFileSync(file)]));
        const restoreArtifacts = () => {
            for (const [file, bytes] of originalArtifacts) { fs.writeFileSync(file, bytes); }
        };
        const rereadBatch = () => {
            const reader = new BatchJournal(clockRun.directory, clockRoot, {
                model: 'fixture', buildTimestamp: 'integration-reread', python
            });
            reader.discover(sourceFile, ['target']); reader.start(); reader.begin(0);
            reader.attach(0, clockOutput); reader.refresh(0); reader.finish('completed');
            return JSON.parse(fs.readFileSync(path.join(clockRun.directory, 'batch_manifest.json'), 'utf8'));
        };
        try {
            assert.equal(rereadBatch().allTargetsPassed, true);
            const corruptions: Array<{ name: string; artifact: string; change: (value: any) => void }> = [
                { name: 'mutation universe identity', artifact: 'function_knowledge.json',
                    change: value => { value.mutation.candidateSetId = '0'.repeat(64); } },
                { name: 'policy fixed before execution', artifact: 'run_manifest.json',
                    change: value => { value.qualityPolicy.lineThreshold.numerator = 0; } },
                { name: 'saved assessment counts', artifact: 'function_knowledge.json',
                    change: value => { value.qualityAssessment.counts.lines.executed++; } },
                { name: 'checkpoint assessment', artifact: 'quality_baseline.json',
                    change: value => { value.qualityAssessment.fullyPassed = false; } }
            ];
            for (const corruption of corruptions) {
                restoreArtifacts();
                const value = readClockJson(corruption.artifact);
                corruption.change(value);
                fs.writeFileSync(path.join(clockOutput, corruption.artifact), JSON.stringify(value));
                const rejected = rereadBatch();
                assert.equal(rejected.targets[0].terminalStatus, 'incomplete-report', corruption.name);
                assert.equal(rejected.complete, false, corruption.name);
                assert.equal(rejected.allTargetsPassed, false, corruption.name);
                assert.equal(rejected.finishedTargets, 0, corruption.name);
                assert.notEqual(scorecard().results[0].status, 'passed', `Python must also reject ${corruption.name}`);
            }
        } finally {
            restoreArtifacts();
        }
        assert.deepEqual(scorecard().results[0].quality_assessment, reassessment, 'restoring original evidence restores its verified assessment');
        assert.equal(JSON.parse(fs.readFileSync(path.join(clockRun.directory, 'batch_manifest.json'), 'utf8')).allTargetsPassed, true);

        // When users store output within the source root, earlier generated
        // helpers must not become targets of the next batch.
        const generatedHelper = path.join(clockOutput, 'generated_helper.py');
        fs.writeFileSync(generatedHelper, 'def materialize(value): return list(value)\n');
        assert.ok((await findPythonFilesInDir(root)).includes(generatedHelper));
        assert.ok(!(await findPythonFilesInDir(root, true, [], true)).includes(generatedHelper));
        const ordinary = path.join(root, 'ordinary');
        fs.mkdirSync(ordinary);
        fs.writeFileSync(path.join(ordinary, 'batch_manifest.json'), '{"note":"not a batch record"}');
        const ordinarySource = path.join(ordinary, 'ordinary_source.py');
        fs.writeFileSync(ordinarySource, 'def target(value): return value + 1\n');
        assert.ok((await findPythonFilesInDir(root, true, [], true)).includes(ordinarySource));
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad; utilities.detectMutationEngine = originalEngine;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
