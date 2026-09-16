import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CandidatePipelineHooks, validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { AnalysisJournal, QualityProgress } from '../pipeline/analysisJournal';
import { fitReviewPrompt, parseTestReview } from '../roles/testReviewer';
import { getBugFixerUserPrompt, mergeBugFixReplacement } from '../roles/bugFixer';
import { parseQualityTasks, qualityStrategyHints } from '../roles/qualityAnalyst';
import { normalizeScenarioOutput, reconcileScenarios } from '../validation/scenarioIdentity';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const passed = 'test_keep (suite.C.test_keep) ... ok\nRan 1 test\nOK';
function hooks(overrides: Partial<CandidatePipelineHooks> = {}): CandidatePipelineHooks {
    return { validate: async () => undefined, review: async () => ({ issues: [] }),
        revise: async () => 'fixed', execute: async () => ({ ok: true, out: passed, qualityGaps: [] }),
        event: () => {}, checkCancelled: () => {}, ...overrides };
}

test('review findings return to Writer before execution, and repaired tests are reviewed again', async () => {
    const order: string[] = [];
    const result = await validateTestCandidate('draft', hooks({
        review: async code => { order.push(`review:${code}`); return { issues: code === 'draft' ? [{
            id: 'R1', severity: 'blocking', evidence: 'draft', reason: 'bad fixture', action: 'fix fixture'
        }] : [] }; },
        revise: async (_, __, role) => { order.push(role); return 'fixed'; },
        execute: async code => { order.push(`execute:${code}`); return { ok: true, out: passed, qualityGaps: [] }; }
    }));
    assert.equal(result.code, 'fixed');
    assert.deepEqual(order, ['review:draft', 'writer', 'review:fixed', 'execute:fixed']);
});

test('execution failure calls Bug Fixer with latest error; quality gaps never trigger repair', async () => {
    const roles: string[] = [];
    const result = await validateTestCandidate('draft', hooks({
        revise: async (_, failure, role) => { roles.push(role); assert.match(failure, /NameError/); return 'fixed'; },
        execute: async code => code === 'draft'
            ? { ok: false, out: 'NameError: missing setup', qualityGaps: [] }
            : { ok: true, out: passed, qualityGaps: ['uncovered branch'] }
    }));
    assert.deepEqual(roles, ['bug-fixer']);
    assert.deepEqual(result.qualityIssues, ['uncovered branch']);
});

test('structural pre-validation failures go to Writer without guessing a failing method', async () => {
    const roles: string[] = [];
    const result = await validateTestCandidate('broken', hooks({
        validate: async code => code === 'broken' ? 'missing unittest import' : undefined,
        revise: async (_, failure, role) => {
            roles.push(role);
            assert.match(failure, /missing unittest import/);
            return 'fixed';
        }
    }));
    assert.equal(result.code, 'fixed');
    assert.deepEqual(roles, ['writer']);
});

test('malformed/unavailable review becomes a warning and does not create another quality loop', async () => {
    const result = await validateTestCandidate('draft', hooks({ review: async () => undefined }));
    assert.deepEqual(result.qualityIssues, []);
    assert.match(result.reviewWarnings.join(), /審查未完成/);
});

test('module import failures return to Writer without invoking method repair', async () => {
    const roles: string[] = [];
    const result = await validateTestCandidate('draft', hooks({
        execute: async code => code === 'draft'
            ? { ok: false, out: 'ImportError: Failed to import test module: loop1_test', qualityGaps: [] }
            : { ok: true, out: passed, qualityGaps: [] },
        revise: async (_, __, role) => { roles.push(role); return 'fixed'; }
    }));
    assert.equal(result.code, 'fixed');
    assert.deepEqual(roles, ['writer']);
});

test('nonblocking Reviewer advice is reported without overriding measured quality gates', async () => {
    const result = await validateTestCandidate('draft', hooks({
        review: async () => ({ issues: [{
            id: 'Q1', severity: 'quality', evidence: 'draft', reason: 'consider clarity', action: 'use a clearer assertion'
        }] })
    }));
    assert.deepEqual(result.qualityIssues, []);
    assert.deepEqual(result.reviewWarnings, ['Q1: use a clearer assertion']);
});

test('dropping previously passing tests cannot be accepted, and next repair uses retained code', async () => {
    let repairedFrom = '';
    await assert.rejects(validateTestCandidate('dropped', hooks({
        execute: async () => ({ ok: true, out: 'test_other (suite.C.test_other) ... ok', qualityGaps: [] }),
        revise: async code => { repairedFrom = code; return 'dropped-again'; }
    }), 1, { code: 'baseline', output: passed }), /Previously passing/);
    assert.equal(repairedFrom, 'baseline');
});

test('an unchanged Bug Fixer result stops immediately without duplicate execution', async () => {
    let executions = 0;
    let revisions = 0;
    await assert.rejects(validateTestCandidate('draft', hooks({
        execute: async () => { executions++; return { ok: false, out: 'failure', qualityGaps: [] }; },
        revise: async () => { revisions++; return 'draft'; }
    })), /Bug Fixer 未產生有效變更/);
    assert.equal(executions, 1);
    assert.equal(revisions, 1);
});

