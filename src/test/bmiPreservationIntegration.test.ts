import { ollamaRuntimeMetadataFixture, readOllamaRoleRequest } from './ollamaRequestFixture';
import * as assert from 'node:assert/strict';
import { testCodeBasis } from './reviewBasisFixture';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

test('real BMI workflow preserves exact passed assertions during review repair and across Tier fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmi-preservation-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const targetFile = path.join(root, 'bmi.py');
    const source = `def calculate_bmi(weight, height):
    height_m = height / 100
    value = round(weight / (height_m ** 2), 2)
    if value < 18.5:
        status = 'underweight'
    elif value < 24:
        status = 'normal'
    elif value < 27:
        status = 'overweight'
    else:
        status = 'obese'
    return value, status
`;
    const seed = `import unittest
from bmi import calculate_bmi
class Cases(unittest.TestCase):
    def test_normal(self):
        value, status = calculate_bmi(70, 170)
        self.assertAlmostEqual(value, 24.22, places=2)
        self.assertEqual(status, 'overweight')
`;
    const exceptionMethod = `    def test_zero_height(self):
        with self.assertRaises(ZeroDivisionError):
            calculate_bmi(70, 0)
`;
    const complete = seed + exceptionMethod;
    const wrongException = seed + `    def test_zero_height(self):
        self.assertEqual(calculate_bmi(70, 0), 0)
`;
    const weakened = complete.replace("self.assertEqual(status, 'overweight')", "self.assertGreaterEqual(status, 'overweight')");
    const dropped = 'import unittest\nfrom bmi import calculate_bmi\nclass Cases(unittest.TestCase):\n' + exceptionMethod;
    fs.writeFileSync(targetFile, source);
    // Input-only fixtures give the formal seed the exact executed source call.
    // No expected result or exception is supplied to the Trace builder.
    const built = spawnSync(python, ['-B', path.resolve(__dirname, '../../python_scripts/probe_fixture_builder.py'),
        '--root', root, '--file', targetFile, '--target', 'calculate_bmi'], {
        input: JSON.stringify({ cases: [[70, 170], [70, 0]].map(args => ({ args_literals: JSON.stringify(args) })) }),
        encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    assert.equal(built.status, 0, built.stderr);
    fs.writeFileSync(path.join(root, 'trace-inputs.json'), built.stdout, 'utf8');
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let scenario: 'weakened' | 'dropped' = 'weakened';
    let writers = 0, revisions = 0, reviews = 0, requests = 0, fixes = 0;
    const writerPrompts: string[] = [], reviewPrompts: string[] = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : key === 'probeInputFile' ? 'trace-inputs.json' : fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName: 'fixture', metadataAvailable: false });
        if (metadata) { return metadata; }
        requests++;
        assert.ok(requests <= 8, 'a rejected rewrite must not start unbounded model retries');
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        assert.equal(request.options.num_ctx, 8572, 'the fixture runtime allocation, not the model maximum, owns the input budget');
        let response: string;
        if (request.roleInstructions?.includes('You are the test Reviewer')) {
            reviews++; reviewPrompts.push(request.prompt);
            assert.doesNotMatch(request.prompt, /self\.assertGreaterEqual\(status/,
                'the weakened candidate must be rejected before review');
            response = JSON.stringify({ findings: reviews === 1 ? [{ category: 'missing-scenario', test_line: 'L5', basis: testCodeBasis(5),
                reason: 'This case uses the observed positive-height input (70, 170); the separate controlled Trace input (70, 0) raised ZeroDivisionError and is not tested.',
                action: 'Add a separate test method with assertRaises(ZeroDivisionError) around calculate_bmi(70, 0), preserving this passing normal-input case and its exact assertions.' }] : [] });
        } else if (request.roleInstructions?.includes('dependency_behaviors')) {
            response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the real selected target with controlled inputs and use only verified observations for assertions."}}';
        } else if (request.roleInstructions?.includes('Python unittest Bug Fixer')) {
            assert.equal(scenario, 'dropped');
            fixes++;
            // A real execution failure exhausts the ordinary Tier 2 repair
            // allowance; Reviewer unavailability never triggers a downgrade.
            response = '```python\ndef test_zero_height(self):\n    self.assertIsNone(calculate_bmi(70, 0))\n```';
        } else if (request.roleInstructions?.includes('Analyst after successful')) {
            assert.fail('one measurement round must not request an unused quality plan');
        } else if (request.roleInstructions?.includes('Revise the current tests')) {
            revisions++; writerPrompts.push(request.prompt);
            const code = scenario === 'weakened' ? revisions === 1 ? weakened : complete
                : revisions === 1 ? wrongException : complete;
            response = '```python\n' + code + '\n```';
        } else {
            writers++; writerPrompts.push(request.prompt);
            if (writers > 1) {
                assert.equal(scenario, 'dropped');
                assert.match(request.prompt, /def test_normal\(self\)/,
                    'Tier fallback must receive the complete retained executable method');
                assert.match(request.prompt, /self\.assertEqual\(status, 'overweight'\)/);
            }
            response = '```python\n' + (writers === 1 ? seed : dropped) + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        // Fixed-response transport declares a separate runtime setting: 8572
        // keeps this preservation fixture's original 6000-token input budget.
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'fixture', paramSize: '13B', contextLength: 32768,
            effectiveRuntimeContextTokens: 8572, runtimeContextSource: 'ollama-num-ctx' });
        for (const selected of ['weakened', 'dropped'] as const) {
            scenario = selected; writers = 0; revisions = 0; reviews = 0; requests = 0; fixes = 0;
            writerPrompts.length = 0; reviewPrompts.length = 0;
            const output = path.join(root, 'results-' + scenario);
            await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'fixture', filePath: targetFile,
                funcName: 'calculate_bmi', outputPath: output, promptStrategy: 'tier2', maxLoops: 1,
                // Exercise the full 76-candidate set within the original stage
                // deadline; preservation correctness does not depend on two workers.
                timeoutSeconds: 60, mutpyTimeout: 30, mutationWorkers: 4, mutationEngine: 'builtin', validationMode: 'full' });
            const knowledgeFile = fs.readdirSync(output, { recursive: true }).map(String).find(name => path.basename(name) === 'function_knowledge.json');
            assert.ok(knowledgeFile, 'journal must exist');
            const runRoot = path.dirname(path.join(output, knowledgeFile));
            const knowledge = JSON.parse(fs.readFileSync(path.join(runRoot, 'function_knowledge.json'), 'utf8'));
            const events = fs.readFileSync(path.join(runRoot, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            const diagnostic = JSON.stringify({ scenario, writers, revisions, reviews, requests, fixes, failure: knowledge.lastFailure,
                preservation: events.filter(event => event.stage === 'passing-tests').map(event => event.detail) });
            assert.equal(revisions, scenario === 'weakened' ? 2 : 1, diagnostic);
            assert.equal(reviews, 2, diagnostic);
            assert.equal(writers, scenario === 'weakened' ? 1 : 2, diagnostic);
            assert.equal(fixes, scenario === 'weakened' ? 0 : 1, diagnostic);
            const rejected = events.filter(event => event.stage === 'passing-tests' && event.status === 'preservation-rejected');
            assert.equal(rejected.length, 0, diagnostic);
            const scopeRejected = events.filter(event => event.stage === 'writer-review-addition' && event.status === 'rejected');
            assert.equal(scopeRejected.length, scenario === 'weakened' ? 1 : 0, diagnostic);
            assert.ok(scopeRejected.every(event => event.detail.reasonCode === 'existing-test-method-changed'),
                'AST addition scope rejects an edit to the retained assertion before any candidate execution');
            if (scenario === 'dropped') {
                const merged = events.filter(event => event.stage === 'writer-addition' && event.status === 'merged');
                assert.equal(merged.length, 1, diagnostic);
                assert.equal(merged[0].detail.baselineCodeHash, evidenceHash(seed.trim()),
                    'the fallback fragment omits the old case, but the host still merges against its immutable executed seed');
                assert.equal(merged[0].detail.addedMethodsCount, 1);
            }
            const executedHashes = events.filter(event => event.stage === 'scenarios' && event.status === 'observed')
                .map(event => event.detail.codeHash);
            assert.equal(executedHashes.length, scenario === 'weakened' ? 2 : 4, diagnostic);
            assert.equal(new Set(executedHashes).size, executedHashes.length);
            assert.ok(!executedHashes.includes(evidenceHash(weakened.trim())));
            assert.ok(!executedHashes.includes(evidenceHash(dropped.trim())));
            assert.equal(events.filter(event => event.stage === 'mutation' && event.status === 'measured').length, 1, diagnostic);
            assert.equal(knowledge.reviewStatus, 'completed', diagnostic);
            assert.equal(knowledge.mutation.counts.executed, knowledge.mutation.counts.selected);
            assert.ok(knowledge.mutation.counts.executed > 0, 'real Python mutation engine must execute candidates');
            const checkpoint = JSON.parse(fs.readFileSync(path.join(runRoot, 'executable_baseline.json'), 'utf8'));
            const final = fs.readFileSync(path.join(runRoot, checkpoint.testFile), 'utf8');
            assert.equal(final.trim(), complete.trim());
            assert.equal(knowledge.reviewApproval.testHash, evidenceHash(final));
            assert.equal(knowledge.mutation.testHash, evidenceHash(final));
            assert.ok(reviewPrompts.every(prompt => /self\.assertEqual\(status, 'overweight'\)/.test(prompt)),
                'Reviewer must never see a candidate with the retained exact assertion missing');
            assert.equal(knowledge.tierHistory.transitions.length, scenario === 'weakened' ? 0 : 1);
            if (scenario === 'dropped') {
                assert.equal(knowledge.tierHistory.transitions[0].from, 2);
                assert.equal(knowledge.tierHistory.transitions[0].to, 1);
            }
            assert.equal(fs.readFileSync(targetFile, 'utf8'), source);
        }
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
