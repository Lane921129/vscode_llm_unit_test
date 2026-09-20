import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';
import { compareCoverageQuality, coverageGapIds } from '../pipeline/qualityRegression';
import { QualityProgress } from '../pipeline/analysisJournal';
import { fitReviewPrompt, parseTestReviewDetailed, reviewConstraintDiagnostics } from '../roles/testReviewer';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { parseFocusedQualityTask, requestFocusedQualityTask, selectQualityFocus } from '../roles/qualityAnalyst';
import { responseSchemaForOutputFormat } from '../llm/customApi';
import { assessReviewerQualification } from '../llm/roleQualification';
import { formatTargetContract } from '../pipeline/targetContract';

function coverage(lines: number[], branches: string[] = []): TargetCoverageAssessment {
    return { available: true, coverageText: 'measured', missingLines: '', targetExecuted: true,
        missingTargetLines: lines, missingTargetBranches: branches,
        targetFullyCovered: !lines.length, targetBranchesCovered: !branches.length };
}

test('partial coverage improvements survive changed display strings while true regressions remain blocked', () => {
    const old = coverage(Array.from({ length: 15 }, (_, i) => i + 10), ['12->18', '20->exit']);
    const improved = coverage([16, 18], ['20->exit']);
    assert.equal(compareCoverageQuality(old, improved).regressed, false);
    assert.deepEqual(compareCoverageQuality(improved, coverage([16, 18, 21], ['20->exit'])).addedLines, [21]);
    assert.deepEqual(compareCoverageQuality(improved, coverage([16], ['20->exit', '12->18'])).addedBranches, ['12->18']);
    assert.equal(compareCoverageQuality(old, { ...old, missingTargetLines: [...old.missingTargetLines!].reverse(),
        missingLines: 'a different language/order', coverageText: 'changed module percentage' }).regressed, false);
});

test('coverage evidence becoming unknown cannot replace a measured baseline', () => {
    const known = coverage([4]);
    assert.equal(compareCoverageQuality(known, { available: false, coverageText: 'N/A', missingLines: '' }).regressed, true);
    assert.equal(compareCoverageQuality(known, { ...known, missingTargetBranches: undefined }).regressed, true);
    assert.equal(compareCoverageQuality(known, { ...known, targetExecuted: false }).regressed, true);
    assert.equal(compareCoverageQuality({ available: false, coverageText: 'N/A', missingLines: '' }, known).regressed, false);
});

test('stagnation uses individual line and branch identities rather than display text', () => {
    const progress = new QualityProgress(2);
    assert.equal(progress.observe(['m1'], coverageGapIds(coverage([4, 7]))), false);
    assert.equal(progress.observe(['m1'], coverageGapIds(coverage([7, 4]))), false);
    assert.equal(progress.observe(['m1'], coverageGapIds(coverage([7]))), false);
    assert.equal(progress.observe(['m1'], coverageGapIds(coverage([7]))), false);
    assert.equal(progress.observe(['m1'], coverageGapIds(coverage([7]))), true);
});

const tests = 'import unittest\n# a comment\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(Widget.normalize(2), 2)\n';
const finding = { category: 'missing-scenario', test_line: 'L5', reason: 'A measured branch still has no scenario.',
    action: 'Add one input that reaches the measured branch, then verify the original result.' };
const raw = (changes = {}) => JSON.stringify({ findings: [{ ...finding, ...changes }] });
const constraints = { target: 'Widget.normalize', methodKind: 'static' };

test('Reviewer line IDs resolve original text and reject invented, blank, comment and ambiguous references', () => {
    const parsed = parseTestReviewDetailed(raw(), tests, true, constraints);
    assert.equal(parsed.review?.issues[0].evidence, tests.split('\n')[4]);
    assert.match(fitReviewPrompt({ tests, evidence: 'complete evidence' }, 5000)!, /\[L5\]         self.assertEqual/);
    for (const test_line of ['L0', 'L999', 'L2', 'L6', '5', 'L5-L6']) {
        assert.deepEqual(parseTestReviewDetailed(raw({ test_line }), tests, true).diagnostics, ['invalid-test-line']);
    }
    assert.equal(parseTestReviewDetailed(raw({ test_excerpt: 'Widget.normalize(2)' }), tests, true).review, undefined);
    assert.equal(assessReviewerQualification(JSON.stringify({ findings: [{ ...finding, test_line: 'L5' }] })).state, 'verified');
    assert.equal(assessReviewerQualification(JSON.stringify({ findings: [{ category: 'missing-scenario',
        test_excerpt: 'increment(1)', reason: finding.reason, action: finding.action }] })).state, 'unverified');
});

