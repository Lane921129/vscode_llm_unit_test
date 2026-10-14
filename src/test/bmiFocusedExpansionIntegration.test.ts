import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { getLanguage, setLanguage } from '../i18n/core';
import { evidenceHash } from '../pipeline/analysisJournal';
import { summarizeCandidateMethods } from '../pipeline/candidateMethodSummary';
import { functionReportDirectory } from '../pipeline/resultLayout';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { extractWriterAdditionCode } from '../validation/testMerger';
import { readOllamaRoleRequest } from './ollamaRequestFixture';

const fence = (code: string) => '```python\n' + code + '\n```';
const seed = `import unittest
from bmi import calculate_bmi
class Cases(unittest.TestCase):
    def test_seed(self):
        self.assertEqual(calculate_bmi(50, 160), (19.53, "健康體位"))
`;
// Fixed responses are test fixtures, not a production assertion generator.
// Every input is separately supplied to the real controlled Trace as input only.
const observedCases = [
    [17, 100, 17, '體重過輕'], [18.49, 100, 18.49, '體重過輕'],
    [18.5, 100, 18.5, '健康體位'], [20, 100, 20, '健康體位'], [23.99, 100, 23.99, '健康體位'],
    [24, 100, 24, '體重過重'], [25, 100, 25, '體重過重'], [26.99, 100, 26.99, '體重過重'],
    [27, 100, 27, '肥胖'], [30, 100, 30, '肥胖'], [0, 100, 0, '體重過輕'],
    [-1, -1, -10000, '體重過輕'], [85, 190, 23.55, '健康體位'],
    [80, 180, 24.69, '體重過重'], [40, 150, 17.78, '體重過輕'], [100, 170, 34.6, '肥胖']
] as const;
/** The mocked Writer follows the exact active observed family; production never
 * generates these assertions here. The real runner must still verify every one. */
function focusedAddition(prompt: string, attempt: number): string {
    const reminder = [...prompt.matchAll(/WRITER_FOCUS_CASE_FACTS_V1\n([^\n]+)/g)].at(-1);
    if (reminder) {
        const bound = JSON.parse(reminder[1]);
        assert.match(bound.focusId, /^E[a-f0-9]{16}$/);
        assert.equal(bound.scenarioId, `observations:${bound.focusId}`);
        assert.equal(bound.target, 'calculate_bmi');
        assert.ok(bound.cases.length > 0, 'the final Writer reminder includes every active observed case');
        const assertions = bound.cases.map((item: any) => {
            assert.equal(item.args.length, 2);
            assert.deepEqual(item.kwargs, {});
            assert.ok(item.args.every((value: unknown) => typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)));
            assert.equal(typeof item.observedResult, 'string');
            assert.equal(item.targetCall, `calculate_bmi(${item.args.join(', ')})`);
            return `    self.assertEqual(${item.targetCall}, ${item.observedResult})`;
        });
        const requiredMethod = prompt.match(/REQUIRED NEW METHOD SIGNATURE \(body must be authored by you\):\ndef (test_[a-zA-Z0-9_]+)\(self\):\s*$/)?.[1];
        return `def ${requiredMethod || `test_focus_${bound.focusId.slice(1)}_${attempt}`}(self):\n${assertions.join('\n')}\n`;
    }
    const tasks = prompt.split('\n').flatMap(line => {
        try {
            const value = JSON.parse(line.trim());
            return Array.isArray(value) ? value.filter(item => item?.origin === 'controlled-focus-observations') : [];
        } catch { return []; }
    });
    const task = tasks.at(-1);
    assert.ok(task?.observations?.length, 'the Writer must receive an explicit active observed family');
    assert.match(task.binding.focusId, /^E[a-f0-9]{16}$/);
    const assertions = task.observations.map((item: any) => {
        assert.equal(item.observedOutcome, 'returned');
        assert.equal(item.args.length, 2);
        assert.deepEqual(item.kwargs, {});
        assert.ok(item.args.every((value: unknown) => typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)));
        assert.equal(typeof item.observedResult, 'string');
        return `    self.assertEqual(calculate_bmi(${item.args.join(', ')}), ${item.observedResult})`;
    });
    return `def test_focus_${task.binding.focusId.slice(1)}_${attempt}(self):\n${assertions.join('\n')}\n`;
}

function sourceObservedAddition(attempt: number): string {
    return `def test_remaining_observed_paths_${attempt}(self):\n`
        + observedCases.map(([weight, height, expectedBmi, status]) =>
            `    self.assertEqual(calculate_bmi(${weight}, ${height}), (${expectedBmi}, ${JSON.stringify(status)}))`).join('\n') + '\n';
}

