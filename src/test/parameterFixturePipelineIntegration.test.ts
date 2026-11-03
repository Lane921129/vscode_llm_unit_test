import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

test('a measured object gap reaches fixture observation, AI addition, real re-execution, review and mutation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parameter-fixture-pipeline-'));
    const source = 'def choose(event: object):\n    try:\n        return event.data\n    except Exception:\n        return None\n';
    const sourceFile = path.join(root, 'sample.py');
    fs.writeFileSync(sourceFile, source);
    const output = path.join(root, 'results');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('node:module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>(), state = new Map<string, unknown>();
    let writers = 0, reviewers = 0, fixers = 0;
    const seed = 'import unittest\nimport types\nfrom sample import choose\nclass Cases(unittest.TestCase):\n'
        + '    def test_seed(self):\n        self.assertEqual(choose(types.SimpleNamespace(data="value")), "value")\n';
    const vscode = { ExtensionMode: { Test: 3, Development: 2 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python
                : key === 'runtimeContextTokens' ? 16384 : fallback }), openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => undefined, showTextDocument: async () => undefined },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } } };
    const response = (value: string) => Response.json({ response: value, done: true, done_reason: 'stop' });
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/api/show')) { return Response.json({ details: { parameter_size: '3B' },
            model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } }); }
        if (String(url).endsWith('/api/ps')) { return Response.json({ models: [] }); }
        const wire = JSON.parse(String(options?.body)), request = readOllamaRoleRequest(wire);
        if (request.roleInstructions.includes('dependency_behaviors')) {
            return response(JSON.stringify({ dependency_behaviors: [], test_strategy: { approach: 'Exercise the object attribute and handled read exception with explicit same-test fixtures.' } }));
        }
        if (request.roleInstructions.includes('You are the test Reviewer')) {
            assert.match(request.prompt, /ISOLATED_EXECUTION_PASSED/);
            reviewers++;
            return response('{"findings":[]}');
        }
        if (wire.format?.properties?.replacement || request.roleInstructions.includes('Python unittest Bug Fixer')) {
            fixers++;
            assert.match(request.prompt, /BUG_FIX_REQUEST_V5/);
            return response(JSON.stringify({ method: 'test_seed', imports: [],
                replacement: 'def test_seed(self):\n    self.assertEqual(choose(types.SimpleNamespace(data="value")), "value")\n' }));
        }
        if (wire.format?.properties?.tasks) { return response('{"tasks":[]}'); }
        writers++;
        if (writers === 1) { return response(seed.replace(', "value")', ', "wrong")')); }
        assert.match(request.prompt, /PARAMETER_FIXTURE_OBSERVATIONS_V1/);
        assert.match(request.prompt, /"operation":"raise"/);
        assert.match(request.prompt, /"type":"none"/);
        assert.ok(request.prompt.includes(source), 'complete target source is still supplied');
        const baselineFile = fs.readdirSync(output, { recursive: true }).map(String)
            .find(file => /loop[\\/]1[\\/]loop1_test\.py$/.test(file))!;
        const executedBaseline = fs.readFileSync(path.join(output, baselineFile), 'utf8').trim();
        assert.ok(request.prompt.includes(executedBaseline), 'the actual fixed and executed baseline stays whole');
        assert.match(request.roleInstructions, /^WRITER_ADDITION_V1 OUTPUT MODE/);
        assert.doesNotMatch(request.roleInstructions, /comprehensive|all-survivor|WRITER_SEED_V1/);
        assert.equal(wire.options.num_predict, 1536, 'the real addition wire has the planned output cap');
        assert.match(request.prompt, /PARAMETER_FIXTURE_REPLAY_TASK_V1/);
        assert.ok(request.prompt.lastIndexOf('PARAMETER_FIXTURE_REPLAY_TASK_V1')
            < request.prompt.lastIndexOf('WRITER_ADDITION_METHOD_V1'));
        if (writers === 2) {
            // A getter object stored as data does not move its descriptor onto
            // the event receiver, exactly as the real-model failure demonstrated.
            return response('import unittest\nimport types\nfrom sample import choose\nclass Cases(unittest.TestCase):\n'
                + '    def test_wrong_control(self):\n        class WrongOwner:\n            @property\n'
                + '            def data(self):\n                raise Exception()\n'
                + '        self.assertIsNone(choose(types.SimpleNamespace(data=WrongOwner())))\n');
        }
        assert.match(request.prompt, /named attribute must raise.*when READ/);
        assert.match(request.prompt, /WRITER_ADDITION_REVISION_V1/);
        return response('import unittest\nfrom sample import choose\nclass Cases(unittest.TestCase):\n'
            + '    def test_read_exception(self):\n        class BrokenEvent:\n            @property\n'
            + '            def data(self):\n                raise Exception()\n        self.assertIsNone(choose(BrokenEvent()))\n');
    };
    try {
        delete require.cache[require.resolve('../orchestrator')];
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
            secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-object-fixture',
            paramSize: '3B', contextLength: 32768, contextLengthKnown: true });
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-object-fixture',
            filePath: sourceFile, funcName: 'choose', promptStrategy: 'full', validationMode: 'full',
            maxLoops: 2, timeoutSeconds: 30, mutationEngine: 'builtin', outputPath: output, mutpyTimeout: 60 });
        const files = fs.readdirSync(output, { recursive: true }).map(String);
        const journal = files.find(file => path.basename(file) === 'function_knowledge.json')!;
        const knowledge = JSON.parse(fs.readFileSync(path.join(output, journal), 'utf8'));
        const eventsFile = files.find(file => path.basename(file) === 'role_events.jsonl')!;
        const events = fs.readFileSync(path.join(output, eventsFile), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(writers, 3, JSON.stringify(knowledge.lastFailure));
        assert.equal(reviewers, 2, JSON.stringify(knowledge.lastFailure));
        assert.equal(fixers, 1, 'the initial real failure creates a separately repaired executable baseline');
        assert.ok(events.some(e => e.stage === 'candidate-methods' && e.status === 'inventoried'
            && e.detail.role === 'executable-baseline'), 'the new baseline hash gets its own AST inventory before expansion');
        assert.ok(events.some(e => e.stage === 'parameter-fixture-experiment' && e.status === 'observed'));
        assert.ok(events.some(e => e.stage === 'parameter-fixture-replay' && e.status === 'contradicted'));
        assert.ok(events.some(e => e.stage === 'parameter-fixture-replay' && e.status === 'matched'),
            'only the property on the actual receiver matches and still needs real execution, review and mutation');
        const addition = events.find(e => e.stage === 'model-request' && e.status === 'requested'
            && e.detail.writerOutputScope === 'single-test-addition');
        assert.equal(addition?.detail.requestOutputTokens, 1536);
        assert.equal(addition?.detail.capacity.requestOutputTokens, addition?.detail.requestOutputTokens);
        assert.equal(addition?.detail.inputBudget + addition?.detail.reservedOutputTokens, addition?.detail.contextWindow);
        assert.equal(events.filter(e => e.stage === 'mutation' && e.status === 'measured').length, 2);
        assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
        assert.equal(knowledge.qualityAssessment.policyStatus, 'met');
        const candidate = files.find(file => /loop[\\/]2[\\/]loop2_test\.py$/.test(file))!;
        const accepted = fs.readFileSync(path.join(output, candidate), 'utf8');
        assert.match(accepted, /test_seed/);
        assert.match(accepted, /test_read_exception/);
        assert.doesNotMatch(accepted, /test_wrong_control/);
        assert.equal(fs.readFileSync(sourceFile, 'utf8'), source);
    } finally {
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
