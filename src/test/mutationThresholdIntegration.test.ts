import { readOllamaRoleRequest, ollamaRuntimeMetadataFixture,
    readObservedSeedCaseForModelFixture } from './ollamaRequestFixture';
import { functionReportDirectory } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { BatchJournal } from '../pipeline/batchJournal';
import { setLanguage } from '../i18n/core';
import { evidenceHash } from '../pipeline/analysisJournal';

/** This fixed-response actor copies the final host packet for one microtask.
 * It supplies no production expected values; the real Python gates verify it. */
function currentWriterCase(prompt: string, target: string) {
    const packets = [...prompt.matchAll(/^WRITER_FOCUS_CASE_FACTS_V1\n([^\n]+)/gm)];
    assert.ok(packets.length > 0, 'the current Writer request must end with explicit exact case facts');
    const packet = JSON.parse(packets.at(-1)![1]);
    assert.equal(packet.target, target);
    assert.match(packet.sourceHash, /^[a-f0-9]{64}$/);
    assert.ok(packet.runId);
    assert.match(packet.focusId, /^E[a-f0-9]{16}$/);
    assert.equal(packet.scenarioId, `observations:${packet.focusId}`);
    assert.equal(packet.cases.length, 1, 'one Writer microtask owns exactly one bound literal call');
    const observed = packet.cases[0];
    assert.ok(observed.caseId);
    assert.ok(Array.isArray(observed.args) && observed.args.every((value: unknown) => typeof value === 'string'));
    assert.deepEqual(observed.kwargs, {});
    assert.equal(observed.targetCall, `${target}(${observed.args.join(', ')})`);
    assert.equal(typeof observed.observedResult, 'string');
    const signatures = [...prompt.matchAll(/^REQUIRED NEW METHOD SIGNATURE[^\n]*\n(def (test_[A-Za-z0-9_]+)\(self\):)/gm)];
    const methodName = signatures.at(-1)?.[2];
    return { methodName, sourceHash: packet.sourceHash as string, runId: packet.runId as string, args: observed.args as string[], result: observed.observedResult as string,
        targetCall: observed.targetCall as string, focusId: packet.focusId as string, caseId: observed.caseId as string };
}

