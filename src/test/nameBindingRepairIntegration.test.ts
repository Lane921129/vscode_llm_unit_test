import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture, readOllamaRoleRequest } from './ollamaRequestFixture';

const hash = (code: string) => createHash('sha256').update(code).digest('hex');
const seed = 'import unittest\nfrom sample import target\n# fixture bytes remain owned by the host\n'
    + 'class Cases(unittest.TestCase):\n    def test_seed(self):\n'
    + '        token = make_token()\n        self.assertIsNotNone(token)\n        self.assertTrue(target())\n';
const fixed = 'class Cases:\n    def test_seed(self):\n        import sample\n'
    + '        self.assertIsNotNone(sample.TOKEN)\n        self.assertTrue(target())\n';
const effectSource = 'class Sink:\n    def publish(self, *, resource):\n        return resource\n'
    + 'def build_resource():\n    return object()\nRESOURCE = build_resource()\nSINK = Sink()\n'
    + 'def target():\n    SINK.publish(resource=RESOURCE)\n';
const effectSeed = seed.slice(0, seed.indexOf('    def test_seed')) + '    def test_seed(self):\n'
    + '        resource = build_resource()\n        SINK.publish(resource=resource)\n        self.assertIsNone(target())\n';
const effectFixed = 'class Cases:\n    def test_seed(self):\n        import sample\n        from unittest.mock import patch\n'
    + '        with patch.object(sample.SINK, "publish") as publish:\n'
    + '            self.assertIsNone(target())\n            publish.assert_called_once_with(resource=sample.RESOURCE)\n';

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
    let activeSeed = seed;
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
            assert.ok(request.prompt.includes(activeSeed), 'repair retains the rejected candidate, never an empty or retained baseline');
            const plan = JSON.parse(request.prompt.match(/WRITER_METHOD_EDIT_V1\n([^\n]+)/)![1]);
            assert.equal(plan.baselineHash, hash(activeSeed.trim()));
            assert.deepEqual(plan.methodIds, ['Cases.test_seed']);
            assert.doesNotMatch(request.roleInstructions, /complete unittest|WRITER_SEED_V1|Import unittest/);
            assert.match(request.roleInstructions, /A test-local assignment does not rebind a module global/);
            if (scenario === 'side-effect') {
                assert.match(request.prompt, /Call setup SINK\.publish: resource: sample\.RESOURCE/);
                assert.match(request.prompt, /An assertIsNone alone does not verify those effects/);
            }
            response = '```python\n' + (scenario === 'scope' ? seed.replace('token = make_token()', 'token = None')
                : scenario === 'unchanged' ? 'class Cases:\n' + seed.slice(seed.indexOf('    def test_seed')) : fixed) + '\n```';
            if (scenario === 'syntax') { response = '```python\nclass Cases:\n    def test_seed(self):\n        token = (\n```'; }
            if (scenario === 'ambiguous') { response += '\nAnother option:\n```python\n' + fixed + '\n```'; }
            if (scenario === 'side-effect') { response = '```python\n' + effectFixed + '\n```'; }
        } else {
            writers++;
            assert.equal(writers, 1, 'scoped rejection cannot fall back to a complete-file Writer');
            response = '```python\n' + activeSeed + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        for (const mode of ['full', 'execution']) {
            for (const variant of ['success', 'scope', 'unchanged', 'syntax', 'ambiguous', ...(mode === 'execution' ? ['side-effect'] : [])]) {
                await t.test(`${mode}/${variant}`, async () => {
                    scenario = variant; writers = 0; edits = 0; reviews = 0; reviewCode = ''; messages.length = 0;
                    activeSeed = variant === 'side-effect' ? effectSeed : seed;
                    const activeSource = variant === 'side-effect' ? effectSource : source;
                    fs.writeFileSync(file, activeSource);
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
                    if (variant === 'success' || variant === 'side-effect') {
                        assert.ok(events.some(event => event.stage === 'writer-method-edit' && event.status === 'applied'));
                        const baseline = JSON.parse(fs.readFileSync(path.join(directory,
                            mode === 'full' ? 'executable_baseline.json' : 'execution_baseline.json'), 'utf8'));
                        const testFiles = files.filter(name => path.basename(name) === baseline.testFile);
                        assert.equal(testFiles.length, 1);
                        const code = fs.readFileSync(path.join(output, testFiles[0]), 'utf8');
                        assert.equal(code.slice(0, code.indexOf('    def test_seed')), activeSeed.slice(0, activeSeed.indexOf('    def test_seed')));
                        assert.match(code, variant === 'side-effect' ? /publish.assert_called_once_with\(resource=sample.RESOURCE\)/ : /self.assertTrue\(target\(\)\)/);
                        assert.equal(hash(code), baseline.codeHash || baseline.testHash);
                        if (mode === 'full') {
                            assert.equal(reviews, 1, JSON.stringify(knowledge.lastFailure));
                            assert.equal(hash(reviewCode), hash(code), 'the Reviewer must approve the composed and executed candidate');
                            assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify(knowledge.lastFailure));
                        } else { assert.equal(knowledge.terminalStatus, 'execution-passed', JSON.stringify(knowledge.lastFailure)); }
                        if (variant === 'side-effect') {
                            // A missing side effect must fail even though both implementations return None.
                            fs.writeFileSync(file, activeSource.replace('    SINK.publish(resource=RESOURCE)', '    pass'));
                            try {
                                const testPath = path.join(output, testFiles[0]);
                                const mutated = spawnSync(python, ['-B', '-m', 'unittest', path.basename(testPath, '.py')], {
                                    cwd: path.dirname(testPath), encoding: 'utf8', timeout: 10000,
                                    env: { ...process.env, PYTHONPATH: root, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
                                assert.equal(mutated.status, 1, mutated.stderr);
                                assert.match(mutated.stderr, /Expected 'publish' to be called once/);
                            } finally { fs.writeFileSync(file, activeSource); }
                        }
                    } else {
                        assert.equal(reviews, 0);
                        assert.equal(knowledge.terminalStatus, 'failed');
                        assert.equal(fs.existsSync(path.join(directory, 'executable_baseline.json')), false);
                        assert.ok(events.some(event => event.stage === 'writer-method-edit' && event.status === 'rejected'));
                        if (variant === 'syntax' || variant === 'ambiguous') {
                            const diagnostic = events.find(event => event.stage === 'model-request' && event.status === 'format-rejected');
                            assert.ok(diagnostic, JSON.stringify(events.slice(-5)));
                            assert.equal(diagnostic.detail.outputScope, 'method-edit');
                            assert.equal(diagnostic.detail.baselineHash, planned.detail.baselineHash);
                            assert.equal(diagnostic.detail.planHash, planned.detail.planHash);
                            assert.equal(diagnostic.detail.syntax.kind, 'SyntaxError');
                            assert.equal(diagnostic.detail.syntax.line, variant === 'syntax' ? 3 : 1);
                            assert.equal(diagnostic.detail.previewScope, 'extracted-python');
                            const preview = diagnostic.detail.responsePreview;
                            assert.equal(preview.executable, false);
                            assert.equal(preview.complete, false);
                            assert.ok(preview.samples.length <= 6);
                            assert.ok(preview.samples.reduce((sum: number, sample: any) => sum + sample.text.length, 0) < preview.responseCharacters);
                            const report = fs.readFileSync(path.join(directory, 'workflow_report.md'), 'utf8');
                            assert.match(report, /response-python-syntax/);
                            assert.match(report, /Extracted Python syntax/);
                        }
                    }
                    assert.equal(fs.readFileSync(file, 'utf8'), activeSource);
                });
            }
        }
    } finally {
        Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
