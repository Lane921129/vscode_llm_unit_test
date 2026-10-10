import { readOllamaRoleRequest } from './ollamaRequestFixture';
import { functionReportDirectory, roundDirectory } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { setLanguage } from '../i18n/core';

test('numeric observations guide an AI revision which is reviewed before real mutation', async () => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-full-'));
    const file = path.join(root, 'bmi.py');
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
    const correctException = '    def test_zero_height(self):\n        with self.assertRaises(ZeroDivisionError):\n            calculate_bmi(70, 0)\n';
    const candidate = fs.readFileSync(path.join(repo, 'test/fixtures/repair/bmi_unpack_wrong.py'), 'utf8').replace(/\r\n/g, '\n')
        + '\n    def test_seventy(self):\n        bmi, status = calculate_bmi(70, 170)\n'
        + '        self.assertEqual(bmi, 24.9)\n        self.assertEqual(status, "健康體位")\n'
        + '    def test_zero_weight(self):\n        with self.assertRaises(ZeroDivisionError):\n            calculate_bmi(0, 1)\n'
        + '    def test_type_checks(self):\n        bmi, status = calculate_bmi(50, 160)\n'
        + '        self.assertEqual(type(bmi), float)\n        self.assertEqual(type(status), str)\n        self.assertEqual(bmi, 22.22)\n'
        + '    def test_zero_inputs(self):\n        bmi, status = calculate_bmi(0, 0)\n        self.assertEqual(bmi, 0)\n'
        + '    def test_string_inputs(self):\n        bmi, status = calculate_bmi("50", "160")\n        self.assertEqual(bmi, 22.22)\n'
        + correctException;
    const corrected = candidate.replace('25.62', '19.53').replace('21.22', '17.58')
        .replace('28.96', '23.44').replace('32.72', '31.25')
        .replace('self.assertAlmostEqual(bmi, 23.44, delta=0.01)\n        self.assertEqual(status, "體重過重")',
            'self.assertAlmostEqual(bmi, 23.44, delta=0.01)\n        self.assertEqual(status, "健康體位")')
        .replace('self.assertEqual(bmi, 24.9)\n        self.assertEqual(status, "健康體位")',
            'self.assertEqual(bmi, 24.22)\n        self.assertEqual(status, "體重過重")')
        .replace('with self.assertRaises(ZeroDivisionError):\n            calculate_bmi(0, 1)',
            "self.assertEqual(calculate_bmi(0, 1), (0.0, '體重過輕'))")
        .replace('self.assertEqual(bmi, 22.22)', 'self.assertEqual(bmi, 19.53)')
        .replace('bmi, status = calculate_bmi(0, 0)\n        self.assertEqual(bmi, 0)',
            'with self.assertRaises(ZeroDivisionError):\n            calculate_bmi(0, 0)')
        .replace('bmi, status = calculate_bmi("50", "160")\n        self.assertEqual(bmi, 22.22)',
            'with self.assertRaises(TypeError):\n            calculate_bmi("50", "160")');
    fs.writeFileSync(file, source);
    const settings: Record<string, unknown> = { pythonPath: resolvePythonExecutable(undefined, repo), projectPath: root, language: 'en' };
    const handlers = new Map<string, (...args: any[]) => any>();
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let writers = 0, fixes = 0, reviews = 0;
    const logs: string[] = [];
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
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) { response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the real selected target with controlled inputs and use only verified observations for assertions."}}'; }
        else if (request.roleInstructions.includes('You are the test Reviewer')) {
            reviews++;
            assert.match(request.prompt, /HOST_VERIFIED_REVIEW_FACTS_V1/);
            assert.match(request.prompt, /"observationVerified":true/);
            // The 2026-10-07 failure: review contradicts an exact numeric result
            // already verified by independent isolated execution.
            const line = corrected.split('\n').findIndex(value => value.includes('self.assertEqual(bmi, 24.22)')) + 1;
            response = reviews === 1 ? JSON.stringify({ findings: [{ category: 'assertion-evidence', test_line: `L${line}`,
                reason: 'The actual result differs from the expected value 24.22.',
                action: 'Change the expected value to 23.5 in this assertion.' }] }) : '{"findings":[]}';
            if (reviews === 2) { assert.match(request.prompt, /observed-outcome-contradiction/); }
        }
        else if (request.roleInstructions.includes('Python unittest Bug Fixer')) { fixes++; response = '```python\npass\n```'; }
        else { writers++; if (writers === 2) { assert.match(request.prompt, /VERIFIED_NUMERIC_EVIDENCE_LEDGER_V1/); }
            response = '```python\n' + (writers === 1 ? candidate : corrected) + '\n```'; }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        await handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-fixture', paramSize: '13B', contextLength: 32768 });
        const outputPath = path.join(root, 'results');
        await handlers.get('llm-unit-test.runCaptureAndTest')!({ envType: 'local', modelName: 'neutral-fixture', filePath: file,
            funcName: 'calculate_bmi', outputPath, promptStrategy: 'tier2', validationMode: 'full',
            maxLoops: 1, timeoutSeconds: 60, mutpyTimeout: 30 });
        const report = fs.readdirSync(outputPath, { recursive: true }).map(String).find(p => path.basename(p) === 'function_knowledge.json')!;
        assert.ok(report, logs.join('\n'));
        const directory = path.dirname(path.join(outputPath, report));
        const events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const numeric = events.find(e => e.stage === 'numeric-skill' && e.status === 'verified');
        assert.ok(numeric, JSON.stringify(events.filter(e => /numeric|failed|rejected/.test(e.stage + e.status))));
        assert.equal(writers, 2, JSON.stringify(events.filter(e => ['failed', 'rejected', 'error', 'tier-failed'].includes(e.status))
            .map(e => ({ stage: e.stage, status: e.status, reason: e.detail.reason }))));
        assert.equal(fixes, 0, 'multiple failing methods route to the Writer');
        assert.equal(reviews, 2, 'contradictory review is repaired once, never forwarded as Writer instructions');
        assert.ok(events.some(e => e.stage === 'reviewer' && e.status === 'invalid-response'
            && e.detail.diagnostics.includes('observed-outcome-contradiction')));
        const proof = JSON.parse(fs.readFileSync(path.join(roundDirectory(directory, 1), numeric.detail.file), 'utf8'));
        assert.equal(proof.corrections.length, 11, 'numeric, classification, type-checked result and both exception directions');
        assert.equal(new Set(proof.corrections.map((item: any) => JSON.stringify(item.basis.call))).size, 8);
        assert.equal(proof.traces.length, 2, 'eight inputs are verified in two bounded probe batches');
        assert.equal(proof.traces.flatMap((trace: any) => trace.cases).filter((item: any) => item.source.kind === 'semantic_guided'
            && item.source.detail === 'numeric-calculation').length, 8, 'model-selected inputs must not be labeled as source callers');
        const baseline = JSON.parse(fs.readFileSync(path.join(directory, 'executable_baseline.json'), 'utf8'));
        const seedEnd = events.findIndex(e => e.stage === 'writer-seed' && e.status === 'accepted');
        const seedCheckpoint = events.slice(0, seedEnd).filter(e => e.stage === 'executable-baseline').at(-1);
        assert.equal(proof.schemaVersion, 'numeric-observations-v1');
        assert.equal(proof.candidateTestHash, undefined, 'the observation tool does not own a corrected test candidate');
        const actual = fs.readFileSync(path.join(directory, seedCheckpoint.detail.testFile), 'utf8');
        assert.ok(fs.existsSync(path.join(directory, baseline.testFile)));
        assert.equal(actual.trim(), corrected.trim(), 'saved tests are exactly the AI revision, with no host augmentation');
        assert.doesNotMatch(actual, /TestVerifiedTrace|TestVerifiedState/);
        assert.ok(actual.includes(correctException.trimEnd()));
        assert.match(actual, /self.assertEqual\(bmi, 24.22\)/);
        assert.match(actual, /self.assertEqual\(calculate_bmi\(0, 1\), \(0.0, '體重過輕'\)\)/);
        assert.match(actual, /self.assertEqual\(type\(bmi\), float\)/);
        assert.match(actual, /with self.assertRaises\(TypeError\):\s+calculate_bmi\("50", "160"\)/);
        assert.match(actual, /with self.assertRaises\(ZeroDivisionError\):\s+calculate_bmi\(0, 0\)/);
        assert.ok(events.some(e => e.stage === 'mutation' && e.status === 'measured'));
        assert.ok(fs.existsSync(path.join(roundDirectory(directory, 1), 'loop1_mutation.json')));
        const knowledge = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
        assert.equal(knowledge.reviewStatus, 'completed');
        const approved = events.findIndex(e => e.stage === 'reviewer' && e.status === 'approved');
        const mutation = events.findIndex(e => e.stage === 'mutation' && e.status === 'started');
        assert.ok(approved >= 0 && mutation > approved);
        assert.equal(knowledge.reviewApproval.testHash, baseline.codeHash);
        assert.match(logs.join('\n'), /[Oo]bservations|[Cc]alculation/);
        assert.match(fs.readFileSync(path.join(roundDirectory(directory, 1), 'failure_report.md'), 'utf8'), /numeric-skill/);
        assert.ok(fs.existsSync(path.join(functionReportDirectory(directory), 'final_report.md')));
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally {
        setLanguage('zh-tw'); Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
