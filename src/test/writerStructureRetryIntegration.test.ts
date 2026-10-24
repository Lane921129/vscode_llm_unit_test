import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLanguage, setLanguage } from '../i18n/core';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { readOllamaRoleRequest } from './ollamaRequestFixture';
import { contextInputBudget, estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { roleRequestBudget } from '../prompts/roleRequestBudget';
import { buildWriterRevisionRequest } from '../roles/roleContracts';
import { buildWriterExpansionPrompt } from '../roles/writerPhases';

const fence = (code: string) => '```python\n' + code + '\n```';
const candidate = (importTarget: boolean) => `import unittest
${importTarget ? 'from sample import _read\n' : ''}class Cases(unittest.TestCase):
    def test_value(self):
        self.assertEqual(_read(2), 3)`;

function readRun(root: string) {
    const entries = fs.readdirSync(root, { recursive: true }).map(String);
    const knowledgeFiles = entries.filter(name => path.basename(name) === 'function_knowledge.json');
    assert.equal(knowledgeFiles.length, 1);
    const directory = path.dirname(path.join(root, knowledgeFiles[0]));
    return {
        directory,
        knowledge: JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8')),
        events: fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n')
            .map(line => JSON.parse(line)) as any[]
    };
}

function assertRepairPrompt(prompt: string, previous: string, finding: string, module = 'sample') {
    assert.match(prompt, /^WRITER_REVISION_REQUEST_V2/);
    assert.equal(prompt.split(previous).length - 1, 1, 'the complete rejected file appears exactly once');
    assert.ok(prompt.includes('=== CURRENT TEST FILE ===\n' + fence(previous)));
    assert.ok(prompt.includes('=== REVIEW OR STRUCTURE FINDINGS ===\n' + finding));
    assert.ok(prompt.includes(`Target import: from ${module} import _read`));
    assert.match(prompt, /never patch the target itself/);
}

test('a short expansion fragment keeps the full long baseline and the original output reserve', () => {
    const baseline = candidate(true) + '\n# ' + 'existing baseline fixture '.repeat(260);
    const fragment = candidate(false);
    assert.ok(estimatePromptTokens(baseline) > 1536);
    assert.ok(estimatePromptTokens(fragment) < 200);
    const evidence = 'Target source: def _read(value): return value + 1\n'
        + 'Setup: from sample import _read\nVerified observation: _read(2) returned 3';
    const request = buildWriterExpansionPrompt(buildWriterRevisionRequest({ code: fragment,
        findings: 'The target import is missing.', moduleName: 'sample', functionName: '_read', evidence }),
    baseline, 'Retain the executed baseline while correcting the target binding.');
    assert.ok(request.includes(fence(fragment)));
    assert.ok(request.includes(fence(baseline)));
    assert.equal(request.split(baseline).length - 1, 1);
    assert.ok(request.includes(evidence));
    const originalInput = contextInputBudget('', 8192);
    const budget = roleRequestBudget({ envType: 'local', mode: 'full', role: 'writer-revision',
        seedPending: false, contextWindow: 8192, inputBudget: originalInput, revisionCurrentCode: undefined });
    assert.equal(budget.inputBudget, originalInput);
    assert.equal(budget.reservedOutputTokens, 2458);
    assert.equal(budget.requestOutputTokens, undefined);
    assert.ok(promptFits('', request, budget.inputBudget));
});

test('formal Writer structure retries retain the rejected file, evidence scope and original request bounds', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-retry-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const utilities = require('../utils/utils'), originalEngine = utilities.detectMutationEngine;
    const policies = require('../pipeline/qualityPolicy'), originalPolicy = policies.createDefaultQualityPolicy;
    const previousLanguage = getLanguage();
    const handlers = new Map<string, (...args: any[]) => any>();
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    utilities.detectMutationEngine = () => null;
    const source = path.join(directory, 'sample.py');
    fs.writeFileSync(source, 'def _read(value):\n    return value + 1\n');
    const bad = candidate(false), good = candidate(true);
    const requests: Array<{ role: string; prompt: string; options: { num_ctx?: number; num_predict?: number } }> = [];
    let respondToWriter = (_prompt: string) => good;
    globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        const request = readOllamaRoleRequest(body);
        const role = request.roleInstructions.includes('dependency_behaviors') ? 'analyst'
            : request.roleInstructions.includes('You are the test Reviewer') ? 'reviewer'
                : request.roleInstructions.includes('Analyst after successful') ? 'quality' : 'writer';
        requests.push({ role, prompt: request.prompt, options: body.options });
        const response = role === 'analyst' ? JSON.stringify({ dependency_behaviors: [],
            test_strategy: { approach: 'Exercise the real selected target and use only verified observations for assertions.' } })
            : role === 'reviewer' ? '{"findings":[]}' : role === 'quality' ? '{"tasks":[]}'
                : fence(respondToWriter(request.prompt));
        return new Response(JSON.stringify({ response }), { status: 200 });
    };
    try {
        setLanguage('en');
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-writer-retry',
            paramSize: '13B', contextLength: 32768, qualificationVersion: QUALIFICATION_VERSION,
            qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8572 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
                reviewer: { state: 'verified', reason: 'fixed fixture' }, bugFixer: { state: 'verified', reason: 'fixed fixture' } } });
        const run = handlers.get('llm-unit-test.runCaptureAndTest')!;
        const params = { envType: 'local', modelName: 'neutral-writer-retry', filePath: source, funcName: '_read',
            validationMode: 'full', promptStrategy: 'tier1', maxLoops: 1, timeoutSeconds: 45,
            mutationEngine: 'builtin', mutpyTimeout: 20 };

        await t.test('single-pass repair sends one complete prior candidate and its exact binding finding', async () => {
            requests.length = 0;
            let writers = 0;
            respondToWriter = prompt => {
                if (++writers === 1) { return bad; }
                assert.equal(writers, 2);
                assertRepairPrompt(prompt, bad, validateUnittestStructure(bad, '_read', 'sample').reason!);
                assert.match(prompt, /Pass execution before expansion; existing output contract\.$/);
                assert.equal((prompt.match(/^WRITER_SEED_V1$/gm) || []).length, 1,
                    'the revision retains one final seed scope rather than inheriting suite expansion');
                return good;
            };
            const outputPath = path.join(directory, 'corrected');
            await run({ ...params, outputPath });
            const result = readRun(outputPath);
            assert.equal(writers, 2, JSON.stringify(result.knowledge.lastFailure));
            assert.ok(result.events.some(event => event.stage === 'writer-seed' && event.status === 'accepted'),
                JSON.stringify(result.knowledge.lastFailure));
            assert.ok(result.events.some(event => event.stage === 'reviewer' && event.status === 'approved'));
            assert.ok(result.events.some(event => event.stage === 'mutation' && event.status === 'measured'));
        });

        await t.test('an unchanged invalid retry remains rejected before execution, review or mutation', async () => {
            requests.length = 0;
            respondToWriter = () => bad;
            const outputPath = path.join(directory, 'unchanged');
            await run({ ...params, outputPath });
            const result = readRun(outputPath);
            const writers = requests.filter(request => request.role === 'writer');
            assert.equal(writers.length, 2, 'the existing two-attempt limit is unchanged');
            assertRepairPrompt(writers[1].prompt, bad, validateUnittestStructure(bad, '_read', 'sample').reason!);
            const rejected = result.events.filter(event => event.stage === 'candidate-artifact' && event.status === 'rejected');
            assert.equal(rejected.length, 2);
            assert.ok(rejected.every(event => event.detail.codeHash === evidenceHash(bad)
                && event.detail.gate === 'unittest-structure' && event.detail.executable === false));
            assert.ok(!result.events.some(event => ['writer-seed', 'execution', 'reviewer', 'mutation'].includes(event.stage)));
            assert.ok(!requests.some(request => request.role === 'reviewer'));
            assert.equal(result.knowledge.terminalStatus, 'failed');
        });

        await t.test('a rejected single-case seed restores all observations for structure revision', async () => {
            requests.length = 0;
            fs.writeFileSync(source, 'def _read(value):\n    return value + 1\n'
                + 'def caller_two():\n    return _read(2)\n'
                + 'def caller_five():\n    return _read(5)\n');
            let writers = 0;
            let seedCaseId: string | undefined;
            respondToWriter = prompt => {
                const observations = JSON.parse(prompt.match(/VERIFIED OBSERVATIONS[^\n]*\n([^\n]+)/)![1]);
                if (++writers === 1) {
                    assert.equal(observations.examples.length, 1, 'initial generation selects a complete single case');
                    seedCaseId = observations.examples[0].case_ids[0];
                    assert.ok(seedCaseId);
                    assert.match(prompt, /SCENARIO SELECTION: exact case IDs/);
                    return bad;
                }
                assert.equal(writers, 2);
                assertRepairPrompt(prompt, bad, validateUnittestStructure(bad, '_read', 'sample').reason!);
                assert.ok(observations.examples.length > 1, 'structure retry retains all original observations');
                assert.ok(observations.examples.some((example: any) => example.case_ids?.includes(seedCaseId)));
                assert.doesNotMatch(prompt, /SCENARIO SELECTION: exact case IDs/);
                return good;
            };
            const outputPath = path.join(directory, 'seed-full-revision');
            await run({ ...params, outputPath });
            const result = readRun(outputPath);
            assert.equal(writers, 2);
            assert.ok(result.events.some(event => event.stage === 'writer-context' && event.status === 'selected'));
            assert.ok(result.events.some(event => event.stage === 'reviewer' && event.status === 'approved'));
            assert.ok(result.events.some(event => event.stage === 'mutation' && event.status === 'measured'));
        });

        await t.test('the complete oversize repair stops before a second transport or Tier fallback', async () => {
            requests.length = 0;
            const large = bad + '\n# ' + 'complete neutral candidate context '.repeat(900) + '\n# COMPLETE_CANDIDATE_TAIL';
            respondToWriter = () => large;
            const outputPath = path.join(directory, 'budget');
            await run({ ...params, promptStrategy: 'tier2', outputPath });
            const result = readRun(outputPath);
            assert.equal(requests.filter(request => request.role === 'writer').length, 1);
            assert.ok(result.events.some(event => event.stage === 'model-request' && event.status === 'budget-exceeded'
                && event.detail.role === 'writer-revision' && event.detail.estimatedInputTokens > event.detail.inputBudget));
            assert.ok(!result.events.some(event => event.stage === 'tier' && event.status === 'fallback'));
            assert.equal(result.knowledge.failureStage, 'prompt-budget');
            const rejected = result.events.find(event => event.stage === 'candidate-artifact' && event.status === 'rejected');
            assert.ok(rejected?.detail.artifactPath);
            assert.equal(fs.readFileSync(path.resolve(result.directory, rejected.detail.artifactPath), 'utf8'), large,
                'the oversize candidate remains complete in its diagnostic artifact');
            assert.ok(!result.events.some(event => ['writer-seed', 'execution', 'reviewer', 'mutation'].includes(event.stage)));
        });

        await t.test('real caller partitions inherit verified imports while keeping each caller observation separate', async () => {
            // The first real test kills both target mutants but leaves one line
            // uncovered. Strict quality asks for expansion, reaching the real
            // Tier 2 caller partitions without bypassing execution or mutation.
            policies.createDefaultQualityPolicy = policies.createStrictQualityPolicy;
            const partitionSource = path.join(directory, 'partition_sample.py');
            fs.writeFileSync(partitionSource, 'def notify(value):\n    return value\n'
                + 'def _read(value):\n    if value:\n        notify(value)\n    else:\n        value = value\n    return value\n'
                + "def caller_alpha():\n    return _read('ALPHA_CALL')\n"
                + "def caller_empty():\n    return _read('')\n");
            const partitionCode = (which: 'alpha' | 'empty', includeImport: boolean) => `import unittest
from unittest.mock import patch
${includeImport ? 'from partition_sample import _read\n' : ''}class Test_read(unittest.TestCase):
    def test_${which}(self):
        with patch('partition_sample.notify') as notify:
            self.assertEqual(_read(${which === 'alpha' ? "'ALPHA_CALL'" : "''"}), ${which === 'alpha' ? "'ALPHA_CALL'" : "''"})
            notify.${which === 'alpha' ? "assert_called_once_with('ALPHA_CALL')" : 'assert_not_called()'}`;
            requests.length = 0;
            let seedSent = false;
            const attempts = new Map<string, number>();
            respondToWriter = prompt => {
                if (!seedSent) { seedSent = true; return partitionCode('alpha', true); }
                const setup = JSON.parse(prompt.match(/SETUP FACTS[^\n]*\n([^\n]+)/)![1]);
                assert.equal(setup.callers.length, 1, 'each partition has only one caller setup');
                const caller = setup.callers[0];
                const which = caller.caller_func === 'caller_alpha' ? 'alpha' : 'empty';
                assert.ok(['caller_alpha', 'caller_empty'].includes(caller.caller_func));
                const observations = JSON.parse(prompt.match(/VERIFIED OBSERVATIONS[^\n]*\n([^\n]+)/)![1]);
                assert.ok(observations.examples.length > 0);
                assert.ok(observations.examples.every((example: any) => JSON.stringify(example.args) === JSON.stringify(caller.args)),
                    'another caller cannot lend an assertion oracle to this partition');
                const attempt = (attempts.get(which) || 0) + 1;
                attempts.set(which, attempt);
                assert.equal(attempt, 1, 'additions inherit the verified target import instead of rewriting it');
                const previous = partitionCode(which, false);
                assert.match(prompt, /WRITER_ADDITION_V1/);
                assert.ok(prompt.includes(partitionCode('alpha', true)), 'the executed baseline remains complete');
                const wire = requests.at(-1)!;
                assert.equal(wire.options.num_ctx, 8572);
                assert.equal(wire.options.num_predict, 1536,
                    'the host-owned single addition returns a new method while the complete executed baseline stays with the host');
                return previous;
            };
            const outputPath = path.join(directory, 'partition');
            await run({ ...params, filePath: partitionSource, promptStrategy: 'tier2', maxLoops: 2, outputPath });
            const result = readRun(outputPath);
            assert.deepEqual([...attempts].sort(), [['alpha', 1], ['empty', 1]], JSON.stringify(result.knowledge.lastFailure));
            assert.ok(result.events.some(event => event.loop === 1 && event.stage === 'mutation'
                && event.status === 'measured' && event.detail.score === 100));
            assert.ok(result.events.some(event => event.loop === 2 && event.stage === 'caller-partition'
                && event.status === 'planned' && event.detail.mode === 'partitioned'));
            const revisions = result.events.filter(event => event.loop === 2 && event.stage === 'model-request'
                && event.status === 'requested' && event.detail.role === 'writer-revision');
            assert.equal(revisions.length, 0, 'valid additions need no import repair');
            assert.equal(result.knowledge.terminalStatus, 'passed', JSON.stringify(result.knowledge.lastFailure));
            assert.ok(result.events.some(event => event.loop === 2 && event.stage === 'reviewer' && event.status === 'approved'));
            assert.ok(result.events.some(event => event.loop === 2 && event.stage === 'mutation'
                && event.status === 'measured' && event.detail.score === 100));
            assert.ok(!result.events.some(event => event.loop === 2 && event.stage === 'caller-merge' && event.status === 'rejected'));
            assert.equal(requests.filter(request => request.role === 'writer').length, 3, JSON.stringify({
                requests: requests.map(request => ({ role: request.role,
                    revision: request.prompt.startsWith('WRITER_REVISION_REQUEST_V2'),
                    seed: request.prompt.includes('WRITER_SEED_V1'),
                    expansion: request.prompt.includes('WRITER_ADDITION_V1') })),
                events: result.events.filter(event => event.loop === 2 && ['model-request', 'passing-tests', 'structure',
                    'writer', 'repair-routing', 'tier', 'validation'].includes(event.stage))
                    .map(event => ({ stage: event.stage, status: event.status, role: event.detail?.role,
                        gate: event.detail?.gate, reasonCode: event.detail?.reasonCode,
                        category: event.detail?.category, from: event.detail?.from, to: event.detail?.to })),
                terminalStatus: result.knowledge.terminalStatus,
                failureStage: result.knowledge.failureStage,
                failureCategory: result.knowledge.failureCategory
            }));
        });
    } finally {
        setLanguage(previousLanguage);
        globalThis.fetch = originalFetch;
        Module._load = originalLoad;
        utilities.detectMutationEngine = originalEngine;
        policies.createDefaultQualityPolicy = originalPolicy;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