test('the same execution failure is offered to Bug Fixer at most once', async () => {
    let revisions = 0;
    await assert.rejects(validateTestCandidate('draft', hooks({
        execute: async () => ({ ok: false, out: 'same failure', qualityGaps: [] }),
        revise: async () => `changed-${++revisions}`
    }), 3), /已處理過相同失敗/);
    assert.equal(revisions, 1);
});

test('cancellation after review prevents executing or accepting a candidate', async () => {
    let cancelled = false;
    await assert.rejects(validateTestCandidate('draft', hooks({
        review: async () => { cancelled = true; return { issues: [] }; },
        checkCancelled: () => { if (cancelled) { throw Error('cancelled'); } },
        execute: async () => { throw Error('must not execute'); }
    })), /cancelled/);
});

test('review parser rejects invented evidence, malformed envelopes and placeholders', () => {
    const issue = { id: 'R1', severity: 'quality', evidence: 'assertFalse(value)', reason: 'weak', action: 'verify exact value' };
    assert.equal(parseTestReview(JSON.stringify({ issues: [issue] }), 'other'), undefined);
    assert.equal(parseTestReview('{"approved":true}', ''), undefined);
    assert.equal(parseTestReview('{"issues":[null]}', ''), undefined);
    assert.equal(parseTestReview(JSON.stringify({ issues: [{ ...issue, action: '<guess>' }] }), issue.evidence), undefined);
    assert.equal(parseTestReview(JSON.stringify({ issues: [issue] }), issue.evidence)?.issues.length, 1);
    assert.deepEqual(parseTestReview('```json\n{"issues":[]}\n```', ''), { issues: [] });
    assert.deepEqual(parseTestReview('{"blocking":[],"quality":[]}', ''), { issues: [] });
    const compact = '{"blocking":[{"test_excerpt":"assertFalse(value)","reason":"the verified contract requires boolean identity","action":"use exact identity"}],"quality":[]}';
    assert.equal(parseTestReview(`trace text before JSON\n${compact}\ntrailing text`, issue.evidence)?.issues[0].severity, 'blocking');
    assert.equal(parseTestReview(
        '{"blocking":[{"test_excerpt":"raise ValueError","action":"change source"}],"quality":[]}',
        'self.assertRaises(ValueError)'
    ), undefined);
});

test('Bug Fixer receives one failing method and its replacement preserves unrelated tests', () => {
    const original = `import unittest
class Cases(unittest.TestCase):
    def test_keep(self):
        self.assertTrue(True)

    def test_fix(self):
        self.assertEqual(render('x'), 'wrong')
`;
    const failure = 'FAIL: test_fix (Cases.test_fix)';
    const prompt = getBugFixerUserPrompt(
        original, failure, 'render', ['value'], "def render(value):\n    return value", undefined,
        'sample', undefined, ['sample.normalize']
    );
    assert.match(prompt, /def test_fix/);
    assert.doesNotMatch(prompt, /def test_keep/);
    assert.doesNotMatch(prompt, /AST CONTEXT|DEPENDENCY SOURCE|VERIFIED REAL EXECUTION TRACE/);

    const response = JSON.stringify({
        method: 'test_fix',
        replacement: "def test_fix(self):\n    self.assertEqual(render('x'), 'x')",
        imports: ['from unittest.mock import patch']
    });
    const merged = mergeBugFixReplacement(response, original, failure) || '';
    assert.match(merged, /def test_keep/);
    assert.match(merged, /self\.assertTrue\(True\)/);
    assert.match(merged, /self\.assertEqual\(render\('x'\), 'x'\)/);
    assert.match(merged, /from unittest\.mock import patch/);
});

