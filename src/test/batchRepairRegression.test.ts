import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { exceptionNamesFromEvidence } from '../validation/exceptionEvidence';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canRepairTestMethod, failedTestNamesFromOutput, mergeBugFixReplacement } from '../roles/bugFixer';
import { CandidatePipelineHooks, validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { parseTestReviewDetailed, REVIEW_CATEGORIES, REVIEW_FINDING_LIMIT } from '../roles/testReviewer';
import { getCustomChatCompletionText, responseSchemaForOutputFormat } from '../llm/customApi';
import { preflightTargetModule } from '../pipeline/modulePreflight';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { AnalysisJournal } from '../pipeline/analysisJournal';
import { parseQualityTasks } from '../roles/qualityAnalyst';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { appendVerifiedTraceTestFile } from '../tier/traceTestAugmenter';
import { validateUnittestStructure } from '../validation/generatedTestValidator';
import { pythonToolPath } from '../pipeline/pythonTools';
import { repairFailureKey } from '../validation/repairFeedback';
import { getBugFixerSystemPrompt } from '../roles/bugFixer';
import { getTestRuleCards } from '../prompts/testRuleLibrary';

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const code = 'import unittest\nclass Cases(unittest.TestCase):\n    def test_alpha(self):\n        self.assertTrue(False)\n    def test_beta(self):\n        self.assertTrue(True)\n';
const one = 'FAIL: test_alpha (suite.Cases.test_alpha)\nAssertionError: wrong';
const many = one + '\nFAIL: test_beta (suite.Cases.test_beta)\nAssertionError: wrong';
const success = { ok: true, out: 'test_alpha (Cases.test_alpha) ... ok', qualityGaps: [] };
const hooks = (overrides: Partial<CandidatePipelineHooks>): CandidatePipelineHooks => ({
    validate: async () => undefined, review: async () => ({ issues: [] }),
    execute: async () => success, revise: async () => code, event: () => {}, checkCancelled: () => {}, ...overrides
});

test('typed provider reasoning and unknown segments never become generated code', () => {
    assert.equal(getCustomChatCompletionText({ choices: [{ finish_reason: 'length', message: { content: 'partial code' } }] }), undefined);
    assert.equal(getCustomChatCompletionText({ choices: [{ message: { content: [
        { type: 'reasoning', text: 'not code' }, { type: 'unknown', text: 'not code either' },
        { type: 'text', text: 'import unittest\n' }, { type: 'output_text', text: 'class Cases: pass' }
    ] } }] }), 'import unittest\nclass Cases: pass');
});

test('quality tasks retain comparison evidence while rejecting unfilled template fields', () => {
    const evidence = 'survivor: < changed to >';
    const task = { evidence, hypothesis: 'values < 0 and > 1 need distinction', scenario: 'exercise both branches', verification: 'compare measured original and mutant output' };
    assert.equal(parseQualityTasks(JSON.stringify({ tasks: [task] }), evidence)?.length, 1);
    assert.equal(parseQualityTasks(JSON.stringify({ tasks: [{ ...task, scenario: '<scenario>' }] }), evidence), undefined);
});

test('executed coroutine and bounded generator Trace files remain safe after augmentation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-helper-imports-'));
    try {
        for (const [index, source, asyncTarget] of [
            [0, 'async def target(value):\n    if value < 0: raise ValueError()\n    return value + 1\n', true],
            [1, 'def target(value):\n    yield from range(value)\n', false],
            [2, 'async def target(value):\n    for n in range(value):\n        yield n\n', false],
            [3, 'class Finished(Exception): pass\ndef target(value):\n    if value < 0: raise Finished()\n    return value\n', false]
        ] as const) {
            const module = `sample${index}`;
            const file = path.join(directory, module + '.py');
            fs.writeFileSync(file, source);
            const trace = spawnSync(python, ['-B', pythonToolPath('trace'), file, 'target', '[[2],[-1]]'], { encoding: 'utf8', timeout: 10000 });
            assert.equal(trace.status, 0, trace.stderr);
            const facts = JSON.parse(trace.stdout);
            const built = buildTier1TestFile({ moduleName: module, functionName: 'target',
                examples: index === 1 ? facts.examples.map((example: object) => ({ ...example, result_truncated: true, result_collection_limit: 2 })) : facts.examples,
                errors: facts.errors, isAsync: asyncTarget });
            assert.ok(built.code, `fixture ${index}: expected assertable executed observations`);
            const merged = appendVerifiedTraceTestFile(built.code, built.code, built.methodCount, 'target').code;
            assert.doesNotMatch(merged, /__import__\s*\(/);
            const structure = validateUnittestStructure(merged, 'target', module, 'call', exceptionNamesFromEvidence({ traceResult: facts }));
            assert.equal(structure.valid, true, `fixture ${index}: ${structure.reason}`);
            const binding = spawnSync(python, [pythonToolPath('bindings'), '--payload'], { encoding: 'utf8',
                input: JSON.stringify({ code: merged, context: { module, target: 'target', source, dependencies: {} } }) });
            assert.equal(JSON.parse(binding.stdout).valid, true, binding.stdout);
            fs.writeFileSync(path.join(directory, `case${index}.py`), merged);
            const executed = spawnSync(python, ['-B', '-m', 'unittest', `case${index}`], { cwd: directory, encoding: 'utf8', timeout: 10000 });
            assert.equal(executed.status, 0, executed.stdout + executed.stderr);
            assert.match(executed.stderr, /Ran [1-9]\d* tests?/);
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('async property Trace imports are local and execute before asserting the observed value', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'async-property-trace-'));
    try {
        fs.writeFileSync(path.join(directory, 'sample.py'), 'class Widget:\n    @property\n    async def value(self):\n        return 3\n');
        const built = buildTier1TestFile({ moduleName: 'sample', functionName: 'value', className: 'Widget',
            methodKind: 'property', isAsync: true, examples: [{ args: [], result: '3', result_type: 'int' }], errors: [] });
        assert.ok(built.code);
        assert.doesNotMatch(built.code, /__import__\s*\(/);
        assert.equal(validateUnittestStructure(built.code, 'value', 'sample', 'property', [], 'Widget').valid, true);
        fs.writeFileSync(path.join(directory, 'baseline_test.py'), built.code);
        const run = spawnSync(python, ['-B', '-m', 'unittest', 'baseline_test'], { cwd: directory, encoding: 'utf8', timeout: 10000 });
        assert.equal(run.status, 0, run.stdout + run.stderr);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('method repair requires exactly one real unittest failure, never traceback prose or fixture errors', () => {
    assert.equal(canRepairTestMethod(code, one), true);
    for (const failure of [many, 'Traceback: in test_alpha\nValueError: wrong', one + '\nin setUp\nValueError: fixture', 'ERROR: setUpClass (Cases)']) {
        assert.equal(canRepairTestMethod(code, failure), false);
        assert.equal(mergeBugFixReplacement(JSON.stringify({ method: 'test_alpha', replacement: 'def test_alpha(self):\n    self.assertTrue(True)', imports: [] }), code, failure), undefined);
    }
    assert.deepEqual(failedTestNamesFromOutput('test_alpha (suite.Cases.test_alpha) ... FAIL\r\n' + one), ['test_alpha']);
});

test('multiple failures route to Writer and failing candidates consume no Reviewer requests', async () => {
    const order: string[] = [];
    const result = await validateTestCandidate(code, hooks({
        execute: async value => { order.push('execute'); return value === code ? { ok: false, out: many, qualityGaps: [] } : success; },
        repairRole: (value, failure) => canRepairTestMethod(value, failure) ? 'bug-fixer' : 'writer',
        revise: async (_, failure, role) => { order.push(role); assert.match(failure, /test_alpha/); assert.match(failure, /test_beta/); return code + '\n# fixed'; },
        review: async () => { order.push('review'); return { issues: [] }; }
    }));
    assert.equal(result.reviewStatus, 'completed');
    assert.deepEqual(order, ['execute', 'writer', 'execute', 'review']);
});

test('same repair failure with changed unittest timing and stack line numbers consumes only one Bug Fixer request', async () => {
    const failure = (line: number, elapsed: number) => `ERROR: test_alpha (suite.Cases.test_alpha)\nTraceback (most recent call last):\n  File "sample_test.py", line ${line}, in test_alpha\n    target()\nTypeError: context protocol\nRan 1 test in ${elapsed}s\nFAILED (errors=1)`;
    assert.equal(repairFailureKey(failure(19, 0.096)), repairFailureKey(failure(20, 0.090)));
    assert.notEqual(repairFailureKey(failure(19, 0.096)), repairFailureKey(failure(19, 0.096).replace('TypeError: context protocol', 'ValueError: bad input')));
    let executions = 0;
    let revisions = 0;
    await assert.rejects(validateTestCandidate(code, hooks({
        execute: async () => ({ ok: false, out: failure(19 + executions++, 0.08 + executions / 1000), qualityGaps: [] }),
        repairRole: () => 'bug-fixer',
        revise: async () => `${code}\n# revision ${++revisions}`
    }), 3), /已處理過相同失敗/);
    assert.equal(revisions, 1);
    for (const guidance of [getBugFixerSystemPrompt(), ...getTestRuleCards(['async_context_manager_testing', 'http_client_mocking']).map(card => card.rules.join('\n'))]) {
        assert.match(guidance, /MagicMock/);
        assert.match(guidance, /AsyncMock/);
    }
});

test('repeated Writer candidates retain the latest blocking finding and do not run or review twice', async () => {
    const inputs: string[] = [];
    let executions = 0;
    let reviews = 0;
    await assert.rejects(validateTestCandidate(code, hooks({
        execute: async () => { executions++; return success; },
        review: async () => { reviews++; return { issues: [{ id: 'B1', severity: 'blocking', evidence: 'self.assertTrue', reason: 'wrong observation', action: 'keep the observed boolean identity' }] }; },
        revise: async (_, failure) => { inputs.push(failure); return code; }
    })), /keep the observed boolean identity/);
    assert.equal(inputs.length, 2);
    inputs.forEach(input => assert.match(input, /keep the observed boolean identity/));
    assert.equal(executions, 1);
    assert.equal(reviews, 1);
});

test('review-v5 has one shared total limit and derives blocking versus quality from category', () => {
    const schema: any = responseSchemaForOutputFormat('review-json');
    assert.deepEqual(schema.required, ['findings']);
    assert.equal(schema.properties.findings.maxItems, REVIEW_FINDING_LIMIT);
    assert.deepEqual(schema.properties.findings.items.properties.category.enum, Object.keys(REVIEW_CATEGORIES));
    const finding = { category: 'missing-scenario', test_excerpt: 'self.assertTrue(False)', reason: 'an empty input case is absent', action: 'add an empty input case using verified observations' };
    for (const category of ['missing-scenario', 'typing-style', 'assertion-quality']) {
        const parsed = parseTestReviewDetailed(JSON.stringify({ findings: [{ ...finding, category }] }), code, true);
        assert.equal(parsed.review?.issues[0].severity, 'quality');
    }
    for (const category of ['setup-error', 'target-binding', 'assertion-evidence', 'mock-isolation']) {
        assert.equal(parseTestReviewDetailed(JSON.stringify({ findings: [{ ...finding, category }] }), code, true).review?.issues[0].severity, 'blocking');
    }
    const parse = (value: unknown) => parseTestReviewDetailed(JSON.stringify(value), code, true);
    assert.deepEqual(parse({ findings: Array(6).fill(finding) }).diagnostics, ['too-many-findings']);
    assert.equal(parse({ findings: [{ ...finding, category: 'invented' }] }).review, undefined);
    assert.equal(parse({ findings: [{ ...finding, severity: 'blocking' }] }).review, undefined);
    assert.equal(parse({ findings: [{ ...finding, test_excerpt: 'not in tests' }] }).review, undefined);
    assert.equal(parse({ blocking: [], quality: [] }).review, undefined, 'old probes cannot certify the new contract');
    assert.equal(parse({ findings: [{ ...finding,
        reason: 'The tests cover values < 0, 0 <= value <= 100, and > 100, but the explicit upper boundary is missing.'
    }] }).review?.issues[0].severity, 'quality', 'comparison operators are not template placeholders');
    for (const reason of ['<reason>', '<exact reason>', '< 待填內容 >']) {
        assert.equal(parse({ findings: [{ ...finding, reason }] }).review, undefined);
    }
});

test('Python scope gate rejects multi-failure, unlocated, unrelated and non-body modifications', () => {
    const candidate = code.replace('self.assertTrue(False)', 'self.assertFalse(False)');
    const validate = (value: string, failure: string) => {
        const run = spawnSync(python, ['-B', path.join(root, 'python_scripts/validate_repair_scope.py')], {
            encoding: 'utf8', input: JSON.stringify({ previous: code, candidate: value, failure })
        });
        assert.equal(run.status, 0, run.stderr);
        return JSON.parse(run.stdout).valid;
    };
    assert.equal(validate(candidate, one), true);
    assert.equal(validate(candidate, many), false);
    assert.equal(validate(candidate, 'unidentified error'), false);
    assert.equal(validate(candidate.replace('class Cases(unittest.TestCase):', 'class Cases(unittest.TestCase):\n    value = 42'), one), false);
    assert.equal(validate(candidate.replace('test_alpha(self)', 'test_alpha(self, missing)'), one), false);
    assert.equal(validate(candidate.replace('self.assertTrue(True)', 'self.assertFalse(True)'), one), false);
    assert.equal(validate('from arbitrary import unittest\n' + candidate, one), false);
    assert.equal(validate('from arbitrary import *\n' + candidate, one), false);
});

test('preflight resolves nested absolute/relative imports and package initializers from real loaded origins', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-dependencies-'));
    try {
        const project = path.join(directory, 'component');
        const pkg = path.join(project, 'pkg');
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, '__init__.py'), 'def exported(value): return value + 2\n');
        fs.writeFileSync(path.join(pkg, 'helper.py'), 'def normalize(value): return value + 1\n');
        const file = path.join(pkg, 'service.py');
        fs.writeFileSync(file, 'from pkg.helper import normalize\nfrom . import exported\ndef target(value): return normalize(exported(value))\n');
        const dependencies = [{ module: 'pkg.helper', name: 'normalize' }, { module: '', name: 'exported', level: 1 }];
        const result = await preflightTargetModule(python, file, 'pkg.service', [project, directory], directory, dependencies, directory);
        assert.equal(result.dependencies?.[0].file && fs.realpathSync(result.dependencies[0].file), fs.realpathSync(path.join(pkg, 'helper.py')));
        assert.equal(result.dependencies?.[1].file && fs.realpathSync(result.dependencies[1].file), fs.realpathSync(path.join(pkg, '__init__.py')));
        const restricted = await preflightTargetModule(python, file, 'pkg.service', [project], directory, dependencies, path.join(directory, 'unrelated'));
        assert.ok(restricted.dependencies?.every(item => item.reason === 'outside-selected-source-tree'));
        fs.writeFileSync(path.join(pkg, 'helper.py'), 'from pkg import exported as normalize\n');
        const rebound = await preflightTargetModule(python, file, 'pkg.service', [project], directory, dependencies, directory);
        assert.equal(rebound.dependencies?.[0].reason, 'reexported-or-rebound-function');
        fs.writeFileSync(path.join(pkg, 'helper.py'), 'def normalize(value): return value + 1\n');
        fs.unlinkSync(path.join(pkg, '__init__.py'));
        fs.writeFileSync(file, 'from pkg.helper import normalize\ndef target(value): return normalize(value)\n');
        const namespace = await preflightTargetModule(python, file, 'pkg.service', [project], directory, dependencies.slice(0, 1), directory);
        assert.ok(namespace.dependencies?.[0].file?.endsWith('helper.py'));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('timeout and retained baseline preserve first/last failure even without a failed-suffix event', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-error-'));
    try {
        const journal = new AnalysisJournal(directory, 'source', 'target', 'fixture');
        journal.record(2, 'model-request', 'error', { category: 'timeout', reason: 'request deadline' });
        journal.record(2, 'pipeline', 'retained-baseline', { category: 'timeout', reason: 'retained after deadline' });
        const state = JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8'));
        assert.equal(state.firstFailure.stage, 'model-request');
        assert.equal(state.firstFailure.category, 'timeout');
        assert.equal(state.lastFailure.reason, 'retained after deadline');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