test('explicit target self-mock, source edits and binding contradictions remain incomplete reviews', () => {
    for (const change of [
        { category: 'target-binding', reason: 'The target function is not static.' },
        { category: 'mock-isolation', action: 'Mock Widget.normalize using unittest.mock.patch.' },
        { category: 'mock-isolation', action: "Use patch('sample.Widget.normalize') with the dependency return value." },
        { category: 'mock-isolation', action: "Use patch.object(Widget, 'normalize') in the fixture." },
        { category: 'target-binding', action: 'Add @staticmethod to Widget.normalize.' },
        { category: 'setup-error', action: 'Change the target implementation to accept this input.' }
    ]) {
        const result = parseTestReviewDetailed(raw(change), tests, true, constraints);
        assert.equal(result.review, undefined, JSON.stringify(change));
        assert.ok(result.diagnostics.length > 0);
    }
    for (const action of [
        "Patch the dependency Widget.read at its use point before calling Widget.normalize.",
        'Do not mock Widget.normalize; add verified input cases.',
        'Remove the patch on Widget.normalize and call the real method.',
        'Replace the expected literal for Widget.normalize with the observed value.'
    ]) {
        assert.ok(parseTestReviewDetailed(raw({ action }), tests, true, constraints).review, action);
    }
    const parsed = parseTestReviewDetailed(raw({ category: 'assertion-evidence',
        reason: 'The fixed expected value came from an uncontrolled clock observation.',
        action: 'Control the clock dependency in this test before verifying the expected value.' }), tests, true, constraints);
    assert.equal(parsed.review?.issues[0].severity, 'blocking', 'legitimate blocking findings remain blocking');
    assert.deepEqual(reviewConstraintDiagnostics({ issues: [] }, constraints), []);
    assert.match(formatTargetContract('sample', 'Widget.normalize', ['value'], { class_name: 'Widget', method_kind: 'static' }), /No instance setup/);
});

test('invalid constraint review does not spend a Writer revision or falsely approve the candidate', async () => {
    let revisions = 0;
    const result = await validateTestCandidate(tests, {
        validate: async () => undefined,
        execute: async () => ({ ok: true, out: 'test_value (Cases.test_value) ... ok\nRan 1 test\nOK', qualityGaps: [] }),
        review: async code => parseTestReviewDetailed(raw({ action: 'Mock Widget.normalize with patch.' }), code, true, constraints).review,
        revise: async () => { revisions++; return tests; },
        event: () => {}, checkCancelled: () => {}
    });
    assert.equal(result.reviewStatus, 'incomplete');
    assert.equal(revisions, 0);
    assert.equal(result.code, tests);
});

test('quality task has one host-bound evidence identity, strict fields and no invented oracle', () => {
    const focus = selectQualityFocus(coverage([4]), ['m1'], 1)!;
    assert.equal(focus.evidence, 'line:4');
    assert.equal(selectQualityFocus(coverage([4]), ['m1'], 2)?.evidence, 'm1');
    assert.equal(selectQualityFocus(coverage([]), [], 1), undefined);
    assert.equal(selectQualityFocus(coverage([4]), [], 1)?.id, focus.id);
    const task = { evidence_id: focus.id, hypothesis: 'A path is missing.', scenario: 'Try one boundary input.', verification: 'Execute original and mutant with identical input.' };
    assert.equal(parseFocusedQualityTask(JSON.stringify({ tasks: [task] }), focus).tasks?.[0].evidence, focus.evidence);
    for (const invalid of [
        { tasks: [task, task] }, { tasks: [{ ...task, evidence_id: 'invented' }] },
        { tasks: [{ ...task, scenario: '<scenario>' }] }, { tasks: [{ ...task, code: 'unverified' }] },
        { tasks: [null] }, { tasks: [false] }, { tasks: [{ ...task, verification: '' }] }, { tasks: 'guess' }
    ]) { assert.equal(parseFocusedQualityTask(JSON.stringify(invalid), focus).tasks, undefined); }
    assert.deepEqual(parseFocusedQualityTask('{"tasks":[]}', focus).tasks, []);
    const schema: any = responseSchemaForOutputFormat('quality-json');
    assert.equal(schema.properties.tasks.maxItems, 1);
    assert.equal(schema.properties.tasks.items.additionalProperties, false);
});

test('quality format correction is bounded, shares deadline and never echoes malformed output', async () => {
    const focus = selectQualityFocus(coverage([4]), [], 1)!;
    let calls = 0;
    const deadlines: number[] = [];
    const result = await requestFocusedQualityTask({ focus, context: 'complete source and test', deadlineAt: 100,
        now: () => 0, checkCancelled: () => {}, event: () => {},
        request: async (prompt, deadline) => {
            deadlines.push(deadline); calls++;
            if (calls === 1) { return 'PRIVATE_MALFORMED_RESPONSE'; }
            assert.match(prompt, /FORMAT CORRECTION: invalid-json/);
            assert.doesNotMatch(prompt, /PRIVATE_MALFORMED_RESPONSE/);
            return '{"tasks":[]}';
        }
    });
    assert.deepEqual(result, []);
    assert.deepEqual(deadlines, [100, 100]);
    calls = 0;
    await requestFocusedQualityTask({ focus, context: '', deadlineAt: 100, now: () => 0,
        checkCancelled: () => {}, event: () => {}, request: async () => { calls++; return 'invalid'; } });
    assert.equal(calls, 2);
});

test('expired deadline, transport failure and cancellation never launch extra quality calls', async () => {
    const focus = selectQualityFocus(coverage([4]), [], 1)!;
    let calls = 0, now = 0;
    const hooks = { focus, context: '', deadlineAt: 100, now: () => now, checkCancelled: () => {}, event: () => {},
        request: async () => { calls++; now = 100; return 'invalid'; } };
    assert.equal(await requestFocusedQualityTask(hooks), undefined);
    assert.equal(calls, 1);
    calls = 0; now = 0;
    await assert.rejects(requestFocusedQualityTask({ ...hooks, request: async () => { calls++; throw Error('transport'); } }), /transport/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(requestFocusedQualityTask({ ...hooks, checkCancelled: () => { throw Error('cancelled'); } }), /cancelled/);
    assert.equal(calls, 0);
});
