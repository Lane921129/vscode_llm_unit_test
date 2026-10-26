import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture, readOllamaRoleRequest } from './ollamaRequestFixture';
import { BUG_FIXER_QUALIFICATION_PROMPT, REVIEWER_QUALIFICATION_PROMPT } from '../llm/roleQualification';
import { evidenceHash } from '../pipeline/analysisJournal';

// The optional initialization binding deliberately remains unknown to static
// name analysis, so real execution still proves one passing and one failing case.
const seed = 'import unittest\nfrom sample import increment\n'
    + 'if __name__ == "optional_test_setup":\n    MISSING_INPUT = 2\nclass Cases(unittest.TestCase):\n'
    + '    def test_existing(self):\n        self.assertEqual(increment(1), 2)\n';
const candidate = seed
    + '    def test_new(self):\n        self.assertEqual(increment(MISSING_INPUT), 3)\n';
const corrected = candidate.replace('increment(MISSING_INPUT)', 'increment(2)');
const manyCandidate = candidate + [3, 4, 5, 6].map(value =>
    `    def test_new_${value}(self):\n        self.assertEqual(increment(${value}), ${value + 1})\n`).join('');

test('formal full Writer revision preserves an oversized prior-policy envelope and enforces its paired wire cap', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-revision-output-'));
    const source = path.join(directory, 'sample.py');
    const targetSource = 'def increment(value):\n    # REQUIRED_SOURCE_BEGIN\n    # '
        + 'complete source context '.repeat(500) + '\n    # REQUIRED_SOURCE_END\n    return value + 1\n';
    // Caller setup is required Writer evidence; Reviewer does not receive the
    // caller inventory again. Retain complete identical-input sites in a group.
    const completeSource = targetSource + Array.from({ length: 18 }, (_, index) =>
        `\ndef caller_${index}():\n    return increment(1)\n`).join('');
    fs.writeFileSync(source, completeSource);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const built = spawnSync(python, ['-B', path.resolve(__dirname, '../../python_scripts/probe_fixture_builder.py'),
        '--root', directory, '--file', source, '--target', 'increment'], {
        input: JSON.stringify({ cases: [[1], [2]].map(args => ({ args_literals: JSON.stringify(args) })) }),
        encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    assert.equal(built.status, 0, built.stderr);
    fs.writeFileSync(path.join(directory, 'trace-inputs.json'), built.stdout, 'utf8');
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const requests: any[] = [];
    let completion: 'stop' | 'length' = 'stop', reviews = 0, multiFinding = false;
    let currentCandidate = candidate, currentCorrected = corrected;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? 8192
                    : key === 'probeInputFile' ? 'trace-inputs.json' : fallback }),
            openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName: 'neutral-revision-output',
            contextLength: 16384, observedContextTokens: 8192 });
        if (metadata) { return metadata; }
        const wire = JSON.parse(String(options?.body));
        const probe = wire.prompt.includes('A safe runtime already provides increment(value)') ? 'writer'
            : wire.prompt.includes(REVIEWER_QUALIFICATION_PROMPT) ? 'reviewer'
                : wire.prompt.includes(BUG_FIXER_QUALIFICATION_PROMPT) ? 'bug-fixer' : undefined;
        assert.equal(wire.system, ' ');
        const request = probe ? { ...wire, roleInstructions: '', transmittedPrompt: wire.prompt, qualificationProbe: probe }
            : readOllamaRoleRequest(wire);
        requests.push(request);
        assert.ok(request.options.num_ctx >= 8192 && request.options.num_ctx <= 16384);
        let response: string;
        let reason: 'stop' | 'length' = 'stop';
        if (probe === 'writer') {
            response = '```python\nimport unittest\nclass TestProbe(unittest.TestCase):\n'
                + '    def test_increment(self):\n        self.assertEqual(increment(1), 2)\n'
                + '        self.assertEqual(increment(-1), 0)\n```';
        } else if (probe === 'reviewer') {
            assert.deepEqual(wire.format.required, ['findings']);
            response = '{"findings":[]}';
        } else if (probe === 'bug-fixer') {
            response = '```python\ndef test_increment(self):\n    self.assertEqual(increment(1), 2)\n```';
        } else if (request.roleInstructions.includes('dependency_behaviors')) {
            response = JSON.stringify({ test_strategy: {
                approach: 'Call increment with exact controlled inputs and verify its observed result.' } });
        } else if (request.prompt.startsWith('WRITER_REVISION_REQUEST_V2')) {
            if (!/NameError|undefined name/.test(request.prompt)) {
                assert.equal(reviews, 1, 'the seed executes and receives concrete review findings before expansion');
                assert.match(request.prompt, /increment\(2\)/);
                response = '```python\n' + currentCandidate + '\n```';
                request.reviewExpansion = true;
            } else {
                request.failureRevision = true;
                assert.ok(request.options.num_predict === 1536 || request.options.num_predict >= 2560);
                const estimate = estimatePromptTokens(request.transmittedPrompt);
                assert.ok(estimate > 5734, 'the complete formal repair reproduces the former input-budget obstacle');
                assert.ok(estimate <= request.options.num_ctx - request.options.num_predict,
                    'the paired output reserve makes the complete unchanged envelope sendable');
                if (request.options.num_predict === 1536) {
                    if (!multiFinding) { assert.equal(request.options.num_ctx, 8192); }
                    assert.ok(estimate <= request.options.num_ctx - 1536);
                }
                assert.equal(request.prompt.split(currentCandidate).length - 1, 1);
                assert.ok(request.prompt.includes(targetSource.trimEnd()), 'the complete target source survives');
                assert.match(request.prompt, /NameError|undefined name/);
                assert.match(request.prompt, /VERIFIED OBSERVATIONS/);
                assert.doesNotMatch(request.prompt, /WRITER_SEED_V1/);
                response = '```python\n' + currentCorrected + '\n```';
                reason = completion;
            }
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            reviews++;
            if (reviews === 1) {
                assert.match(request.prompt, /self\.assertEqual\(increment\(1\), 2\)/);
                assert.doesNotMatch(request.prompt, /def test_new/);
                response = JSON.stringify({ findings: (multiFinding ? [2, 3, 4, 5, 6] : [2]).map(value => ({
                    category: 'missing-scenario', test_line: 'L7',
                    reason: `This executed case covers increment(1); the separate source-supported increment(${value}) input has no test method.`,
                    action: `Add a separate method asserting self.assertEqual(increment(${value}), ${value + 1}), preserving the executed increment(1) assertion.` })) });
            } else {
                assert.equal(completion, 'stop', 'a length-stopped repair cannot reach a new Reviewer approval');
                response = '{"findings":[]}';
            }
        } else {
            assert.match(request.prompt, /WRITER_SEED_V1/);
            response = '```python\n' + seed + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: reason,
            ...(reason === 'length' ? { eval_count: 1536, eval_duration: 1_000_000_000,
                prompt_eval_duration: 100_000_000, load_duration: 0, total_duration: 1_100_000_000 } : {}) }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-revision-output',
            paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
                reviewer: { state: 'verified', reason: 'fixed fixture' }, bugFixer: { state: 'verified', reason: 'fixed fixture' } } });
        for (const scenario of ['stop', 'length', 'multi-finding'] as const) {
            completion = scenario === 'length' ? 'length' : 'stop';
            multiFinding = scenario === 'multi-finding';
            currentCandidate = multiFinding ? manyCandidate : candidate;
            currentCorrected = currentCandidate.replace('increment(MISSING_INPUT)', 'increment(2)');
            await t.test(scenario, async () => {
                requests.length = 0; reviews = 0;
                const output = path.join(directory, scenario);
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-revision-output',
                    filePath: source, funcName: 'increment', promptStrategy: 'tier1', validationMode: 'full',
                    requireRoleQualification: completion === 'length',
                    maxLoops: 1, timeoutSeconds: 45, mutationEngine: 'builtin', mutpyTimeout: 20, outputPath: output });
                const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
                const events = artifacts.filter(name => path.basename(name) === 'role_events.jsonl')
                    .flatMap(name => fs.readFileSync(path.join(output, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
                const revisions = requests.filter(request => request.failureRevision);
                assert.equal(requests.filter(request => request.reviewExpansion).length, 1,
                    'one review-driven expansion creates the real failed candidate without weakening the initial seed scope');
                assert.equal(revisions.length, completion === 'stop' ? 1 : 2, JSON.stringify({ events: events.filter(event => event.status === 'budget-exceeded'
                    || event.status === 'error' || event.status === 'failed' || event.stage === 'model-runtime').map(event => ({
                        stage: event.stage, status: event.status, category: event.detail?.category,
                        reasonCode: event.detail?.reasonCode, inputBudget: event.detail?.inputBudget,
                        estimatedInputTokens: event.detail?.estimatedInputTokens, contextWindow: event.detail?.contextWindow })), requests: requests.map(request => ({
                    estimate: estimatePromptTokens(request.transmittedPrompt), cap: request.options.num_predict,
                    contextWindow: request.options.num_ctx, qualificationProbe: request.qualificationProbe,
                    revision: request.prompt.startsWith('WRITER_REVISION_REQUEST_V2') })) }));
                const allRevisionAttempts = events.filter(event => event.stage === 'model-request' && event.status === 'requested'
                    && event.detail.role === 'writer-revision');
                const sent = allRevisionAttempts[1];
                assert.ok(sent);
                assert.equal(sent.detail.inputBudget, revisions[0].options.num_ctx - 1536);
                if (!multiFinding) { assert.equal(sent.detail.inputBudget, 6656); }
                assert.equal(sent.detail.reservedOutputTokens, 1536);
                assert.equal(sent.detail.requestOutputTokens, revisions[0].options.num_predict);
                assert.equal(sent.detail.estimatedInputTokens, estimatePromptTokens(revisions[0].transmittedPrompt));
                assert.ok(events.some(event => event.stage === 'validation' && event.status === 'failed'
                    && /test_existing \([^\n)]+\) \.\.\. ok/.test(event.detail.out || '')
                    && /test_new \([^\n)]+\) \.\.\. ERROR/.test(event.detail.out || '')),
                    'real guarded execution supplies a genuinely passing method before the Writer revision');
                if (completion === 'stop') {
                    assert.ok(!events.some(event => event.stage === 'passing-tests' && event.status === 'preservation-rejected'));
                    const savedTests = artifacts.filter(name => /^(?:loop\d+_test|test)\.py$/.test(path.basename(name)))
                        .map(name => fs.readFileSync(path.join(output, name), 'utf8'));
                    assert.ok(savedTests.some(saved => saved.includes(currentCorrected.trimEnd())),
                        'the actually saved corrected suite retains the original passing method verbatim');
                    assert.ok(events.some(event => event.stage === 'reviewer' && event.status === 'approved'),
                        JSON.stringify(events.filter(event => event.stage === 'reviewer' || event.status === 'budget-exceeded')));
                    assert.ok(events.some(event => event.stage === 'mutation' && event.status === 'measured'));
                    if (multiFinding) {
                        const expansion = requests.find(request => request.reviewExpansion);
                        const requested = allRevisionAttempts[0].detail;
                        assert.deepEqual(requested.revisionWorkload, { findingCount: 5, missingScenarioCount: 5 });
                        assert.ok(expansion.options.num_predict > 1536);
                        assert.ok(expansion.options.num_predict <= Math.ceil(expansion.options.num_ctx * .3));
                        assert.equal(requested.requestOutputTokens, expansion.options.num_predict);
                        assert.equal(requested.inputBudget, expansion.options.num_ctx - expansion.options.num_predict);
                        assert.ok(requested.estimatedInputTokens <= requested.inputBudget);
                        assert.deepEqual(sent.detail.revisionWorkload, { findingCount: 1, missingScenarioCount: 0 },
                            'a later NameError cannot inherit the previous candidate review workload');
                        const knowledge = artifacts.filter(name => path.basename(name) === 'function_knowledge.json')
                            .map(name => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8')))[0];
                        const targetBudget = knowledge.targetBudget;
                        assert.ok(targetBudget);
                        assert.ok(allRevisionAttempts.every(event => event.detail.stageDeadlineAt <= targetBudget.deadlineAt));
                        assert.ok(events.some(event => event.stage === 'validation' && event.status === 'failed'
                            && /test_new_6 \([^\n)]+\) \.\.\. ok/.test(event.detail.out || '')));
                    }
                } else {
                    assert.equal(revisions[0].options.num_predict, 1536);
                    assert.ok(revisions[1].options.num_predict >= 2560);
                    assert.ok(revisions[1].options.num_ctx > revisions[0].options.num_ctx);
                    assert.equal(revisions[1].transmittedPrompt, revisions[0].transmittedPrompt,
                        'length recovery preserves the complete prior test, source and execution facts');
                    const probes = requests.filter(request => request.qualificationProbe);
                    assert.deepEqual(probes.map(request => request.qualificationProbe), ['writer', 'reviewer', 'bug-fixer']);
                    assert.ok(probes.every(request => request.options.num_ctx === revisions[1].options.num_ctx));
                    assert.ok(events.some(event => event.stage === 'context-qualification' && event.status === 'completed'),
                        'the enlarged capacity must qualify with executable public role fixtures');
                    const attempts = allRevisionAttempts.slice(1);
                    assert.equal(attempts.length, 2);
                    assert.equal(attempts[0].detail.stageDeadlineAt, attempts[1].detail.stageDeadlineAt);
                    assert.ok(events.some(event => event.stage === 'model-request' && event.status === 'error'
                        && event.detail.role === 'writer-revision' && event.detail.category === 'model-format'));
                    assert.equal(reviews, 1, 'only the earlier seed finding is reviewed; neither length-stopped response receives review');
                    assert.ok(!events.some(event => event.stage === 'reviewer' && event.status === 'approved' || event.stage === 'mutation'));
                    assert.ok(!events.some(event => event.stage === 'scenarios' && event.status === 'observed'
                        && event.detail.codeHash === evidenceHash(corrected.trim())),
                        'even a syntactically complete length-stopped correction is never executed');
                    assert.ok(!events.some(event => event.stage === 'model-request' && event.status === 'completed'
                        && event.detail.role === 'writer-revision' && event.detail.stageDeadlineAt === attempts[0].detail.stageDeadlineAt));
                }
                assert.equal(fs.readFileSync(source, 'utf8'), completeSource, 'the real target is unchanged');
            });
        }
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
