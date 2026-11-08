import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { ollamaRuntimeMetadataFixture, readOllamaRoleRequest } from './ollamaRequestFixture';
import { runSpawn } from '../utils/processRunner';
import { testCodeBasis } from './reviewBasisFixture';
import { classifyOutcomeTier } from '../pipeline/resultPresentation';
import { pythonToolPath } from '../pipeline/pythonTools';

interface HtmlEscapeReviewerFixture {
    target: string;
    module: string;
    seedCode: string;
    reviewerResponse: {
        findings: Array<{
            category: string;
            test_line: string;
            reason: string;
            action: string;
            basis: { kind: string; ref: string; field: string; value: string };
        }>;
    };
    writerRevisedCode: string;
}

test('PR #3 integration: retained baseline mutation on blocked expansion, html_escape basis-format suggestion handoff, and retained mutation error reporting', async t => {
    const temp = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temp, 'pr3-tiered-integration-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const repoRoot = path.resolve(__dirname, '../..');
    const htmlEscapeFixturePath = path.join(
        repoRoot,
        'test',
        'fixtures',
        'eval_screening',
        'gpt_oss20b',
        'bottle_utils_9e53c6fc',
        'html_escape_6d4c4a8f',
        'reviewer_response_fixture.json'
    );
    const htmlEscapeFixture = JSON.parse(fs.readFileSync(htmlEscapeFixturePath, 'utf8')) as HtmlEscapeReviewerFixture;

    const classifyFile = path.join(root, 'sample_classify.py');
    const classifySource = [
        'def classify(value):',
        '    if value > 0:',
        '        return "positive"',
        '    return "non-positive"',
        ''
    ].join('\n');
    fs.writeFileSync(classifyFile, classifySource, 'utf8');

    const bottleFile = path.join(root, 'bottle_utils.py');
    const bottleSource = [
        'def html_escape(string):',
        '    """Escape HTML special characters ``&<>"`` and quotes ``\'``."""',
        '    return (string.replace("&", "&amp;")',
        '                  .replace("<", "&lt;")',
        '                  .replace(">", "&gt;")',
        '                  .replace(\'"\', "&quot;")',
        '                  .replace("\'", "&#039;"))',
        ''
    ].join('\n');
    fs.writeFileSync(bottleFile, bottleSource, 'utf8');

    const buildInputs = async (sourceFile: string, target: string, argsLiterals: string, outName: string) => {
        const res = await runSpawn(python, [
            '-B',
            path.resolve(__dirname, '../../python_scripts/probe_fixture_builder.py'),
            '--root', root,
            '--file', sourceFile,
            '--target', target
        ], {
            input: JSON.stringify({ cases: [{ args_literals: argsLiterals }] }),
            timeout: 5000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        assert.equal(res.code, 0, res.stderr);
        fs.writeFileSync(path.join(root, outName), res.stdout, 'utf8');
    };

    await buildInputs(classifyFile, 'classify', '[1]', 'inputs_classify.json');
    await buildInputs(bottleFile, 'html_escape', "['']", 'inputs_bottle.json');

    const Module = require('module');
    const originalLoad = Module._load;
    const originalFetch = globalThis.fetch;
    const runner = require('../utils/processRunner');
    const originalRunSpawn = runner.runSpawn;
    const handlers = new Map<string, (...args: any[]) => any>();

    let activeInputsFile = 'inputs_classify.json';
    let scenario: 'deleted-passing-method' | 'retained-mutation-error' | 'html-escape-repeated-basis' = 'deleted-passing-method';
    let writerCalls = 0;
    let reviewerCalls = 0;
    const writerPrompts: string[] = [];

    const vscode = {
        ExtensionMode: { Development: 2, Test: 3 },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: root } }],
            getConfiguration: () => ({
                get: (key: string, fallback: unknown) =>
                    key === 'pythonPath' ? python
                        : key === 'runtimeContextTokens' ? 8192
                        : key === 'probeInputFile' ? activeInputsFile
                        : fallback
            }),
            openTextDocument: async () => ({})
        },
        window: {
            registerWebviewViewProvider: (_: string, provider: any) => {
                provider.webview = { postMessage: async () => true };
                return { dispose() {} };
            },
            showInformationMessage: async () => {},
            showTextDocument: async () => {}
        },
        commands: {
            registerCommand: (name: string, handler: (...args: any[]) => any) => {
                handlers.set(name, handler);
                return { dispose() {} };
            }
        }
    };

    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };

    runner.runSpawn = async (...args: any[]) => {
        if (scenario === 'retained-mutation-error' && Array.isArray(args[1])
            && args[1].some((arg: string) => arg === pythonToolPath('mutation'))) {
            return { code: 2, stdout: JSON.stringify({ error: 'external-engine-execution-failed',
                diagnosticCode: 'adapter-execution-failed' }), stderr: 'simulated retained mutation engine crash' };
        }
        return originalRunSpawn(...args);
    };

    globalThis.fetch = async (url, options) => {
        const metadata = ollamaRuntimeMetadataFixture(url, options, {
            modelName: 'pr3-fixture-model',
            contextLength: 16384,
            observedContextTokens: 8192
        });
        if (metadata) { return metadata; }
        const request = readOllamaRoleRequest(JSON.parse(String(options?.body)));
        let response: string;
        if (request.roleInstructions.includes('dependency_behaviors')) {
            response = JSON.stringify({
                test_strategy: { approach: 'Exercise the observed seed case and expand branch/character coverage.' }
            });
        } else if (request.isReviewer) {
            reviewerCalls++;
            if (scenario === 'html-escape-repeated-basis') {
                response = JSON.stringify(htmlEscapeFixture.reviewerResponse);
            } else {
                // Return both a missing-scenario and an assertion-quality finding with valid testCodeBasis
                // so Writer revision runs full-file expansion where deleting test_seed triggers passing-test-removed.
                response = JSON.stringify({
                    findings: [
                        {
                            category: 'missing-scenario',
                            test_line: 'L5',
                            basis: testCodeBasis(5),
                            reason: 'Only positive branch is tested; non-positive branch is missing.',
                            action: 'Add a test method for classify(0).'
                        },
                        {
                            category: 'assertion-quality',
                            test_line: 'L5',
                            basis: testCodeBasis(5),
                            reason: 'Keep the positive branch assertion explicit.',
                            action: 'Verify classify(1) == "positive" alongside the new negative test.'
                        }
                    ]
                });
            }
        } else {
            writerCalls++;
            writerPrompts.push(request.prompt);
            if (scenario === 'html-escape-repeated-basis') {
                if (writerCalls === 1) {
                    response = '```python\n' + htmlEscapeFixture.seedCode.trim() + '\n```';
                } else {
                    response = [
                        '```python',
                        'class GeneratedSeedTests(unittest.TestCase):',
                        '    def test_special_characters(self):',
                        '        self.assertEqual(html_escape(\'&<>"\\\'\'), \'&amp;&lt;&gt;&quot;&#039;\')',
                        '```'
                    ].join('\n');
                }
            } else if (writerCalls === 1) {
                response = [
                    '```python',
                    'import unittest',
                    'from sample_classify import classify',
                    'class Cases(unittest.TestCase):',
                    '    def test_seed(self):',
                    '        self.assertEqual(classify(1), "positive")',
                    '```'
                ].join('\n');
            } else {
                // Writer expansion deletes the already-passing test_seed method!
                response = [
                    '```python',
                    'import unittest',
                    'from sample_classify import classify',
                    'class Cases(unittest.TestCase):',
                    '    def test_non_positive_only(self):',
                    '        self.assertEqual(classify(0), "non-positive")',
                    '```'
                ].join('\n');
            }
        }
        return new Response(JSON.stringify({ response, done: true, done_reason: 'stop' }), { status: 200 });
    };

    try {
        require('../orchestrator').activate({
            extension: { id: 'fixture', packageJSON: { version: '0.0.1' } },
            extensionMode: 3,
            globalState: { get: () => undefined, update: async () => {} },
            secrets: {},
            subscriptions: []
        });

        await t.test('(a) seed passes -> Writer expansion deletes passing method and is blocked -> retained baseline has mutation score and tier usable', async () => {
            scenario = 'deleted-passing-method';
            activeInputsFile = 'inputs_classify.json';
            writerCalls = 0;
            reviewerCalls = 0;
            writerPrompts.length = 0;
            const output = path.join(root, 'out-deleted-passing-method');

            await handlers.get('llm-unit-test.runCaptureAndTest')!({
                envType: 'local',
                modelName: 'pr3-fixture-model',
                stopPolicy: { failureLimit: 3 },
                filePath: classifyFile,
                funcName: 'classify',
                promptStrategy: 'tier1',
                validationMode: 'full',
                maxLoops: 1,
                timeoutSeconds: 45,
                mutationEngine: 'builtin',
                mutpyTimeout: 20,
                outputPath: output
            });

            const files = fs.readdirSync(output, { recursive: true }).map(String);
            const events = files
                .filter(name => path.basename(name) === 'role_events.jsonl')
                .flatMap(name => fs.readFileSync(path.join(output, name), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
            const knowledgeFile = files.find(name => path.basename(name) === 'function_knowledge.json');
            assert.ok(knowledgeFile);
            const knowledge = JSON.parse(fs.readFileSync(path.join(output, knowledgeFile), 'utf8'));

            assert.ok(events.some(event => event.stage === 'passing-tests' && event.status === 'preservation-rejected'
                && event.detail.reasonCode === 'removed-passing-method'),
                JSON.stringify({ terminalStatus: knowledge.terminalStatus, failure: knowledge.failure, failureStage: knowledge.failureStage,
                    events: events.slice(-20) }));
            assert.equal(knowledge.failureStage, 'repair-scope');
            assert.ok(events.some(event => event.stage === 'mutation' && event.status === 'measured'),
                'retained seed baseline must run real mutation measurement');
            assert.equal(typeof knowledge.mutationScore, 'number');
            assert.equal(knowledge.mutationStatus, 'complete');
            assert.equal(classifyOutcomeTier(knowledge), 'usable');
        });

        await t.test('(b) html_escape Reviewer fixture via formal command: passes special-char suggestion to Writer prompt without exhausting failure budget, stops after 1 revision as usable', async () => {
            scenario = 'html-escape-repeated-basis';
            activeInputsFile = 'inputs_bottle.json';
            writerCalls = 0;
            reviewerCalls = 0;
            writerPrompts.length = 0;
            const output = path.join(root, 'out-html-escape');

            await handlers.get('llm-unit-test.runCaptureAndTest')!({
                envType: 'local',
                modelName: 'pr3-fixture-model',
                stopPolicy: { failureLimit: 2 },
                filePath: bottleFile,
                funcName: 'html_escape',
                promptStrategy: 'tier1',
                validationMode: 'full',
                maxLoops: 1,
                timeoutSeconds: 45,
                mutationEngine: 'builtin',
                mutpyTimeout: 20,
                outputPath: output
            });

            const files = fs.readdirSync(output, { recursive: true }).map(String);
            const events = files
                .filter(name => path.basename(name) === 'role_events.jsonl')
                .flatMap(name => fs.readFileSync(path.join(output, name), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
            const knowledgeFile = files.find(name => path.basename(name) === 'function_knowledge.json');
            assert.ok(knowledgeFile);
            const knowledge = JSON.parse(fs.readFileSync(path.join(output, knowledgeFile), 'utf8'));

            assert.equal(writerCalls, 2, 'Writer is called once for seed and at most once for the basis-format suggestion');
            assert.equal(reviewerCalls, 2, 'Reviewer is not retried for contract repair; called once on seed and once on revised candidate');
            assert.match(writerPrompts[1], /missing scenario for non-empty string with special characters/,
                'the special-character scenario suggestion from html_escape Reviewer fixture must appear in Writer prompt');
            const reviews = events.filter(event => event.stage === 'reviewer' && event.status === 'assessed')
                .map(event => event.detail.review);
            assert.ok(reviews[0].basisFormatDiagnostics?.length, 'the original fixture has a basis-format diagnostic');
            assert.ok(reviews[1].basisFormatDiagnostics?.length, 'the second review still has a basis-format diagnostic');
            assert.equal(knowledge.failureCount, 0, 'basis-format suggestions must not deduct or exhaust the failure budget through artifact hooks');
            assert.ok(events.some(event => event.stage === 'reviewer' && event.status === 'suggestion-stopped'),
                'stops after one Writer revision when the next review still has a basis-format finding');
            assert.equal(knowledge.reviewStatus, 'incomplete');
            assert.equal(knowledge.terminalStatus, 'execution-passed-review-incomplete');
            assert.equal(typeof knowledge.mutationScore, 'number');
            assert.equal(classifyOutcomeTier(knowledge), 'usable', 'retained candidate with incomplete review is usable, never quality-passed');
            assert.notEqual(classifyOutcomeTier(knowledge), 'quality-passed');
        });

        await t.test('(c) retained baseline mutation failure records mutation/retained-measurement-failed event and renders reason in final_report.md', async () => {
            scenario = 'retained-mutation-error';
            activeInputsFile = 'inputs_classify.json';
            writerCalls = 0;
            reviewerCalls = 0;
            writerPrompts.length = 0;
            const output = path.join(root, 'out-retained-mutation-error');

            await handlers.get('llm-unit-test.runCaptureAndTest')!({
                envType: 'local',
                modelName: 'pr3-fixture-model',
                stopPolicy: { failureLimit: 3 },
                filePath: classifyFile,
                funcName: 'classify',
                promptStrategy: 'tier1',
                validationMode: 'full',
                maxLoops: 1,
                timeoutSeconds: 45,
                mutationEngine: 'builtin',
                mutpyTimeout: 20,
                outputPath: output
            });

            const files = fs.readdirSync(output, { recursive: true }).map(String);
            const events = files
                .filter(name => path.basename(name) === 'role_events.jsonl')
                .flatMap(name => fs.readFileSync(path.join(output, name), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
            const failedMutEvent = events.find(event => event.stage === 'mutation' && event.status === 'retained-measurement-failed');
            assert.ok(failedMutEvent, JSON.stringify(events.slice(-20)));
            assert.equal(typeof failedMutEvent.detail.category, 'string');
            assert.match(String(failedMutEvent.detail.reason), /exitCode=2; adapter-execution-failed/);

            const finalReportFile = files.find(name => path.basename(name) === 'final_report.md');
            assert.ok(finalReportFile);
            const finalReport = fs.readFileSync(path.join(output, finalReportFile), 'utf8');
            assert.match(finalReport, /尚未完成有效測量.*exitCode=2; adapter-execution-failed/,
                'final_report.md must display the reason why there is no mutation score');
        });
    } finally {
        globalThis.fetch = originalFetch;
        Module._load = originalLoad;
        runner.runSpawn = originalRunSpawn;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
