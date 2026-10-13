import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('formal candidate transport preserves literals and routes real loader failure to Writer before review and mutation', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-transport-flow-'));
    const source = path.join(directory, 'sample.py');
    const sourceText = 'def compute(value):\n    return value * 2\n';
    fs.writeFileSync(source, sourceText);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const candidate = 'import unittest\nfrom sample import compute\nclass Cases(unittest.TestCase):\n'
        + '    def test_actual_result(self):\n        self.assertEqual(compute(3), 6)\n'
        + '        self.assertEqual(compute("[PYTHON]"), "[PYTHON][PYTHON]")\n';
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const roles: string[] = [];
    let scenario: 'indented-fence' | 'loader-error' = 'indented-fence';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
                key === 'pythonPath' ? python : key === 'runtimeContextTokens' ? 8192 : fallback }),
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
    globalThis.fetch = async (_url, options) => {
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) {
            roles.push('analyst');
            response = JSON.stringify({ test_strategy: { approach: 'Verify real results using controlled inputs.' } });
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            roles.push('reviewer'); response = '{"findings":[]}';
        } else if (request.prompt.startsWith('WRITER_REVISION_REQUEST_V2')) {
            roles.push('writer-revision');
            assert.equal(scenario, 'loader-error');
            assert.match(request.prompt, /GENERATED_TEST_LOAD_FAILED/);
            assert.match(request.prompt, /ModuleNotFoundError/);
            assert.match(request.prompt, /missing_generated_helper/);
            assert.doesNotMatch(request.prompt, /Target invocation test identity mismatch/);
            response = candidate;
        } else {
            roles.push('writer');
            assert.match(request.prompt, /WRITER_SEED_V1/);
            response = scenario === 'loader-error'
                ? candidate.replace('from sample import compute\n', 'from sample import compute\nimport missing_generated_helper\n')
                : '```python\n' + candidate.split('\n').map(line => '  ' + line).join('\n') + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-candidate-flow',
            paramSize: '13B', contextLength: 16384, contextLengthKnown: true,
            qualificationVersion: QUALIFICATION_VERSION, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 },
            testGenerationReady: true, testGenerationMode: TEST_GEN_MODE_PYTHON,
            roleQualification: { writer: { state: 'verified', reason: 'fixed fixture' },
                reviewer: { state: 'verified', reason: 'fixed fixture' }, bugFixer: { state: 'verified', reason: 'fixed fixture' } } });
        for (scenario of ['indented-fence', 'loader-error'] as const) {
            await t.test(scenario, async () => {
                roles.length = 0;
                const output = path.join(directory, scenario);
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-candidate-flow',
                    filePath: source, funcName: 'compute', promptStrategy: 'tier1', validationMode: 'full', maxLoops: 1,
                    timeoutSeconds: 60, mutationEngine: 'builtin', outputPath: output });
                const artifacts = fs.readdirSync(output, { recursive: true }).map(String);
                const find = (name: string) => path.join(output, artifacts.find(item => path.basename(item) === name)!);
                const events = fs.readFileSync(find('role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const knowledge = JSON.parse(fs.readFileSync(find('function_knowledge.json'), 'utf8'));
                assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
                assert.deepEqual(roles, scenario === 'loader-error' ? ['analyst', 'writer', 'writer-revision', 'reviewer']
                    : ['analyst', 'writer', 'reviewer']);
                const checkpoint = JSON.parse(fs.readFileSync(find('quality_baseline.json'), 'utf8'));
                assert.ok(checkpoint.code.includes(candidate.trimEnd()));
                const approved = events.findIndex(event => event.stage === 'reviewer' && event.status === 'approved');
                const mutated = events.findIndex(event => event.stage === 'mutation' && event.status === 'measured');
                assert.ok(approved >= 0 && mutated > approved);
                assert.equal(events[approved].detail.approvedCodeHash, checkpoint.codeHash);
                if (scenario === 'loader-error') {
                    const failed = events.find(event => event.stage === 'validation' && event.status === 'load-failed');
                    assert.equal(failed.detail.reasonCode, 'generated-test-load-failed');
                    assert.equal(failed.detail.repairRole, 'writer');
                    assert.ok(!events.some(event => event.stage === 'bug-fixer'));
                }
                assert.equal(fs.readFileSync(source, 'utf8'), sourceText);
            });
        }
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
