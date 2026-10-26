import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { testCodeBasis } from './reviewBasisFixture';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture, readOllamaRoleRequest } from './ollamaRequestFixture';
import { runSpawn } from '../utils/processRunner';

test('completed malformed seed replies use a paired wire budget, safe diagnostics and a same-case format retry', async t => {
    const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'writer-format-proof-'));
    const sourceFile = path.join(root, 'sample.py');
    const source = 'def increment(value):\n    # SOURCE_PRIVATE_SENTINEL\n    return value + 1\n';
    fs.writeFileSync(sourceFile, source);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const fixture = await runSpawn(python, ['-B', path.resolve(__dirname, '../../python_scripts/probe_fixture_builder.py'),
        '--root', root, '--file', sourceFile, '--target', 'increment'], {
        input: JSON.stringify({ cases: [{ args_literals: '[1]' }] }), timeout: 5000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(fixture.code, 0, fixture.stderr);
    fs.writeFileSync(path.join(root, 'inputs.json'), fixture.stdout);
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const runner = require('../utils/processRunner'), originalRunSpawn = runner.runSpawn;
    const handlers = new Map<string, (...args: any[]) => any>();
    const requests: any[] = [];
    let scenario = 'repair', writers = 0, reviews = 0;
    const good = '```python\nimport unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
        + '    def test_seed(self):\n        self.assertEqual(increment(1), 2)\n```';
    const malformed = 'A completed explanation before the test\n# SOURCE_PRIVATE_SENTINEL\n'
        + 'import unittest\nclass Cases(unittest.TestCase):\n    def test_seed(self):\n        pass\n';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], getConfiguration: () => ({
            get: (key: string, fallback: unknown) => key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? 8192
                : key === 'probeInputFile' ? 'inputs.json' : fallback }), openTextDocument: async () => ({}) },
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
    runner.runSpawn = async (...args: any[]) => {
        if (scenario === 'tool-failure' && args[1]?.some((value: string) => value.endsWith('scenario_inventory.py'))
            && args[1]?.includes('--diagnostics')) {
            return { code: 2, stdout: '', stderr: 'PRIVATE_TOOL_STDERR_MUST_NOT_LEAK' };
        }
        return originalRunSpawn(...args);
    };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName: 'neutral-format-proof',
            contextLength: 16384, observedContextTokens: 8192 });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        requests.push(request);
        assert.ok(Number.isSafeInteger(request.options.num_predict) && request.options.num_predict > 0,
            'every formal local request enforces its planned output allowance');
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) {
            response = JSON.stringify({ test_strategy: { approach: 'Exercise the supplied observed input and verify its exact result.' } });
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            reviews++;
            response = scenario === 'reviewer-type' && reviews === 1 ? JSON.stringify({ findings: [{
                category: 'assertion-quality', test_line: 'L5', basis: testCodeBasis(5), reason: 'The expected result is not a valid integer value.',
                action: 'Change the expected result to a valid integer value.' }] })
                : scenario === 'review-scope' && reviews === 1 ? JSON.stringify({ findings: [{
                    category: 'typing-style', test_line: 'L4', basis: testCodeBasis(4), reason: 'The test method does not explain its observed input and result.',
                    action: 'Add a docstring to the existing test method describing its observed input and result.' }] })
                : '{"findings":[]}';
        } else {
            writers++;
            if (scenario !== 'review-scope' || writers === 1) { assert.match(request.prompt, /WRITER_SEED_V1/); }
            assert.ok(request.prompt.includes(source.trimEnd()) || scenario === 'length-recovery'
                && request.prompt.includes('SOURCE_PRIVATE_SENTINEL'));
            if (writers === 1) {
                response = ['tool-failure', 'reviewer-type', 'review-scope'].includes(scenario) ? good
                    : scenario === 'length-recovery' ? '```python\nimport unittest\nclass Cases(unittest.TestCase):\n    def test_seed(self):\n```\n'.repeat(20)
                    : malformed;
            }
            else if (scenario === 'review-scope') {
                assert.match(request.prompt, /WRITER_REVIEW_CORRECTION_V1/);
                response = writers === 2 ? good.replace('\n```', '\n    def test_unrelated(self):\n        self.assertEqual(increment(2), 3)\n```')
                    : good.replace('def test_seed(self):\n', 'def test_seed(self):\n        """Verify the observed increment input and result."""\n');
            } else if (scenario === 'length-recovery') {
                assert.match(request.prompt, /WRITER_OUTPUT_FORMAT_REPAIR_V1/); response = good;
            }
            else {
                assert.match(request.prompt, /WRITER_SEED_FORMAT_REPAIR_V1/);
                assert.doesNotMatch(request.prompt, /WRITER_REVISION_REQUEST_V2|A completed explanation before the test/);
                const previous = requests.find(value => value !== request && value.roleInstructions.includes('WRITER_SEED_V1'));
                assert.ok(previous);
                const prefix = request.prompt.slice(0, request.prompt.indexOf('WRITER_SEED_FORMAT_REPAIR_V1')).trimEnd();
                assert.ok(previous.prompt.startsWith(prefix), 'the retry preserves the original complete seed evidence');
                assert.ok(request.prompt.length <= previous.prompt.length + 1400, 'formatting does not add a complete revision context');
                response = scenario === 'both-invalid' ? malformed : good;
            }
        }
        return new Response(JSON.stringify({ response, done: true,
            done_reason: scenario === 'length-recovery' && writers === 1 && !request.roleInstructions.includes('dependency_behaviors') ? 'length' : 'stop',
            privateProviderField: 'PROVIDER_ENVELOPE_MUST_NOT_LEAK' }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        for (const mode of ['repair', 'both-invalid', 'tool-failure', 'reviewer-type', 'review-scope', 'length-recovery']) {
            await t.test(mode, async () => {
                scenario = mode; writers = 0; reviews = 0; requests.length = 0;
                const output = path.join(root, mode);
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-format-proof',
                    filePath: sourceFile, funcName: 'increment', promptStrategy: 'tier1', validationMode: 'full',
                    maxLoops: 1, timeoutSeconds: mode === 'length-recovery' ? 6000 : 45,
                    targetBudget: mode === 'length-recovery' ? { timeoutMs: 6000000 } : undefined,
                    mutationEngine: 'builtin', mutpyTimeout: 20, outputPath: output });
                const files = fs.readdirSync(output, { recursive: true }).map(String);
                const events = files.filter(name => path.basename(name) === 'role_events.jsonl').flatMap(name =>
                    fs.readFileSync(path.join(output, name), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
                const failed = events.filter(event => event.stage === 'model-request' && event.status === 'format-rejected');
                const reports = files.filter(name => path.basename(name) === 'failure_report.md')
                    .map(name => fs.readFileSync(path.join(output, name), 'utf8')).join('\n');
                assert.doesNotMatch(JSON.stringify(events) + reports, /PROVIDER_ENVELOPE_MUST_NOT_LEAK|PRIVATE_TOOL_STDERR_MUST_NOT_LEAK/);
                const requested = events.filter(event => event.stage === 'model-request' && event.status === 'requested');
                assert.ok(requested.every(event => event.detail.reservedOutputTokens === event.detail.requestOutputTokens));
                if (mode === 'tool-failure') {
                    assert.equal(writers, 1, 'a tool failure must not ask Writer to repair its Python');
                    assert.equal(failed.length, 0);
                    assert.ok(events.some(event => event.stage === 'candidate-methods' && event.status === 'tool-unavailable'));
                    assert.match(reports, /inventory tool did not complete/);
                } else if (['reviewer-type', 'review-scope', 'length-recovery'].includes(mode)) {
                    assert.equal(writers, mode === 'reviewer-type' ? 1 : mode === 'review-scope' ? 3 : 2,
                        JSON.stringify(events.filter(event => ['failed', 'error', 'budget-exceeded', 'tool-unavailable', 'invalid-response'].includes(event.status))));
                    assert.equal(failed.length, 0);
                    if (mode === 'reviewer-type') {
                        assert.equal(reviews, 2);
                        assert.ok(events.some(event => event.stage === 'reviewer' && event.status === 'invalid-response'
                            && event.detail.diagnostics.includes('expected-literal-type-contradiction')));
                    }
                    if (mode === 'review-scope') {
                        assert.ok(events.some(event => event.stage === 'writer-review-scope' && event.status === 'rejected'));
                        assert.equal(events.filter(event => event.stage === 'validation' && event.status === 'passed').length, 2,
                            'the expanded candidate must not execute');
                    }
                    if (mode === 'length-recovery') {
                        const retry = events.find(event => event.stage === 'model-request' && event.status === 'output-format-retry');
                        assert.equal(retry?.detail.reasonCode, 'unmeasured-remaining-allowance');
                        assert.ok(retry.detail.availableMs < 6000000);
                    }
                } else {
                    assert.equal(writers, 2, JSON.stringify(events.filter(event =>
                        ['failed', 'error', 'budget-exceeded', 'tool-unavailable'].includes(event.status))));
                    assert.equal(failed.length, mode === 'repair' ? 1 : 2);
                    assert.ok(failed.every(event => event.detail.syntax.kind === 'SyntaxError'));
                    assert.match(reports, /response-python-syntax/);
                    assert.match(reports, /A completed explanation before the test/);
                    assert.doesNotMatch(JSON.stringify(failed), /SOURCE_PRIVATE_SENTINEL/);
                }
                if (['repair', 'reviewer-type', 'review-scope', 'length-recovery'].includes(mode)) {
                    assert.ok(events.some(event => event.stage === 'reviewer' && event.status === 'approved'));
                    assert.ok(events.some(event => event.stage === 'mutation' && event.status === 'measured'));
                } else {
                    assert.ok(!events.some(event => event.stage === 'reviewer' && event.status === 'approved' || event.stage === 'mutation'));
                }
                assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
            });
        }
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad; runner.runSpawn = originalRunSpawn;
        const resolved = fs.realpathSync(root);
        assert.equal(path.dirname(resolved), temp); assert.ok(path.basename(resolved).startsWith('writer-format-proof-'));
        assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false); fs.rmSync(resolved, { recursive: true });
    }
});
