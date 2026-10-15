import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUALIFICATION_VERSION, TEST_GEN_MODE_PYTHON } from '../llm/modelQualification';
import { evidenceHash } from '../pipeline/analysisJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { estimatePromptTokens } from '../prompts/promptBudget';
import { ollamaRuntimeMetadataFixture, readObservedSeedCaseForModelFixture, readOllamaRoleRequest } from './ollamaRequestFixture';
import * as processRunner from '../utils/processRunner';

test('ordinary Writer additions require the same executed baseline AST inventory and transmit a fresh signature', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-addition-naming-'));
    const source = path.join(directory, 'sample.py');
    const sourceText = 'class Calculator:\n    @staticmethod\n    def target(value: int):\n'
        + '        if value > 0:\n            return value + 1\n        return 0\n';
    fs.writeFileSync(source, sourceText);
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const originalRun = processRunner.runSpawn;
    const handlers = new Map<string, (...args: any[]) => any>(), persisted = new Map<string, unknown>();
    const modelName = 'neutral-writer-addition-naming';
    let scenario: 'normal' | 'empty' = 'normal';
    let writerRequests: any[] = [], reviewerRequests = 0, mutationRuns = 0, inventoryCalls = 0;
    let fixtureErrors: string[] = [];
    let corruptedInventory = false, seedCode = '';
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { workspaceFolders: [{ uri: { fsPath: directory } }],
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? python
                : key === 'runtimeContextTokens' ? 16384 : fallback,
                update: async () => assert.fail('the test run must preserve saved settings') }),
            openTextDocument: async () => ({}) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async () => true }; return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function (name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (url, options) => {
        try {
        const metadata = ollamaRuntimeMetadataFixture(url, options, { modelName, contextLength: 32768, observedContextTokens: 16384 });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        let response: string;
        if (request.roleInstructions.includes('You are the test Reviewer')) {
            reviewerRequests++;
            assert.match(request.prompt, /ISOLATED_EXECUTION_PASSED/);
            response = '{"findings":[]}';
        } else if (request.roleInstructions.includes('Analyst after successful')) {
            response = '{"tasks":[]}';
        } else if (request.roleInstructions.includes('dependency_behaviors')) {
            response = JSON.stringify({ test_strategy: { approach: 'Use the exact observed calls and preserve the target.' } });
        } else {
            writerRequests.push(request);
            if (request.options.num_predict !== undefined) {
                assert.ok(estimatePromptTokens(request.transmittedPrompt) <= request.options.num_ctx - request.options.num_predict,
                    'explicit output caps preserve room for the complete input');
            }
            if (writerRequests.length === 1) {
                assert.match(request.prompt, /WRITER_SEED_V1/);
                const selected = readObservedSeedCaseForModelFixture(request.prompt, 'Calculator.target');
                assert.ok(selected);
                assert.equal(selected.observedOutcome, 'returned');
                assert.deepEqual(selected.kwargs, {});
                seedCode = 'import unittest\nfrom sample import Calculator\nclass Cases(unittest.TestCase):\n'
                    + '    def test_seed(self):\n'
                    + `        self.assertEqual(Calculator.target(${selected.args.join(', ')}), ${selected.observedResult})\n`;
                response = '```python\n' + seedCode + '\n```';
            } else {
                assert.equal(scenario, 'normal', 'unknown inventory must stop before another Writer transport');
                assert.match(request.roleInstructions, /WRITER_ADDITION_V1 OUTPUT MODE/);
                assert.doesNotMatch(request.roleInstructions, /WRITER_CASE_SUBTASK_V1/);
                const signature = /WRITER_ADDITION_METHOD_V1[\s\S]*\ndef (test_[a-zA-Z0-9_]+)\(self\):\s*$/.exec(request.prompt);
                assert.ok(signature, 'the ordinary addition gets the host-selected signature at the wire boundary');
                assert.notEqual(signature[1], 'test_seed');
                assert.ok(request.prompt.includes(seedCode.trimEnd()), 'the complete executed baseline remains immutable');
                const focusRow = [...request.prompt.matchAll(/WRITER_FOCUS_CASE_FACTS_V1\n([^\n]+)/g)].at(-1)?.[1];
                const focusCases = focusRow ? JSON.parse(focusRow).cases : undefined;
                const assertions = focusCases?.map((item: any) => {
                    assert.deepEqual(item.kwargs, {});
                    return `    self.assertEqual(Calculator.target(${item.args.join(', ')}), ${item.observedResult})`;
                }) || ['    self.assertEqual(Calculator.target(0), 0)', '    self.assertEqual(Calculator.target(1), 2)'];
                response = '```python\ndef ' + signature[1] + '(self):\n'
                    + assertions.join('\n') + '\n```';
            }
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
        } catch (error) {
            fixtureErrors.push(error instanceof Error ? error.message.slice(0, 1000) : 'invalid fixture');
            throw error;
        }
    };
    (processRunner as any).runSpawn = async (...args: Parameters<typeof processRunner.runSpawn>) => {
        const script = args[1].find(value => value.endsWith('.py'));
        const name = script ? path.basename(script) : '';
        if (name === 'basic_mutation_runner.py') { mutationRuns++; }
        const result = await originalRun(...args);
        if (name !== 'scenario_inventory.py') { return result; }
        inventoryCalls++;
        // The real tool parses the real generated seed. Corrupt only its first
        // bookkeeping delivery; the separate execution scenario tool still works.
        if (scenario !== 'normal' && !corruptedInventory && args[2]?.input?.includes('def test_seed(')) {
            corruptedInventory = true;
            assert.equal(result.code, 0);
            assert.equal(JSON.parse(result.stdout)[0].id, 'Cases.test_seed');
            return { ...result, stdout: '[]' };
        }
        return result;
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: (key: string) => persisted.get(key), update: async (key: string, value: unknown) => {
                persisted.set(key, value);
            } }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName, paramSize: '13B',
            contextLength: 32768, contextLengthKnown: true, qualificationVersion: QUALIFICATION_VERSION,
            qualificationRuntime: { version: 'ollama-context-v1', numCtx: 16384 }, testGenerationReady: true,
            testGenerationMode: TEST_GEN_MODE_PYTHON, roleQualification: {
                writer: { state: 'verified', reason: 'public fixture' }, reviewer: { state: 'verified', reason: 'public fixture' },
                bugFixer: { state: 'not-run', reason: 'unused' } } });
        for (scenario of ['normal', 'empty'] as const) {
            await t.test(scenario, async () => {
                writerRequests = []; reviewerRequests = 0; mutationRuns = 0; inventoryCalls = 0;
                corruptedInventory = false; seedCode = '';
                fixtureErrors = [];
                const output = path.join(directory, scenario);
                await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName,
                    filePath: source, funcName: 'Calculator.target', promptStrategy: 'tier2', validationMode: 'full',
                    maxLoops: 2, timeoutSeconds: 60, mutationEngine: 'builtin', mutationTimeoutSeconds: 20, outputPath: output });
                const files = fs.readdirSync(output, { recursive: true }).map(String);
                const artifact = (name: string) => {
                    const match = files.find(item => path.basename(item) === name);
                    assert.ok(match, `missing ${name}; scenario=${scenario}`);
                    return path.join(output, match);
                };
                const events = fs.readFileSync(artifact('role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const knowledge = JSON.parse(fs.readFileSync(artifact('function_knowledge.json'), 'utf8'));
                const debug = JSON.stringify({ scenario, writerRequests: writerRequests.length, mutationRuns, fixtureErrors,
                    terminalStatus: knowledge.terminalStatus, failureCategory: knowledge.failureCategory,
                    failureStage: knowledge.failureStage, diagnostic: knowledge.diagnostic,
                    events: events.slice(-8).map(event => ({ stage: event.stage, status: event.status,
                        reason: event.detail?.reason, reasonCode: event.detail?.reasonCode })) });
                assert.ok(files.some(item => path.basename(item) === 'executable_baseline.json'), debug);
                const checkpoint = JSON.parse(fs.readFileSync(artifact('executable_baseline.json'), 'utf8'));
                const checkpointPath = path.join(path.dirname(artifact('executable_baseline.json')), checkpoint.testFile);
                assert.equal(evidenceHash(fs.readFileSync(checkpointPath, 'utf8')), checkpoint.codeHash);
                assert.ok(reviewerRequests >= 1, 'the real executable seed receives independent review');
                assert.ok(inventoryCalls >= 2, 'both bookkeeping and execution use real AST tools');
                assert.equal(fs.readFileSync(source, 'utf8'), sourceText);
                if (scenario === 'normal') {
                    assert.equal(writerRequests.length, 2, debug);
                    const writerEvents = events.filter(event => event.stage === 'model-request' && event.status === 'requested'
                        && event.detail.role === 'writer');
                    assert.equal(writerEvents.length, 2);
                    writerEvents.forEach((event, index) => {
                        assert.ok(estimatePromptTokens(writerRequests[index].transmittedPrompt) <= event.detail.inputBudget,
                            'the complete transmitted signature fits the actual logged input allowance');
                        assert.ok(event.detail.reservedOutputTokens > 0, 'unbounded generation still reserves output space');
                    });
                    assert.equal(mutationRuns, 2, 'each approved candidate reaches a real builtin mutation run');
                    assert.equal(reviewerRequests, 2, 'the changed test bytes require fresh independent review');
                    const selected = events.filter(event => event.stage === 'writer-addition' && event.status === 'scope-selected');
                    assert.equal(selected.length, 1);
                    assert.equal(selected[0].detail.baselineCodeHash, evidenceHash(seedCode.trimEnd()));
                    const instructionStart = writerRequests[1].prompt.lastIndexOf('\n\nWRITER_ADDITION_METHOD_V1\n');
                    assert.ok(instructionStart >= 0);
                    const instruction = writerRequests[1].prompt.slice(instructionStart);
                    assert.equal(evidenceHash(instruction), selected[0].detail.signatureHash);
                    const addedName = /def (test_[a-zA-Z0-9_]+)\(self\):/.exec(instruction)![1];
                    const baselineInventory = events.find(event => event.stage === 'candidate-methods'
                        && event.status === 'inventoried' && event.detail.codeHash === evidenceHash(seedCode.trimEnd()));
                    assert.deepEqual(baselineInventory.detail.methods.map((item: any) => item.id), ['Cases.test_seed']);
                    assert.ok(!baselineInventory.detail.methods.some((item: any) => item.id.endsWith('.' + addedName)));
                    assert.ok(fs.readFileSync(checkpointPath, 'utf8').startsWith(seedCode.trimEnd()), 'executed seed bytes remain retained');
                    assert.ok(events.some(event => event.stage === 'writer-addition' && event.status === 'merged'));
                } else {
                    assert.equal(corruptedInventory, true);
                    assert.equal(writerRequests.length, 1, 'the next Writer request cannot use a guessed empty inventory');
                    assert.equal(mutationRuns, 1, 'only the previously approved seed may undergo mutation');
                    assert.equal(knowledge.failureCategory, 'validation');
                    assert.equal(knowledge.failureStage, 'writer-addition-context');
                    assert.equal(knowledge.diagnostic.reasonCode, 'writer-method-inventory-unavailable');
                    assert.equal(checkpoint.codeHash, evidenceHash(seedCode.trimEnd()));
                    assert.ok(!events.some(event => event.stage === 'writer-addition' && event.status === 'scope-selected'));
                    assert.equal(events.filter(event => event.stage === 'candidate-methods' && event.status === 'unavailable').length, 1);
                }
            });
        }
    } finally {
        (processRunner as any).runSpawn = originalRun;
        globalThis.fetch = originalFetch; Module._load = originalLoad;
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
