import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture, readOllamaRoleRequest } from './ollamaRequestFixture';

const hash = (code: string) => createHash('sha256').update(code).digest('hex');
const seed = 'import unittest\nfrom sample import target\n# fixture bytes remain owned by the host\n'
    + 'class Cases(unittest.TestCase):\n    def test_seed(self):\n'
    + '        token = make_token()\n        self.assertIsNotNone(token)\n        self.assertTrue(target())\n';
const fixed = 'class Cases:\n    def test_seed(self):\n        import sample\n'
    + '        self.assertIsNotNone(sample.TOKEN)\n        self.assertTrue(target())\n';

test('full and execution repair the current Checker candidate locally; rejected edits never trigger a whole-file request', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-flow-'));
    const file = path.join(root, 'sample.py');
    const source = 'def make_token():\n    return object()\nTOKEN = make_token()\n'
        + 'def target():\n    return TOKEN is not None\n';
    fs.writeFileSync(file, source);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const handlers = new Map<string, (...args: any[]) => any>();
    const messages: any[] = [];
    let scenario = 'success', writers = 0, edits = 0, reviews = 0;
    let reviewCode = '';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { messages.push(message); return true; } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python
                : key === 'language' ? 'en' : fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName: 'neutral-fixture', contextLength: 65536 });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) {
            response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the real target with source-supported inputs and verify its returned boolean."}}';
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            reviews++;
            assert.match(request.prompt, /ISOLATED_EXECUTION_PASSED/);
            const block = request.prompt.match(/<TEST_FILE>\n([\s\S]*?)\n<\/TEST_FILE>/);
            assert.ok(block);
            reviewCode = block[1].split('\n').map((line: string) => line.replace(/^\[L\d+\] /, '')).join('\n');
            assert.match(reviewCode, /import sample/);
            assert.doesNotMatch(reviewCode, /token = make_token\(\)/);
            response = '{"findings":[]}';
        } else if (request.roleInstructions.includes('performing WRITER_METHOD_EDIT_V1')) {
            edits++;
            assert.equal(writers, 1);
            assert.match(request.prompt, /CURRENT TEST FILE \(read-only baseline\):\n```python\n/);
            assert.ok(request.prompt.includes(seed), 'repair retains the rejected candidate, never an empty or retained baseline');
            const plan = JSON.parse(request.prompt.match(/WRITER_METHOD_EDIT_V1\n([^\n]+)/)![1]);
            assert.equal(plan.baselineHash, hash(seed.trim()));
            assert.deepEqual(plan.methodIds, ['Cases.test_seed']);
            assert.doesNotMatch(request.roleInstructions, /complete unittest|WRITER_SEED_V1|Import unittest/);
            response = '```python\n' + (scenario === 'scope' ? seed.replace('token = make_token()', 'token = None')
                : scenario === 'unchanged' ? 'class Cases:\n' + seed.slice(seed.indexOf('    def test_seed')) : fixed) + '\n```';
        } else {
            writers++;
            assert.equal(writers, 1, 'scoped rejection cannot fall back to a complete-file Writer');
            response = '```python\n' + seed + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        for (const mode of ['full', 'execution']) {
            for (const variant of ['success', 'scope', 'unchanged']) {
                await t.test(`${mode}/${variant}`, async () => {
                    scenario = variant; writers = 0; edits = 0; reviews = 0; reviewCode = ''; messages.length = 0;
                    const output = path.join(root, `${mode}-${variant}`);
                    await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture',
                        maxLoops: 1, timeoutSeconds: 60, targetTimeoutSeconds: 300, promptStrategy: 'tier1',
                        requireRoleQualification: false, validationMode: mode, mutationEngine: 'builtin',
                        filePath: file, funcName: 'target', outputPath: output });
                    const files = fs.readdirSync(output, { recursive: true }).map(String);
                    const knowledgePath = files.find(name => path.basename(name) === 'function_knowledge.json');
                    assert.ok(knowledgePath, JSON.stringify(messages));
                    const directory = path.dirname(path.join(output, knowledgePath));
                    const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
                    const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                    assert.equal(writers, 1, JSON.stringify(knowledge.lastFailure));
                    assert.equal(edits, 1, JSON.stringify(knowledge.lastFailure));
                    const planned = events.find(event => event.stage === 'writer-method-edit' && event.status === 'planned');
                    assert.ok(planned, JSON.stringify(events.slice(-4)));
                    if (variant === 'success') {
                        assert.ok(events.some(event => event.stage === 'writer-method-edit' && event.status === 'applied'));
                        const baseline = JSON.parse(fs.readFileSync(path.join(directory,
                            mode === 'full' ? 'executable_baseline.json' : 'execution_baseline.json'), 'utf8'));
                        const testFiles = files.filter(name => path.basename(name) === baseline.testFile);
                        assert.equal(testFiles.length, 1);
                        const code = fs.readFileSync(path.join(output, testFiles[0]), 'utf8');
                        assert.equal(code.slice(0, code.indexOf('    def test_seed')), seed.slice(0, seed.indexOf('    def test_seed')));
                        assert.match(code, /self.assertTrue\(target\(\)\)/);
                        assert.equal(hash(code), baseline.codeHash || baseline.testHash);
                        if (mode === 'full') {
                            assert.equal(reviews, 1, JSON.stringify(knowledge.lastFailure));
                            assert.equal(hash(reviewCode), hash(code), 'the Reviewer must approve the composed and executed candidate');
                            assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
                        } else { assert.equal(knowledge.terminalStatus, 'execution-passed', JSON.stringify(knowledge.lastFailure)); }
                    } else {
                        assert.equal(reviews, 0);
                        assert.equal(knowledge.terminalStatus, 'failed');
                        assert.equal(fs.existsSync(path.join(directory, 'executable_baseline.json')), false);
                        assert.ok(events.some(event => event.stage === 'writer-method-edit' && event.status === 'rejected'));
                    }
                    assert.equal(fs.readFileSync(file, 'utf8'), source);
                });
            }
        }
    } finally {
        Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