test('Bug Fixer revision contract rejects broad rewrites and permits one failing method', () => {
    const script = path.join(root, 'python_scripts', 'validate_repair_scope.py');
    const previous = `import unittest
class Cases(unittest.TestCase):
    def test_keep(self):
        self.assertTrue(True)
    def test_fix(self):
        self.assertTrue(False)
`;
    const run = (candidate: string) => {
        const result = spawnSync(python, ['-B', script], {
            input: JSON.stringify({
                previous,
                candidate,
                failure: 'test_fix (Cases.test_fix) ... FAIL'
            }),
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout) as { valid: boolean; reason: string };
    };
    assert.equal(run(previous.replace('self.assertTrue(False)', 'self.assertFalse(False)')).valid, true);
    const broad = previous.replace('self.assertTrue(True)', 'self.assertEqual(True, True)');
    assert.equal(run(broad).valid, false);
    assert.match(run(broad).reason, /test_keep/);
});

test('prompt budget refuses partial evidence, and quality tasks must quote measured gaps', () => {
    assert.equal(fitReviewPrompt({ tests: 'complete tests', evidence: 'complete source' }, 10), undefined);
    assert.ok(fitReviewPrompt({ tests: 'complete tests', evidence: 'complete source' }, 200));
    const task = { evidence: 'line 4: And to Or', hypothesis: 'missing combination', scenario: 'mixed truth values', verification: 'compare original and mutant' };
    assert.equal(parseQualityTasks(JSON.stringify({ tasks: [task] }), 'different gap'), undefined);
    assert.equal(parseQualityTasks(JSON.stringify({ tasks: [task] }), task.evidence)?.length, 1);
    assert.equal(qualityStrategyHints('mutation from And to Or\nmutation from return_value to None').length, 2);
    assert.equal(qualityStrategyHints('').length, 0);
});

test('unchanged quality stops after three attempts and real measured progress resets the counter', () => {
    const progress = new QualityProgress(3);
    assert.equal(progress.observe(['a', 'b'], []), false);
    assert.equal(progress.observe(['a', 'b'], []), false);
    assert.equal(progress.observe(['a'], []), false);
    assert.equal(progress.observe(['a'], []), false);
    assert.equal(progress.observe(['a'], []), false);
    assert.equal(progress.observe(['a'], []), true);
});

test('journal preserves raw candidates and refuses overwriting a same-minute run', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'role-journal-'));
    try {
        const journal = new AnalysisJournal(directory, 'source', 'target', 'test-model');
        journal.record(1, 'writer', 'candidate', { code: 'first' });
        journal.record(1, 'baseline', 'rollback', { code: 'retained' });
        journal.knowledge({ survivors: ['a'] });
        journal.knowledge({ survivors: [] });
        assert.equal(fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').length, 2);
        assert.throws(() => new AnalysisJournal(directory, 'different', 'target', 'test-model'), /EEXIST/);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'function_knowledge.json'), 'utf8')).survivors, []);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
function inventory(code: string): Array<{ id: string; fingerprint: string }> {
    const run = spawnSync(python, ['-B', path.join(root, 'python_scripts/scenario_inventory.py')], { input: code, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
}

test('scenario identities survive loop-module changes and pure renames, not changed mock setup', () => {
    const code = 'import unittest\nclass C(unittest.TestCase):\n    def setUp(self): self.value = 1\n    def test_keep(self): self.assertEqual(self.value, 1)\n';
    const before = inventory(code);
    const renamed = inventory(code.replace('test_keep', 'test_renamed'));
    assert.equal(before[0].fingerprint, renamed[0].fingerprint);
    assert.match(normalizeScenarioOutput('test_renamed (loop2_test.C.test_renamed) ... ok', renamed, before), /\(C.test_keep\)/);
    assert.match(normalizeScenarioOutput('test_keep (loop1_test.C.test_keep) ... ok', before, before), /\(C.test_keep\)/);
    const retained = reconcileScenarios(renamed, before);
    assert.match(normalizeScenarioOutput('test_renamed (loop3_test.C.test_renamed) ... ok', renamed, retained), /\(C.test_keep\)/);
    const changed = inventory(code.replace('test_keep', 'test_renamed').replace('self.value = 1', 'self.value = 2'));
    assert.notEqual(before[0].fingerprint, changed[0].fingerprint);
    assert.match(normalizeScenarioOutput('test_renamed (loop2_test.C.test_renamed) ... ok', changed, before), /\(C.test_renamed\)/);
});

test('binding validation rejects stopping a started Mock instead of its patcher', () => {
    const check = (code: string) => {
        const run = spawnSync(python, ['-B', path.join(root, 'python_scripts/validate_test_bindings.py'),
            JSON.stringify({ module: 'sample', target: 'target', dependencies: { read: 'helper.read' } })],
        { input: code, encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        return JSON.parse(run.stdout);
    };
    const bad = "from unittest.mock import patch\nclass C:\n    def setUp(self): self.mock = patch('sample.read').start()\n    def tearDown(self): self.mock.stop()";
    assert.equal(check(bad).valid, false);
    assert.equal(check("from unittest.mock import patch\nclass C:\n    def setUp(self):\n        self.patcher = patch('sample.read')\n        self.mock = self.patcher.start()\n        self.addCleanup(self.patcher.stop)").valid, true);
});

test('neutral Python fixture confirms exact boolean and mixed-condition tests kill both survivors', () => {
    const run = spawnSync(python, ['-B', '-c', `
import unittest, io, types
from unittest.mock import patch
source = "def read(): return {'ready': True, 'kind': 'plain'}\\ndef target():\\n    state = read()\\n    if state['ready'] and state['kind'] == 'plain': return True\\n    return False"
module = types.ModuleType('fixture')
tests = """import unittest
from unittest.mock import patch
class Cases(unittest.TestCase):
    def test_false(self):
        with patch.object(module, 'read', return_value={'ready': False, 'kind': 'other'}):
            self.assertIs(module.target(), False)
    def test_mixed(self):
        with patch.object(module, 'read', return_value={'ready': True, 'kind': 'other'}):
            self.assertIs(module.target(), False)
"""
for index, candidate in enumerate([source, source.replace(' and ', ' or '), source.replace('return False', 'return None')]):
    exec(candidate, module.__dict__)
    scope = {'module': module}
    exec(tests, scope)
    result = unittest.TextTestRunner(stream=io.StringIO()).run(unittest.defaultTestLoader.loadTestsFromTestCase(scope['Cases']))
    assert result.wasSuccessful() == (index == 0)
`], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
});