test('80 percent policy accepts real surviving mutants and verifies the same completed result in batch', async t => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-full-'));
    const file = path.join(root, 'bmi.py');
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
    fs.writeFileSync(file, source);
    const settings: Record<string, unknown> = { pythonPath: resolvePythonExecutable(undefined, repo), projectPath: root,
        language: 'en', runtimeContextTokens: 16384 };
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let writers = 0, fixes = 0;
    const logs: string[] = [];
    const focusedRequests: Array<{ targetCall: string; focusId: string; caseId: string }> = [];
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { if (message.text) { logs.push(message.text); } return true; } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => {
            handlers.set(name, handler); return { dispose() {} };
        } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (_url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(_url, options, { modelName: 'neutral-fixture', observedContextTokens: 16384 });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        assert.equal(request.options.num_ctx, 16384, 'the explicit fixture runtime is below the verified model maximum');
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) { response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the real selected target with controlled inputs and use only verified observations for assertions."}}'; }
        else if (request.roleInstructions.includes('You are the test Reviewer')) { response = '{"findings":[]}'; }
        else if (request.roleInstructions.includes('Analyst after successful')) { response = '{"tasks":[]}'; }
        else if (request.roleInstructions.includes('Python unittest Bug Fixer')) { fixes++; response = '```python\npass\n```'; }
        else {
            writers++;
            const seed = writers === 1 ? readObservedSeedCaseForModelFixture(request.prompt, 'calculate_bmi') : undefined;
            let code = 'import unittest\nfrom bmi import calculate_bmi\nclass Cases(unittest.TestCase):\n';
            if (seed) {
                assert.deepEqual(seed.kwargs, {});
                assert.equal(seed.observedOutcome, 'returned');
                code += `    def test_seed(self):\n        self.assertEqual(calculate_bmi(${seed.args.join(', ')}), ${seed.observedResult})\n`;
            } else {
                const observation = currentWriterCase(request.prompt, 'calculate_bmi');
                focusedRequests.push(observation);
                code += `    def ${observation.methodName ?? `test_focus_${writers}`}(self):\n        self.assertEqual(${observation.targetCall}, ${observation.result})\n`;
            }
            response = '```python\n' + code + '\n```';
        }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture',
            paramSize: '13B', contextLength: 32768, contextLengthKnown: true,
            effectiveRuntimeContextTokens: 16384, runtimeContextSource: 'ollama-ps' });
        settings.mutationEngine = 'mutmut';
        const blockedOutput = path.join(root, 'blocked');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: file,
            funcName: 'calculate_bmi', outputPath: blockedOutput, promptStrategy: 'tier2', validationMode: 'full',
            maxLoops: 5, timeoutSeconds: 60, mutpyTimeout: 120 });
        const blockedRelative = fs.readdirSync(blockedOutput, { recursive: true }).map(String)
            .find(p => path.basename(p) === 'function_knowledge.json')!;
        const blocked = JSON.parse(fs.readFileSync(path.join(blockedOutput, blockedRelative), 'utf8'));
        assert.equal(blocked.firstFailure.category, 'environment');
        assert.equal(writers, 0, 'an unavailable selected engine must stop before model generation');
        assert.equal(fixes, 0);
        assert.equal(blocked.mutation, undefined, 'cannot silently measure with builtin');
        settings.mutationEngine = 'builtin';
        const outputPath = path.join(root, 'results');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: file,
            funcName: 'calculate_bmi', outputPath, promptStrategy: 'tier2', validationMode: 'full',
            maxLoops: 5, timeoutSeconds: 60, mutpyTimeout: 120 });
        const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json')!;
        assert.ok(report, logs.join('\n'));
        const directory = path.dirname(path.join(outputPath, report));
        const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(events.some(e => e.stage === 'model-runtime' && e.status === 'selected'
            && e.detail.contextWindow === 16384 && e.detail.inputBudget === 11468));
        const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
        assert.equal(knowledge.terminalStatus, 'passed', JSON.stringify({ assessment: knowledge.qualityAssessment,
            last: knowledge.lastFailure, writers,
            failures: events.filter(e => ['failed', 'rejected', 'error', 'budget-exceeded'].includes(e.status)).map(e => ({ stage: e.stage, status: e.status, reason: e.detail.reason })) }));
        assert.equal(knowledge.qualityPolicy.policyId, 'standard80-v1');
        assert.equal(knowledge.qualityAssessment.fullyPassed, true);
        assert.equal(knowledge.reviewStatus, 'completed');
        assert.equal(knowledge.mutation.operatorSetVersion, 'builtin-ast-v3');
        assert.equal(knowledge.mutation.status, 'complete');
        assert.equal(knowledge.mutation.counts.executed, knowledge.mutation.counts.selected);
        const acceptedCode = fs.readFileSync(path.join(directory, knowledge.acceptedTest), 'utf8');
        assert.equal(knowledge.mutation.testHash, evidenceHash(acceptedCode));
        assert.equal(knowledge.reviewApproval.testHash, evidenceHash(acceptedCode));
        assert.equal(knowledge.reviewApproval.sourceHash, knowledge.sourceHash);
        assert.equal(knowledge.mutation.sourceHash, knowledge.sourceHash);
        assert.ok(knowledge.mutation.counts.selected > 19);
        assert.ok(knowledge.mutation.counts.survived > 0, 'surviving mutants remain in the full denominator');
        assert.equal(knowledge.mutation.counts.killed + knowledge.mutation.counts.survived, knowledge.mutation.counts.available);
        assert.ok(knowledge.mutation.mutants.filter((m: any) => m.status === 'KILLED').every((m: any) => m.killedBy.length));
        const measurements = events.filter(e => e.stage === 'mutation' && e.status === 'measured');
        assert.ok(writers > 1, 'a single-case seed expands through one AI-authored method for each bound input');
        assert.equal(writers, 1 + focusedRequests.length, 'each Writer request is either the initial seed or one exact microtask');
        const formalWriters = events.filter(e => e.stage === 'model-request' && e.status === 'requested'
            && ['writer', 'writer-revision'].includes(e.detail.role) && e.detail.phase !== 'context-qualification');
        assert.equal(formalWriters.length, writers, 'microtasks consume real role requests instead of being counted as measurement rounds');
        assert.ok(measurements.every(e => e.loop >= 1 && e.loop <= 5));
        assert.ok(!formalWriters.some(e => e.sequence > measurements.at(-1).sequence),
            'meeting the policy must not trigger another generation');
        assert.equal(fixes, 0);
        assert.ok(measurements.length > 1 && measurements.length <= 5);
        const final = fs.readFileSync(path.join(functionReportDirectory(directory), 'final_report.md'), 'utf8');
        assert.match(final, /Final outcome: Fully passed/);
        assert.match(final, /threshold ≥ 80%/);
        assert.match(final, /builtin-ast-v3/);
        assert.match(final, /Mutation execution diagnostics/);
        assert.match(final, /SURVIVED/);
        const batch = new BatchJournal(outputPath, root, { model: 'local/neutral-fixture', buildTimestamp: 'fixture', python: String(settings.pythonPath) });
        batch.discover(file, ['calculate_bmi']); batch.start(); batch.begin(0);
        batch.attach(0, functionReportDirectory(directory)); batch.refresh(0); batch.finish('completed');
        const summary = JSON.parse(fs.readFileSync(path.join(outputPath, 'batch_manifest.json'), 'utf8'));
        assert.equal(summary.allTargetsPassed, true, JSON.stringify(summary.statusCounts));
        t.diagnostic(JSON.stringify({ writers, measurements: measurements.length,
            counts: knowledge.mutation.counts, policy: knowledge.qualityPolicy.policyId,
            reviewedAcceptedHash: knowledge.reviewApproval.testHash === evidenceHash(acceptedCode) }));
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        setLanguage('zh-tw'); Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
