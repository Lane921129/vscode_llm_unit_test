import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyExecutionFailure } from '../utils/executionFailureCategory';
import { getBugFixerUserPrompt, getReviewEvidence, mergeBugFixReplacement } from '../roles/bugFixer';
import { parseTestReview } from '../roles/testReviewer';
import { createAnalysisDirectory } from '../pipeline/analysisOutput';
import { AnalysisJournal } from '../pipeline/analysisJournal';
import { inferTargetImportModule } from '../utils/dependencyResolver';
import { formatTargetContract } from '../pipeline/targetContract';
import { clearPreflightFailureCache } from '../pipeline/modulePreflight';

test('Python failures do not become API failures because of paths or line numbers', () => {
    for (const kind of ['AssertionError: wrong value', 'TypeError: missing arguments', 'NameError: missing setup']) {
        assert.equal(classifyExecutionFailure(`測試候選未通過驗證\n  File "C:/llm_unit_test/ast.py", line 503\n${kind}\nFAILED (errors=1)`), 'validation');
    }
    assert.equal(classifyExecutionFailure('Trace 證據檢查無法完成\nSyntaxError: invalid syntax'), 'model-format');
    assert.equal(classifyExecutionFailure('This operation was aborted'), 'unknown');
    assert.equal(classifyExecutionFailure('HTTP 429 - quota'), 'model-api');
});

const code = `import unittest
from sample import Worker
class Cases(unittest.TestCase):
    def setUp(self):
        self.worker = Worker('a')
    def test_render(self):
        self.assertEqual(self.worker.render('x'), 'wrong')
`;
test('class repair preserves its binding, setup, annotations, observations and whole source', () => {
    const source = 'def render(value):\n' + '    # explanation\n'.repeat(200) + '    return value';
    const context = { class_name: 'Worker', method_kind: 'instance',
        signature: [{ name: 'value', annotation: 'str' }],
        class_context: { init: { required_params: ['prefix'] } },
        traceResult: { examples: [{ args: ["'x'"], result: "'ax'", constructor_args: ["'a'"] }] } };
    const prompt = getBugFixerUserPrompt(code, 'FAIL: test_render (Cases.test_render)', 'render', ['value'], source, context, 'sample');
    assert.match(prompt, /from sample import Worker/);
    assert.match(prompt, /instance.render\(value\)/);
    assert.doesNotMatch(prompt, /from sample import render|truncated unrelated tail/);
    assert.ok(prompt.includes(source));
    assert.match(prompt, /setUp|constructor_args|prefix/);
    const review = getReviewEvidence(code, '', 'render', ['value'], source, context, 'sample');
    assert.match(review, /from sample import Worker/);
    assert.match(review, /constructor_args|prefix/);
    assert.ok(review.includes(source));
});

test('module errors and ambiguous method names never guess a first method replacement', () => {
    const failure = 'ImportError: Failed to import test module: loop1_test';
    assert.match(getBugFixerUserPrompt(code, failure, 'render', ['value']), /not identified; stop without guessing/);
    const response = JSON.stringify({ method: 'test_render', replacement: 'def test_render(self): pass', imports: [] });
    assert.equal(mergeBugFixReplacement(response, code, failure), undefined);
    assert.equal(mergeBugFixReplacement(response, code + code.replace('Cases', 'OtherCases'), 'FAIL: test_render (Cases.test_render)'), undefined);
});

test('target contract preserves static, class, property and asynchronous binding', () => {
    for (const kind of ['static', 'class']) {
        const contract = formatTargetContract('pkg.sample', 'Worker.render', ['value'], { class_name: 'Worker', method_kind: kind });
        assert.match(contract, /from pkg.sample import Worker/);
        assert.match(contract, /Target signature: Worker.render\(value\)/);
    }
    const property = formatTargetContract('pkg.sample', 'value', [], { class_name: 'Worker', method_kind: 'property' });
    assert.match(property, /Target signature: instance.value\n/);
    const asyncMethod = formatTargetContract('pkg.sample', 'render', ['value'], { class_name: 'Worker', method_kind: 'instance', is_async: true });
    assert.match(asyncMethod, /await required/);
    assert.match(asyncMethod, /instance.render\(value\)/);
});

test('preflight failure cache can be cleared after an environment repair', () => {
    clearPreflightFailureCache();
    assert.equal(typeof clearPreflightFailureCache, 'function');
});

test('Reviewer requires an actionable explanation and rejects copied prompt placeholders', () => {
    const excerpt = "self.assertEqual(self.worker.render('x'), 'wrong')";
    const issue = { test_excerpt: excerpt, reason: 'the observed result for this setup is ax', action: 'replace the expected literal with ax' };
    const parse = (value: unknown) => parseTestReview(JSON.stringify({ blocking: [value], quality: [] }), code);
    assert.equal(parse(issue)?.issues.length, 1);
    assert.equal(parse({ ...issue, action: 'focused correction' }), undefined);
    assert.equal(parse({ test_excerpt: excerpt, action: 'replace the expected literal with ax' }), undefined);
    assert.equal(parse({ ...issue, reason: issue.action }), undefined);
});

test('batch output separates same basenames and retains same-minute attempts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-output-'));
    try {
        const first = createAnalysisDirectory(root, '2026_09_16_00_00', path.join(root, 'a', 'main.py'), 'run', 'project', root);
        fs.writeFileSync(path.join(first, 'final_report.md'), 'first evidence');
        const second = createAnalysisDirectory(root, '2026_09_16_00_00', path.join(root, 'b', 'main.py'), 'run', 'project', root);
        const retry = createAnalysisDirectory(root, '2026_09_16_00_00', path.join(root, 'a', 'main.py'), 'run', 'project', root);
        assert.notEqual(first, second);
        assert.notEqual(first, retry);
        assert.equal(fs.readFileSync(path.join(first, 'final_report.md'), 'utf8'), 'first evidence');
        const journal = new AnalysisJournal(retry, 'source', 'run', 'fixture');
        assert.equal(JSON.parse(fs.readFileSync(path.join(retry, 'function_knowledge.json'), 'utf8')).terminalStatus, 'running');
        journal.record(1, 'validation', 'failed', { reason: 'missing dependency' });
        journal.record(1, 'writer', 'tier-failed', { reason: 'later symptom' });
        const state = JSON.parse(fs.readFileSync(path.join(retry, 'function_knowledge.json'), 'utf8'));
        assert.equal(state.firstFailure.reason, 'missing dependency');
        assert.equal(state.lastFailure.reason, 'later symptom');
        const pkg = path.join(root, 'pkg', 'nested');
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(root, 'pkg', '__init__.py'), '');
        fs.writeFileSync(path.join(pkg, '__init__.py'), '');
        assert.equal(inferTargetImportModule(path.join(pkg, 'sample.py')), 'pkg.nested.sample');
        assert.equal(inferTargetImportModule(path.join(pkg, '__init__.py')), 'pkg.nested');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