function readRun(output: string) {
    const entries = fs.readdirSync(output, { recursive: true }).map(String);
    const reports = entries.filter(name => path.basename(name) === 'function_knowledge.json');
    assert.equal(reports.length, 1);
    const directory = path.dirname(path.join(output, reports[0]));
    return { directory,
        knowledge: JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8')),
        events: fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) as any[],
        checkpoint: JSON.parse(fs.readFileSync(path.join(directory, 'executable_baseline.json'), 'utf8')),
        final: fs.readFileSync(path.join(functionReportDirectory(directory), 'final_report.md'), 'utf8') };
}

function readExecutedBaseline(output: string): { code: string; codeHash: string } {
    const files = fs.readdirSync(output, { recursive: true }).map(String)
        .filter(name => path.basename(name) === 'executable_baseline.json');
    assert.equal(files.length, 1, 'the host retains one exact executed checkpoint for this target');
    const directory = path.dirname(path.join(output, files[0]));
    const checkpoint = JSON.parse(fs.readFileSync(path.join(output, files[0]), 'utf8'));
    assert.equal(checkpoint.target, 'calculate_bmi');
    assert.equal(path.basename(checkpoint.testFile), checkpoint.testFile);
    const code = fs.readFileSync(path.join(directory, checkpoint.testFile), 'utf8');
    assert.equal(evidenceHash(code), checkpoint.codeHash);
    return { code, codeHash: checkpoint.codeHash };
}

