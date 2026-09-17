import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCompactWriterContext } from '../prompts/compactWriterContext';
import { contextInputBudget, parameterBillions, estimatePromptTokens, promptFits, runtimeContextWindow } from '../prompts/promptBudget';
import { VERIFIED_WRITER_EXAMPLES, matchingWriterExamples } from '../prompts/verifiedWriterExamples';
import { selectPromptDetail } from '../prompts/promptDetailStrategy';
import { WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { getSystemPrompt, getUserPrompt } from '../roles/unittestWriter';
import { parseTestReviewDetailed } from '../roles/testReviewer';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

const bundle: WriterEvidenceBundleV3 = {
    schemaVersion: 'writer-evidence-v3', sourceHash: 'source-v1', semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'source-v1',
        ids: [], selectedRules: [], guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
};

test('1B–13B budgeting uses measured units and keeps compact prompts even with a long context', () => {
    assert.equal(parameterBillions('500M'), 0.5);
    assert.equal(parameterBillions('1.5B'), 1.5);
    assert.equal(parameterBillions('13B（依模型名稱推定）'), undefined);
    for (const size of ['500M', '1B', '2B', '3B', '5B', '13B']) {
        assert.equal(selectPromptDetail(size, 32768, 2), 'small');
        const budget = contextInputBudget(size, 32768);
        const prompt = buildCompactWriterContext({ module: 'sample', name: 'target',
            source: 'def target(value): return value', context: { args: ['value'],
                traceResult: { examples: [{ args: ['1'], result: '1' }], errors: [] } }, evidence: bundle, budgetTokens: budget });
        assert.ok(promptFits(getSystemPrompt(1, 'small'), prompt, budget), size);
    }
    assert.equal(contextInputBudget('500M', 8192), 1800);
    assert.equal(contextInputBudget('13B', 4096), 2867);
    assert.equal(runtimeContextWindow('13B', 4096), 4096);
    assert.ok(runtimeContextWindow('13B', 131072) < 9000);
    assert.ok(contextInputBudget('unknown', NaN) > 0);
    assert.equal(estimatePromptTokens('中文中文'), 4);
});

test('compact Writer preserves full source, class setup, rules, facts and caller-specific oracles', () => {
    const source = 'def send(self, value):\n    return self.client.send(value)';
    const context = { target_import_module: 'pkg.sample', class_name: 'Sender', method_kind: 'instance',
        args: ['value'], signature: [{ name: 'value', required: true }], code: source,
        class_context: { init: { code: 'def __init__(self, client): self.client = client' } },
        traceResult: { examples: [{ args: ['1'], result: '7', constructor_args: ['client'] }], errors: [] },
        dependencyContexts: [{ name: 'helper', code: 'def helper(): return 8', sourceHash: 'helper-v1' }] };
    const evidence = { ...bundle, mergedTargetObservations: { func_name: 'send', args: [],
        examples: [{ args: ['999'], result: 'DO_NOT_LEAK_OTHER_CALLER' }], errors: [], load_error: null } };
    const prompt = getUserPrompt('sample.py', 'send', source, 'small', context, '', 6000, '', evidence);
    assert.match(prompt, /^compact-writer-v1/);
    assert.ok(prompt.includes(source));
    assert.ok(prompt.includes('from pkg.sample import Sender'));
    assert.ok(prompt.includes('constructor_args'));
    assert.ok(prompt.includes('def __init__'));
    assert.ok(prompt.includes('helper-v1'));
    assert.doesNotMatch(prompt, /DO_NOT_LEAK_OTHER_CALLER/);
    assert.match(prompt, /never copy its target, inputs or expected values/);
});

test('budget pressure drops whole optional snippets and examples before required evidence', () => {
    const source = 'def target(value):\n    return value';
    const huge = 'def helper():\n    ' + 'return 1 #'.repeat(2000);
    const context = { args: ['value'], calls: ['helper'], traceResult: { examples: [{ args: ['1'], result: '1' }] },
        dependencyContexts: [{ name: 'helper', code: huge }] };
    const prompt = buildCompactWriterContext({ module: 'sample', name: 'target', source,
        context, evidence: bundle, budgetTokens: 1000 });
    assert.ok(prompt.includes(source));
    assert.match(prompt, /"result":"1"/);
    assert.doesNotMatch(prompt, /def helper|VERIFIED PATTERN/);
    assert.match(prompt, /source omitted as whole units/);
    assert.equal((prompt.match(/```/g) || []).length % 2, 0);
    const tooLarge = buildCompactWriterContext({ module: 'sample', name: 'target', source: huge,
        context, evidence: bundle, budgetTokens: 1000 });
    assert.ok(tooLarge.includes(huge));
    assert.equal(promptFits(getSystemPrompt(1, 'small'), tooLarge, 1000), false);
});

test('feature retrieval selects at most two matching neutral examples and none for a pure function', () => {
    assert.deepEqual(matchingWriterExamples({}), []);
    assert.equal(matchingWriterExamples({ is_async: true })[0].id, 'async-boundary-v1');
    assert.equal(matchingWriterExamples({ calls: ['db.connect'], file_imports: [{ module: 'sqlite3', alias: 'db' }] })[0].id, 'sqlite-context-v1');
    assert.deepEqual(matchingWriterExamples({ calls: ['len'], file_imports: [{ module: 'sqlite3' }] }), []);
    assert.deepEqual(matchingWriterExamples({ class_name: 'C', method_kind: 'static' }), []);
    assert.equal(matchingWriterExamples({ is_async: true, class_name: 'C', calls: ['read'] }).length, 2);
});

test('legacy large-context prompts also omit whole dependencies instead of misleading return-only fragments', () => {
    const helper = 'def helper(value):\n' + '    # long context\n'.repeat(100) + '    return value';
    const prompt = getUserPrompt('sample.py', 'target', 'def target(value): return helper(value)', 'large', {
        args: ['value'], dependencyContexts: [{ name: 'helper', code: helper }]
    }, '', 900);
    assert.doesNotMatch(prompt, /Key lines:|code too long, mock it|def helper\(value\):/);
    assert.match(prompt, /source omitted as a whole unit/);
});

test('every curated Writer example executes a real unittest and passes structural safety checks', () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    for (const example of VERIFIED_WRITER_EXAMPLES) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-example-'));
        try {
            fs.writeFileSync(path.join(directory, 'example_target.py'), example.source);
            fs.writeFileSync(path.join(directory, 'generated_test.py'), example.tests);
            const validation = validateUnittestStructure(example.tests);
            assert.ok(validation.valid, `${example.id}: ${validation.reason}`);
            const run = spawnSync(python, ['-B', '-m', 'unittest', 'generated_test'], { cwd: directory, encoding: 'utf8', timeout: 10000 });
            assert.equal(run.status, 0, `${example.id}: ${run.stderr}`);
            assert.match(run.stderr, /Ran 1 test/);
            assert.equal(fs.existsSync(path.join(directory, 'example.db')), false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
});

test('Reviewer rejects with stable reason codes without leaking response text or weakening review-v4', () => {
    const item = { test_excerpt: 'target()', reason: 'The target is not awaited.', action: 'Await target() inside an async test method.' };
    const wrap = (value: unknown) => JSON.stringify({ blocking: [value], quality: [] });
    const checks: Array<[string, string]> = [
        ['not JSON', 'invalid-json'], [JSON.stringify({ approval: true }), 'invalid-envelope'],
        [JSON.stringify({ blocking: Array(6).fill(item), quality: [] }), 'too-many-findings'],
        [wrap({ ...item, test_excerpt: 'PRIVATE_OTHER_SOURCE' }), 'excerpt-not-in-test'],
        [wrap({ ...item, reason: '' }), 'non-actionable-reason'],
        [wrap({ ...item, action: 'fix it' }), 'non-actionable-action'],
        [wrap({ ...item, action: item.reason }), 'duplicate-reason-action']
    ];
    for (const [raw, expected] of checks) {
        const result = parseTestReviewDetailed(raw, 'target()');
        assert.equal(result.review, undefined);
        assert.deepEqual(result.diagnostics, [expected]);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OTHER_SOURCE/);
    }
    assert.equal(parseTestReviewDetailed(wrap(item), 'target()').review?.issues.length, 1);
});
