import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getBugFixerUserPrompt, getReviewEvidence } from '../roles/bugFixer';
import { fitReviewPrompt, getTestReviewerSystemPrompt } from '../roles/testReviewer';
import { promptFits } from '../prompts/promptBudget';

const code = 'import unittest\nfrom sample import read_rows\nclass TestRows(unittest.TestCase):\n    def test_empty(self):\n        self.assertEqual(read_rows(), [])\n';
const failure = 'FAIL: test_empty (suite.TestRows.test_empty)\nAssertionError: mismatch';
const source = 'def read_rows():\n    return store.read_rows()\n';

function context(): any {
    return { code: source, args: [], file_imports: [
        { kind: 'import', module: 'storage', alias: 'store' },
        ...Array.from({ length: 80 }, (_, i) => ({ kind: 'from', module: 'ui.controls', name: `UnusedControl${i}`, bound_name: `UnusedControl${i}` }))
    ], dependencyContexts: [{ name: 'storage.read_rows', code: 'def read_rows():\n    return []\n',
        sourceHash: 'a'.repeat(64), file_imports: [{ kind: 'import', module: 'unrelated_ui' }],
        custom_setup: { required: 'KEEP_UNKNOWN_SETUP' },
        callerContexts: [{ caller_func: 'read_rows', args: [], kwargs: {},
            trace_input: { schema_version: 'trace-value-v1', replayable: false,
                diagnostic: 'TRANSPORT_TREE_ONLY'.repeat(1000) } }],
        traceResult: { examples: [{ args: [], result: '[]', result_assertable: true, call_assertable: true,
            inputs_mutated: false }], errors: [], complete: true }
    }] };
}

test('Reviewer and Bug Fixer retain required setup and observations without unrelated module imports or transport trees', () => {
    const ast = context(), original = JSON.stringify(ast);
    const review = getReviewEvidence('', '', 'read_rows', [], source, ast, 'sample');
    const repair = getBugFixerUserPrompt(code, failure, 'read_rows', [], source, ast, 'sample');
    for (const prompt of [review, repair]) {
        for (const fact of ['storage', 'store', 'KEEP_UNKNOWN_SETUP', 'input_status', 'diagnostic',
            '"result":"[]"', '"result_assertable":true', '"inputs_mutated":false']) {
            assert.ok(prompt.includes(fact), fact);
        }
        assert.ok(prompt.includes(source), 'complete selected source remains present');
        assert.ok(prompt.includes('def read_rows():\\n    return []\\n'), 'complete dependency source remains present');
        assert.doesNotMatch(prompt, /UnusedControl|unrelated_ui|TRANSPORT_TREE_ONLY/);
    }
    assert.equal(JSON.stringify(ast), original, 'prompt projection cannot mutate artifact evidence');
    const request = fitReviewPrompt({ tests: code, evidence: review, executionVerified: true }, Number.MAX_SAFE_INTEGER)!;
    assert.equal(promptFits(getTestReviewerSystemPrompt(), request, 4096), true);
    assert.ok(request.includes('self.assertEqual(read_rows(), [])'));
});

test('unknown, wildcard, string-bound and constructor imports remain and missing source keeps all bindings', () => {
    const ast = { code: 'def run():\n    return "lazy_binding"\n',
        class_context: { init: { code: 'self.value = setup_alias()' } },
        file_imports: [{ kind: 'import', module: 'lazy_binding' }, { kind: 'from', module: 'setup', name: 'create', alias: 'setup_alias' },
            { kind: 'from', module: 'wild', name: '*' }, { kind: 'import', metadata: 'unknown binding' }] };
    for (const prompt of [getReviewEvidence('', '', 'run', [], ast.code, ast),
        getBugFixerUserPrompt(code, failure, 'run', [], ast.code, ast)]) {
        for (const fact of ['lazy_binding', 'setup_alias', 'wild', 'unknown binding']) { assert.ok(prompt.includes(fact)); }
    }
    const unknown = getReviewEvidence('', '', 'run', [], undefined, { file_imports: context().file_imports });
    assert.ok(unknown.includes('UnusedControl79'));
});

test('Reviewer and Bug Fixer retain imports for Unicode-normalized aliases and computed namespace access', () => {
    for (const targetSource of ['def target():\n    # 中文註解不應阻止精簡\n    return K.inf\n', 'def target():\n    return globals()["i" + "nf"]\n']) {
        const ast = { code: targetSource, file_imports: [
            { kind: 'import', module: 'math', alias: 'K', bound_name: 'K' },
            { kind: 'from', module: 'math', name: 'inf' },
            { kind: 'import', module: 'unrelated_module' }
        ] };
        for (const prompt of [getReviewEvidence('', '', 'target', [], targetSource, ast, 'sample'),
            getBugFixerUserPrompt(code, failure, 'target', [], targetSource, ast, 'sample')]) {
            assert.ok(prompt.includes(targetSource), 'complete source remains present');
            assert.match(prompt, /"alias":"K"/);
            assert.match(prompt, /"name":"inf"/);
            if (targetSource.includes('globals()')) { assert.match(prompt, /unrelated_module/); }
            else { assert.doesNotMatch(prompt, /unrelated_module/); }
        }
    }
});

test('required source above the budget remains intact and must still be rejected', () => {
    const required = 'def read_rows():\n    return ' + JSON.stringify('required'.repeat(5000));
    const evidence = getReviewEvidence('', '', 'read_rows', [], required, { code: required }, 'sample');
    assert.ok(evidence.includes(required));
    const request = fitReviewPrompt({ tests: code, evidence }, Number.MAX_SAFE_INTEGER)!;
    assert.equal(promptFits(getTestReviewerSystemPrompt(), request, 6000), false);
});