test('BMI keeps an executed seed, rejects wrong quality/review advice and verifies real addition coverage and mutation', async t => {
    const repo = path.resolve(__dirname, '../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmi-focused-expansion-'));
    const python = resolvePythonExecutable(undefined, repo);
    const source = fs.readFileSync(path.join(repo, 'test/test_mut/bmi.py'), 'utf8');
    const file = path.join(root, 'bmi.py');
    fs.writeFileSync(file, source, 'utf8');
    const cases = [[50, 160], ...observedCases.map(([weight, height]) => [weight, height]), [0, 0], ['a', 'a']];
    const built = spawnSync(python, ['-B', path.join(repo, 'python_scripts/probe_fixture_builder.py'),
        '--root', root, '--file', file, '--target', 'calculate_bmi'], {
        input: JSON.stringify({ cases: cases.map(args => ({ args_literals: JSON.stringify(args) })) }),
        encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    assert.equal(built.status, 0, built.stderr);
    fs.writeFileSync(path.join(root, 'trace-inputs.json'), built.stdout, 'utf8');
    const hasMutatest = spawnSync(python, ['-B', '-c', 'import importlib.util; print(importlib.util.find_spec("mutatest") is not None)'],
        { encoding: 'utf8', timeout: 10000 }).stdout.trim() === 'True';
    const engine = hasMutatest ? 'mutatest' : 'builtin';
    const handlers = new Map<string, (...args: any[]) => any>();
    const settings: Record<string, unknown> = { pythonPath: python, projectPath: root, language: 'en', probeInputFile: 'trace-inputs.json' };
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    const originalLanguage = getLanguage();
    let scenario: 'positive' | 'modified-baseline' | 'review-revision' = 'positive';
    let writers = 0, reviews = 0, qualities = 0;
    let noOpAdditions = 0;
    let ordinaryAdditions = 0;
    let activeObservedFamily = false;
    const wireRoles: Array<{ role: string; prompt: string }> = [];
    const microtasks: Array<{ focusId: string; caseId: string; targetCall: string; methodName: string; code: string; noOp: boolean }> = [];
    const families = new Map<string, string[]>();
    const baselineMethodIds = new Map<string, string[]>();
    const logs: string[] = [];
    let reviewDraft = '', reviewFinding = '', revisedAddition = '';
    let reviewRevisionRequests = 0;
    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { registerWebviewViewProvider: (_: string, provider: any) => {
            provider.webview = { postMessage: async (message: any) => { if (message.text) { logs.push(message.text); } return true; } };
            return { dispose() {} };
        }, showInformationMessage: async () => {}, showTextDocument: async () => {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async () => ({}),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
        commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return { dispose() {} }; } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async (url, options) => {
        const endpoint = String(url);
        if (endpoint.endsWith('/api/show')) {
            return new Response(JSON.stringify({ details: { parameter_size: '13B' },
                model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } }), { status: 200 });
        }
        if (endpoint.endsWith('/api/ps')) { return new Response('{"models":[]}', { status: 200 }); }
        const body = JSON.parse(String(options?.body));
        const request = readOllamaRoleRequest(body);
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) {
            wireRoles.push({ role: 'analyst', prompt: request.prompt });
            response = '{"dependency_behaviors":[],"test_strategy":{"approach":"Exercise the real target using only supplied observations for all assertions."}}';
        } else if (request.roleInstructions.includes('You are the test Reviewer')) {
            reviews++; wireRoles.push({ role: 'reviewer', prompt: request.prompt });
            assert.match(request.prompt, /ISOLATED_EXECUTION_PASSED/);
            if (scenario === 'review-revision' && reviews === 2) {
                const block = request.prompt.match(/<TEST_FILE>\n([\s\S]*?)\n<\/TEST_FILE>/);
                assert.ok(block);
                reviewDraft = block[1].split('\n').map((line: string) => line.replace(/^\[L\d+\] /, '')).join('\n');
                const lines = reviewDraft.split('\n');
                const methodLine = lines.findIndex(line => /def test_focus_/.test(line));
                assert.ok(methodLine >= 0);
                const assertionLine = methodLine + 1;
                const call = lines[assertionLine].match(/calculate_bmi\([^)]*\)/)?.[0];
                assert.ok(call);
                reviewFinding = `Add self.assertIsInstance(${call}, tuple) in this same test method to check the observed tuple container while preserving the existing value assertion and inputs.`;
                response = JSON.stringify({ findings: [{ category: 'assertion-evidence', test_line: `L${assertionLine + 1}`,
                    reason: 'The current assertEqual checks value equality, but this exact observed return also needs an explicit tuple container assertion.',
                    action: reviewFinding }] });
                const replacement = [...lines];
                replacement.splice(assertionLine + 1, 0, `        self.assertIsInstance(${call}, tuple)`);
                revisedAddition = replacement.join('\n').replace(/    def test_seed\(self\):\n        self\.assertEqual\(calculate_bmi\(50, 160\), \(19\.53, "健康體位"\)\)\n?/, '');
                assert.ok(!revisedAddition.includes('def test_seed('));
            } else {
                if (scenario === 'review-revision' && reviews === 3) {
                    assert.match(request.prompt, /self\.assertIsInstance\(calculate_bmi\(/);
                }
                response = scenario === 'positive' && reviews === 1
                ? JSON.stringify({ findings: [{ category: 'assertion-quality', test_line: 'L5',
                    reason: 'calculate_bmi(50, 160) raises TypeError rather than returning a tuple.',
                    action: 'Replace this assertion with with self.assertRaises(TypeError) around calculate_bmi(50, 160).' }] })
                : '{"findings":[]}';
            }
        } else if (request.roleInstructions.includes('Analyst after successful')) {
            qualities++; wireRoles.push({ role: 'quality', prompt: request.prompt });
            const focus = JSON.parse(request.prompt.match(/FOCUS\n([^\n]+)/)![1]);
            const boundMatch = request.prompt.match(/BOUND FOCUS OBSERVATIONS[^\n]*\n([^\n]+)/);
            activeObservedFamily = Boolean(boundMatch);
            if (scenario === 'positive') {
                if (qualities === 1) { assert.ok(boundMatch, 'the initial measurable boundary has a real input family'); }
                const bound = boundMatch ? JSON.parse(boundMatch[1]) : undefined;
                if (bound) { families.set(focus.id, bound.cases.map((item: any) => item.caseId)); }
                response = JSON.stringify({ tasks: [{ evidence_id: focus.id,
                    hypothesis: 'Exercise the measured comparison boundary with the same observed inputs.',
                    scenario: qualities === 1 ? 'calculate_bmi(0, 0) returns (0, underweight)' : bound?.scenario_id
                        || 'Exercise source classification paths using the supplied original Trace inputs (17, 100), (24, 100) and (27, 100).',
                    verification: bound ? 'verify-observed-behavior'
                        : 'Verify same-input outcomes against the supplied original Trace, then execute the unchanged target.' }] });
            } else { response = '{"tasks":[]}'; }
        } else {
            assert.doesNotMatch(request.roleInstructions, /Python unittest Bug Fixer/, 'passing baseline and addition need no method repair');
            writers++; wireRoles.push({ role: 'writer', prompt: request.prompt });
            if (scenario === 'review-revision' && request.prompt.includes('WRITER_ADDITION_REVISION_V1')) {
                reviewRevisionRequests++;
                assert.doesNotMatch(request.roleInstructions, /WRITER_CASE_SUBTASK_V1/,
                    'a Reviewer finding repairs its complete unaccepted draft instead of starting a fresh case');
                assert.match(request.prompt, /WRITER_REVISION_REQUEST_V2/);
                assert.ok(request.prompt.includes(reviewFinding), 'the exact actionable finding reaches the Writer revision');
                assert.ok(request.prompt.includes(reviewDraft), 'the complete failed draft reaches the Writer revision');
                assert.ok(request.prompt.includes('```python\n' + seed.trimEnd() + '\n```'),
                    'the immutable expansion baseline stays the original approved seed, not the executable unapproved family');
                assert.match(request.prompt, /host merges with that original baseline, not with this failed draft/);
                response = fence(revisedAddition);
            } else if (writers === 1) { assert.match(request.prompt, /WRITER_SEED_V1/); response = fence(seed); }
            else {
                assert.match(request.roleInstructions, /WRITER_ADDITION_V1 OUTPUT MODE/);
                assert.equal(body.format, undefined, 'complete-file JSON output contract cannot override the addition mode');
                const hostBaseline = readExecutedBaseline(path.join(root, scenario));
                assert.ok(hostBaseline.code.startsWith(seed.trimEnd()), 'the complete immutable executed seed remains with the host');
                assert.doesNotMatch(request.prompt, /calculate_bmi\(0, 0\) returns \(0, underweight\)/,
                    'rejected Analyst prose is never passed to Writer as an assertion plan');
                const isMicrotask = request.roleInstructions.includes('WRITER_CASE_SUBTASK_V1');
                const bound = isMicrotask ? JSON.parse([...request.prompt.matchAll(/WRITER_FOCUS_CASE_FACTS_V1\n([^\n]+)/g)].at(-1)![1]) : undefined;
                const requiredMethod = isMicrotask ? request.prompt.match(/REQUIRED NEW METHOD SIGNATURE \(body must be authored by you\):\ndef (test_[a-zA-Z0-9_]+)\(self\):\s*$/)?.[1] : undefined;
                if (isMicrotask) {
                    assert.equal(bound.cases.length, 1, 'each microtask receives exactly one completed observed case');
                    assert.match(request.roleInstructions, /exactly ONE observed case/);
                    assert.doesNotMatch(request.prompt, /AI DRAFT ACCUMULATOR|CURRENT UNACCEPTED CANDIDATE/,
                        'earlier unapproved Python bodies cannot become templates for another observed case');
                    assert.doesNotMatch(request.prompt, /VERIFIED BOUNDARY OBSERVATIONS \(the AI|VERIFIED_NUMERIC_EVIDENCE_LEDGER_V1/,
                        'global multi-case envelopes cannot override the selected single-case observation');
                    const actual = JSON.parse(request.prompt.match(/VERIFIED OBSERVATIONS[^\n]*\n([^\n]+)/)![1]);
                    assert.equal(actual.examples.length, 1, 'only the exact same-input observation reaches this subtask');
                    assert.deepEqual(actual.errors, []);
                    const exact = actual.examples[0];
                    assert.deepEqual(exact.args, bound.cases[0].args);
                    assert.deepEqual(exact.kwargs || {}, bound.cases[0].kwargs);
                    assert.ok(Array.isArray(exact.case_ids) && exact.case_ids.length > 0);
                    assert.ok(request.prompt.includes(`SCENARIO SELECTION: exact case IDs ${exact.case_ids.join(', ')}`),
                        'merged observation IDs are resolved separately from fresh worker focus IDs');
                    const inspected = spawnSync(python, ['-B', '-c',
                        'import ast,json,sys; data=json.load(sys.stdin); a=ast.literal_eval(data["actual"]); b=ast.literal_eval(data["expected"]); '
                        + 'print(json.dumps({"equal":type(a) is type(b) and a==b,"typesEqual":[type(v).__name__ for v in a]==[type(v).__name__ for v in b]}))'],
                    { input: JSON.stringify({ actual: exact.result, expected: bound.cases[0].observedResult }),
                        encoding: 'utf8', timeout: 5000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
                    assert.equal(inspected.status, 0, inspected.stderr);
                    assert.deepEqual(JSON.parse(inspected.stdout), { equal: true, typesEqual: true },
                        'the actual verified return and final focus value are the same literal and Python types, not merely the same ID');
                    if (request.prompt.includes('AI DRAFT METHOD INVENTORY')) {
                        const draft = JSON.parse(request.prompt.match(/AI DRAFT METHOD INVENTORY \(unexecuted, unapproved; names only\):\n([^\n]+)/)![1]);
                        assert.deepEqual(Object.keys(draft).sort(), ['codeHash', 'methods']);
                        assert.match(draft.codeHash, /^[a-f0-9]{64}$/);
                        assert.ok(Array.isArray(draft.methods) && draft.methods.every((name: unknown) => typeof name === 'string'));
                        for (const previous of microtasks.filter(item => item.focusId === bound.focusId && !item.noOp)) {
                            assert.ok(draft.methods.some((name: string) => name.endsWith(`.${previous.methodName}`)));
                            assert.ok(!request.prompt.includes(extractWriterAdditionCode(previous.code)),
                                'only names and hash are retained for previous unapproved methods in the same family');
                        }
                    } else {
                        assert.match(request.prompt, /The original baseline metadata above also lists all existing method names/);
                    }
                    assert.match(requiredMethod || '', new RegExp(`^test_focus_${bound.focusId.slice(1)}_${hostBaseline.codeHash.slice(0, 8)}_[1-3]$`));
                    assert.ok(request.roleInstructions.includes(`Name the new method ${requiredMethod};`), 'system and final user signature use the same new method name');
                    assert.notEqual(requiredMethod, 'test_seed');
                    assert.doesNotMatch(request.roleInstructions, /WRITER_SEED_V1 OUTPUT SCOPE/);
                    assert.match(request.prompt, /WRITER_CASE_ADDITION_V1/);
                    const setup = request.prompt.match(/BASELINE SETUP CONTEXT \(AST projection only; existing test bodies remain unchanged with the host\):\n```python\n([\s\S]*?)\n```\n([^\n]+)/);
                    assert.ok(setup, 'a simple unittest uses an AST setup projection, not the previous assertion bodies');
                    const metadata = JSON.parse(setup[2]);
                    assert.deepEqual(Object.keys(metadata).sort(), ['baselineHash', 'existingMethodIds']);
                    assert.equal(metadata.baselineHash, hostBaseline.codeHash, 'the projection refers to the actual whole UTF-8 baseline');
                    if (!baselineMethodIds.has(hostBaseline.codeHash)) {
                        const inventoried = spawnSync(python, ['-B', pythonToolPath('scenarios')],
                            { input: hostBaseline.code, encoding: 'utf8', timeout: 5000,
                                env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
                        assert.equal(inventoried.status, 0, inventoried.stderr);
                        baselineMethodIds.set(hostBaseline.codeHash, JSON.parse(inventoried.stdout).map((item: any) => item.id));
                    }
                    assert.deepEqual(metadata.existingMethodIds, baselineMethodIds.get(hostBaseline.codeHash));
                    assert.match(setup[1], /import unittest/);
                    assert.match(setup[1], /from bmi import calculate_bmi/);
                    assert.match(setup[1], /class Cases\(unittest\.TestCase\):/);
                    assert.doesNotMatch(setup[1], /def test_|self\.assert/);
                    assert.ok(!request.prompt.includes(hostBaseline.code), 'old executable assertion bodies are not copied into the simple case prompt');
                    assert.match(request.prompt, /setup context is not an executable test candidate/);
                } else {
                    assert.ok(request.prompt.includes(hostBaseline.code), 'generic expansion retains the complete executed baseline when no projection applies');
                }
                if (scenario === 'positive' && writers === 2) {
                    noOpAdditions++; response = fence(seed);
                } else {
                    if (scenario === 'positive' && writers === 3) {
                        assert.match(request.prompt, /focused-writer-no-new-methods/,
                            'the one no-op correction must explain the missing focus addition');
                    }
                    response = scenario !== 'modified-baseline' ? fence(activeObservedFamily
                        ? focusedAddition(request.prompt, writers) : sourceObservedAddition(writers)) : fence(seed.replace('19.53', '19.52'));
                }
                if (scenario === 'positive' && isMicrotask) {
                    microtasks.push({ focusId: bound.focusId, caseId: bound.cases[0].caseId,
                        targetCall: bound.cases[0].targetCall, methodName: requiredMethod!, code: response, noOp: writers === 2 });
                } else if (scenario === 'positive') {
                    ordinaryAdditions++;
                }
            }
        }
        return new Response(JSON.stringify({ response, done: true }), { status: 200 });
    };
    try {
        setLanguage('en');
        require('../orchestrator').activate({ extension: { id: 'fixture', packageJSON: { version: '0.0.1' } }, extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} }, secrets: {}, subscriptions: [] });
        handlers.get('llm-unit-test.updateModelProfile')!({ envType: 'local', modelName: 'neutral-bmi-expansion',
            paramSize: '13B', contextLength: 32768, effectiveRuntimeContextTokens: 16384, runtimeContextSource: 'ollama-num-ctx' });
        const run = handlers.get('llm-unit-test.runCaptureAndTest')!;
        const params = { envType: 'local', modelName: 'neutral-bmi-expansion', filePath: file, funcName: 'calculate_bmi',
            promptStrategy: 'tier2', validationMode: 'full', mutationEngine: engine,
            maxLoops: 4, timeoutSeconds: 60, mutpyTimeout: 120, mutationWorkers: 2 };
        let measured: ReturnType<typeof readRun> | undefined;
        await t.test('the real ' + engine + ' engine measures a preserved seed plus independently reviewed additions', async () => {
            const outputPath = path.join(root, 'positive');
            await run({ ...params, outputPath });
            measured = readRun(outputPath);
            const { knowledge, checkpoint, events, directory } = measured;
            const diagnostic = JSON.stringify({ terminal: knowledge.terminalStatus, failure: knowledge.lastFailure,
                writers, reviews, qualities, stages: events.slice(-30).map(e => [e.stage, e.status, e.detail?.reasonCode]) });
            const successfulWrites = writers - noOpAdditions;
            assert.equal(noOpAdditions, 1, diagnostic);
            assert.equal(successfulWrites, 1 + microtasks.filter(item => !item.noOp).length + ordinaryAdditions, diagnostic);
            const measuredMutations = events.filter(e => e.stage === 'mutation' && e.status === 'measured');
            assert.equal(measuredMutations.length, 1 + families.size + ordinaryAdditions,
                'only the seed and each complete family or final original-Trace addition are measured');
            assert.equal(reviews, measuredMutations.length + 1, diagnostic);
            assert.equal(qualities, measuredMutations.length, diagnostic);
            assert.ok(events.some(e => e.stage === 'reviewer' && e.status === 'invalid-response'), diagnostic);
            assert.ok(events.some(e => e.stage === 'analyst-quality' && e.status === 'invalid-response'
                && e.detail.diagnostics.includes('quality-observation-mismatch')), diagnostic);
            assert.equal(knowledge.terminalStatus, 'passed', diagnostic);
            assert.equal(knowledge.qualityAssessment.counts.lines.executed, 10);
            assert.equal(knowledge.qualityAssessment.counts.lines.total, 10);
            assert.equal(knowledge.qualityAssessment.measurementStatus, 'complete');
            assert.equal(knowledge.qualityAssessment.policyStatus, 'met');
            assert.equal(knowledge.mutation.engine, engine);
            assert.equal(knowledge.mutation.counts.executed, knowledge.mutation.counts.selected);
            assert.ok(knowledge.mutation.counts.selected > 0);
            assert.equal(knowledge.mutation.counts.killed, knowledge.mutation.counts.selected, diagnostic);
            if (hasMutatest) { assert.equal(knowledge.mutation.counts.selected, 39); }
            const code = fs.readFileSync(path.join(directory, checkpoint.testFile), 'utf8');
            assert.ok(code.startsWith(seed.trimEnd()), 'the executed seed bytes are preserved');
            const mergedAddition = events.find(e => e.loop === 2 && e.stage === 'writer-addition' && e.status === 'merged');
            assert.equal(mergedAddition.detail.baselineCodeHash, evidenceHash(seed.trimEnd()));
            assert.equal(mergedAddition.detail.addedMethodsCount, 3);
            const noOp = events.find(e => e.loop === 2 && e.stage === 'writer-case' && e.status === 'rejected'
                && e.detail.reasonCode === 'focused-writer-no-new-methods');
            assert.ok(noOp, diagnostic);
            assert.equal(noOp.detail.executionStatus, 'not-run');
            assert.equal(noOp.detail.reviewStatus, 'not-run');
            assert.ok(noOp.sequence < mergedAddition.sequence);
            const noOpArtifacts = events.filter(e => e.loop === 2 && e.stage === 'candidate-artifact'
                && e.status === 'rejected' && e.detail.reasonCode === 'focused-writer-no-new-methods');
            assert.ok(noOpArtifacts.length > 0, 'the rejected no-op addition has a diagnostic artifact');
            assert.ok(noOpArtifacts.every(e => e.detail.gate === 'revision-scope'),
                'a no-op composition failure must retain its revision-scope gate in every artifact');
            assert.equal(events.filter(e => e.loop === 2 && e.stage === 'mutation' && e.status === 'measured').length, 1,
                'the unchanged no-op candidate must not repeat mutation on the baseline');
            for (const item of microtasks.filter(value => !value.noOp)) {
                const rawHash = evidenceHash(extractWriterAdditionCode(item.code));
                const recovered = events.find(e => e.stage === 'candidate-methods' && e.status === 'inventoried'
                    && e.detail.inventoryOrigin === 'ast-single-addition-binding' && e.detail.codeHash === rawHash);
                assert.ok(recovered, diagnostic);
                assert.equal(recovered.detail.methods.length, 1);
                const mergedInventory = events.find(e => e.stage === 'candidate-methods' && e.status === 'inventoried'
                    && e.detail.phase === 'merged' && e.sequence < recovered.sequence
                    && e.detail.methods.some((method: any) => method.id === recovered.detail.methods[0].id));
                assert.ok(mergedInventory, 'the recovered raw method must refer to a method in the actual merged AST');
                const resolved = mergedInventory.detail.methods.find((method: any) => method.id === recovered.detail.methods[0].id);
                assert.equal(recovered.detail.methods[0].fingerprint, resolved.fingerprint,
                    'the raw wrapper hash must not substitute for the AST method fingerprint');
                assert.notEqual(recovered.detail.methods[0].fingerprint, recovered.detail.codeHash);
            }
            assert.equal((code.match(/def test_seed\(/g) || []).length, 1);
            assert.equal((code.match(/def test_/g) || []).length, successfulWrites);
            const methodSummary = summarizeCandidateMethods(events, { runId: events[0].runId,
                sourceHash: events[0].sourceHash, target: 'calculate_bmi', retainedCodeHash: evidenceHash(code) });
            assert.deepEqual(methodSummary.generated, { count: successfulWrites, incomplete: false },
                'every bare microtask method is recovered from the actual merged AST, without counting the baseline again');
            assert.deepEqual(methodSummary.retained, { count: successfulWrites, incomplete: false });
            const hash = evidenceHash(code);
            const approval = events.filter(e => e.stage === 'reviewer' && e.status === 'approved').at(-1);
            const mutation = events.filter(e => e.stage === 'mutation' && e.status === 'measured').at(-1);
            assert.equal(approval.detail.approvedCodeHash, hash);
            assert.equal(knowledge.mutation.testHash, hash);
            assert.equal(evidenceHash(mutation.detail.code), hash);
            assert.ok(approval.sequence < mutation.sequence);
            assert.match(measured.final, /100/);
            assert.equal(fs.readFileSync(file, 'utf8'), source);
            t.diagnostic('Fixed-response BMI pipeline; real ' + engine + '; lines 10/10; mutation '
                + knowledge.mutation.counts.killed + '/' + knowledge.mutation.counts.selected + '; retained methods ' + successfulWrites + '.');
        });
        await t.test('three exact focus cases are authored separately, then approved and mutated as one complete union', () => {
            assert.ok(measured);
            const events = measured.events;
            const firstFocus = microtasks[0].focusId;
            const firstFamily = microtasks.filter(item => item.focusId === firstFocus);
            assert.equal(firstFamily.length, 4, 'the first family has three case additions plus one rejected no-op correction');
            const successful = firstFamily.filter(item => !item.noOp);
            assert.equal(new Set(successful.map(item => item.caseId)).size, 3);
            assert.equal(new Set(successful.map(item => item.methodName)).size, 3, 'each case has an explicit unique new method signature');
            assert.deepEqual(successful.map(item => item.caseId), families.get(successful[0].focusId));
            assert.equal(new Set(successful.map(item => item.focusId)).size, 1);
            for (const [focusId, caseIds] of families) {
                assert.deepEqual(microtasks.filter(item => item.focusId === focusId && !item.noOp).map(item => item.caseId), caseIds,
                    'every later family also preserves every exact observed case in order');
            }
            for (const item of microtasks.filter(value => !value.noOp)) {
                assert.equal((item.code.match(/def test_/g) || []).length, 1);
                assert.equal((item.code.match(/calculate_bmi\(/g) || []).length, 1);
                assert.ok(item.code.includes(item.targetCall));
                assert.ok(item.code.includes(`def ${item.methodName}(self):`));
                assert.notEqual(item.methodName, 'test_seed');
            }
            const composed = events.filter(e => e.loop === 2 && e.stage === 'writer-case' && e.status === 'composed');
            assert.equal(composed.length, 3);
            assert.deepEqual(composed.map(e => e.detail.ordinal), [1, 2, 3]);
            assert.ok(composed.every(e => e.detail.total === 3 && e.detail.executionStatus === 'not-run'
                && e.detail.reviewStatus === 'not-run'));
            const complete = events.find(e => e.loop === 2 && e.stage === 'writer-case' && e.status === 'completed');
            assert.ok(complete && composed.every(e => e.sequence < complete.sequence));
            const approved = events.filter(e => e.loop === 2 && e.stage === 'reviewer' && e.status === 'approved');
            assert.equal(approved.length, 1, 'no subtask borrows an approval or requests its own mutation score');
            assert.ok(complete.sequence < approved[0].sequence);
            const mutation = events.find(e => e.loop === 2 && e.stage === 'mutation' && e.status === 'measured');
            assert.equal(evidenceHash(mutation.detail.code), approved[0].detail.approvedCodeHash);
            const scopes = events.filter(e => e.loop === 2 && e.stage === 'writer-case' && e.status === 'scope-selected');
            assert.deepEqual(scopes.map(e => e.detail.methodName), firstFamily.map(item => item.methodName));
            const deadlines = scopes.filter(e => typeof e.detail.deadlineAt === 'number').map(e => e.detail.deadlineAt);
            assert.equal(new Set(deadlines).size, 1, 'all cases and the no-op correction share the same family deadline');
            assert.equal(fs.readFileSync(file, 'utf8'), source);
        });
        await t.test('external Mutatest provenance is backed by the actual completed run',
            { skip: !hasMutatest && 'Mutatest is not installed; the positive case used the real builtin engine.' }, () => {
                assert.ok(measured);
                assert.equal(measured.knowledge.mutation.engine, 'mutatest');
                assert.equal(measured.knowledge.mutation.status, 'complete');
                assert.ok(measured.knowledge.mutation.counts.executed > 0);
            });
        await t.test('a modified passing seed is rejected before a second execution, review or mutation', async () => {
            scenario = 'modified-baseline'; writers = 0; reviews = 0; qualities = 0; wireRoles.length = 0;
            const outputPath = path.join(root, 'modified-baseline');
            await run({ ...params, maxLoops: 2, outputPath });
            const result = readRun(outputPath);
            const rejections = result.events.filter(e => e.stage === 'writer-case' && e.status === 'rejected');
            assert.equal(rejections.length, 6, 'three bounded primary case attempts in each of Tier 2 and the existing Tier 1 fallback');
            assert.ok(rejections.every(e => e.detail.reasonCode === 'existing-test-method-changed'));
            assert.ok(rejections.every(e => e.detail.ordinal === 1 && e.detail.executionStatus === 'not-run'
                && e.detail.reviewStatus === 'not-run'), 'a failed first case cannot return or execute a partial family');
            const scopes = result.events.filter(e => e.stage === 'writer-case' && e.status === 'scope-selected');
            assert.equal(scopes.length, rejections.length, 'each primary, revision and Tier fallback case attempt retains its recorded scope');
            assert.equal(new Set(scopes.map(e => e.detail.focusId)).size, 1);
            assert.ok(scopes.every(e => typeof e.detail.deadlineAt === 'number'));
            assert.equal(new Set(scopes.map(e => e.detail.deadlineAt)).size, 1,
                'primary and Tier fallback attempts do not renew the same focus and baseline family deadline');
            const revisions = result.events.filter(e => e.stage === 'model-request' && e.status === 'requested'
                && e.detail.role === 'writer-revision' && e.detail.phase !== 'context-qualification');
            assert.ok(revisions.length > 0, 'complete rejected-draft revisions still consume the original target role budget');
            for (const revision of revisions) {
                assert.ok(result.events.some(e => e.sequence > revision.sequence && e.stage === 'candidate-artifact'
                    && e.status === 'rejected' && e.detail.gate === 'revision-scope'
                    && e.detail.reasonCode === 'existing-test-method-changed'),
                'a complete Writer revision remains subject to the exact immutable-baseline scope rejection');
            }
            assert.equal(reviews, 1, 'only the original executed baseline is reviewed');
            assert.equal(result.events.filter(e => e.stage === 'mutation' && e.status === 'measured').length, 1);
            assert.ok(!result.events.some(e => e.loop === 2 && e.stage === 'validation' && e.status === 'passed'));
            const code = fs.readFileSync(path.join(result.directory, result.checkpoint.testFile), 'utf8');
            assert.equal(code, seed.trimEnd());
            assert.notEqual(result.knowledge.terminalStatus, 'passed');
            assert.equal(fs.readFileSync(file, 'utf8'), source);
        });
        await t.test('a focused family Reviewer finding retains its exact draft and repairs against the original approved seed', async () => {
            scenario = 'review-revision'; writers = 0; reviews = 0; qualities = 0; wireRoles.length = 0;
            microtasks.length = 0;
            reviewRevisionRequests = 0; reviewDraft = ''; revisedAddition = ''; reviewFinding = '';
            const outputPath = path.join(root, scenario);
            await run({ ...params, maxLoops: 2, outputPath });
            const result = readRun(outputPath);
            const diagnostic = JSON.stringify({ last: result.knowledge.lastFailure, writers, reviews, reviewRevisionRequests,
                stages: result.events.slice(-30).map(e => [e.stage, e.status, e.detail?.reasonCode]) });
            assert.equal(reviewRevisionRequests, 1, diagnostic);
            assert.equal(reviews, 3, 'seed approval, concrete family finding and independent repaired-family approval');
            assert.equal(writers, 5, 'one seed, three distinct cases and one complete addition revision');
            const revisions = result.events.filter(e => e.stage === 'model-request' && e.status === 'requested'
                && e.detail.role === 'writer-revision' && e.detail.phase !== 'context-qualification');
            assert.equal(revisions.length, 1, diagnostic);
            const scopes = result.events.filter(e => e.stage === 'writer-case' && e.status === 'scope-selected');
            assert.equal(scopes.length, 3, 'the finding revision does not discard feedback or request three fresh microtasks');
            assert.ok(scopes.every(e => e.sequence < revisions[0].sequence));
            const approved = result.events.filter(e => e.loop === 2 && e.stage === 'reviewer' && e.status === 'approved');
            assert.equal(approved.length, 1, diagnostic);
            const mutation = result.events.filter(e => e.loop === 2 && e.stage === 'mutation' && e.status === 'measured');
            assert.equal(mutation.length, 1, diagnostic);
            const code = fs.readFileSync(path.join(result.directory, result.checkpoint.testFile), 'utf8');
            assert.ok(code.startsWith(seed.trimEnd()), 'the original passed seed bytes survive every revision');
            assert.equal((code.match(/def test_/g) || []).length, 4);
            assert.match(code, /self\.assertIsInstance\(calculate_bmi\(/);
            assert.ok(approved[0].sequence > revisions[0].sequence && approved[0].sequence < mutation[0].sequence);
            assert.equal(approved[0].detail.approvedCodeHash, evidenceHash(code));
            assert.equal(result.knowledge.mutation.testHash, evidenceHash(code));
            assert.equal(evidenceHash(mutation[0].detail.code), evidenceHash(code));
            const executed = result.events.filter(e => e.loop === 2 && e.stage === 'scenarios' && e.status === 'observed');
            assert.equal(executed.length, 2, 'the original family and finding repair each execute as complete candidates');
            assert.equal(executed[1].detail.codeHash, evidenceHash(code));
            assert.equal(fs.readFileSync(file, 'utf8'), source);
        });
    } finally {
        setLanguage(originalLanguage); Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
