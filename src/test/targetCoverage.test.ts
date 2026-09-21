import * as assert from 'assert';
import { test } from 'node:test';
import { assessTargetCoverage } from '../mutation/targetCoverage';
import { assessTargetCoverageEvidence } from '../mutation/targetCoverage';
import * as path from 'node:path';

const exactFile = path.resolve('neutral-coverage-source', 'selected', 'sample.py');
const sourceHash = 'a'.repeat(64);
const nativeEvidence = () => ({
    schemaVersion: 'coverage-evidence-v1', available: true, scopeStatus: 'verified', invocationRequired: false,
    canonicalFile: exactFile, sourceHash, target: 'target',
    statements: [1, 3, 5, 6, 10, 11], executedStatements: [1, 3, 5, 6, 10], missingStatements: [11],
    targetStatements: [3, 5, 6], branchCoverageAvailable: true,
    executedBranches: [[3, 5]], missingBranches: [[3, 6], [10, 11]],
    branchCounts: { total: 3, executed: 1, missing: 2 }
});

test('native coverage validates full source identity instead of a matching basename', () => {
    const evidence = nativeEvidence();
    assert.strictEqual(assessTargetCoverageEvidence(evidence, exactFile, 'target', sourceHash).available, true);
    assert.strictEqual(assessTargetCoverageEvidence(evidence,
        path.resolve('neutral-coverage-source', 'another', 'sample.py'), 'target', sourceHash).available, false);
    assert.strictEqual(assessTargetCoverageEvidence(evidence, exactFile, 'Other.target', sourceHash).available, false);
    assert.strictEqual(assessTargetCoverageEvidence(evidence, exactFile, 'target', 'b'.repeat(64)).available, false);
});

test('native statement and arc sets preserve exact target scope and branch gaps', () => {
    const assessment = assessTargetCoverageEvidence(JSON.stringify(nativeEvidence()), exactFile, 'target', sourceHash);
    assert.deepStrictEqual(assessment.executableTargetLines, [3, 5, 6]);
    assert.strictEqual(assessment.targetExecuted, true);
    assert.strictEqual(assessment.targetFullyCovered, true);
    assert.deepStrictEqual(assessment.missingTargetBranches, ['3->6']);
    assert.strictEqual(assessment.targetBranchesCovered, false);
});

test('line-only native coverage never certifies branches and an empty target does not prove execution', () => {
    const lineOnly = { ...nativeEvidence(), branchCoverageAvailable: false };
    const assessment = assessTargetCoverageEvidence(lineOnly, exactFile, 'target');
    assert.strictEqual(assessment.available, true);
    assert.strictEqual(assessment.targetBranchesCovered, undefined);
    const empty = assessTargetCoverageEvidence({ ...lineOnly, targetStatements: [] }, exactFile, 'target');
    assert.strictEqual(empty.targetExecuted, undefined);
    assert.strictEqual(empty.targetFullyCovered, undefined);
    assert.strictEqual(empty.targetBranchesCovered, undefined);
});

test('invocation evidence must match the current candidate and cannot credit import-only lines', () => {
    const expected = { testRunId: 'current-attempt', testHash: 'c'.repeat(64) };
    const evidence = { ...nativeEvidence(), invocationRequired: true, invocation: { ...expected, observed: false } };
    const uncalled = assessTargetCoverageEvidence(evidence, exactFile, 'target', sourceHash, expected);
    assert.strictEqual(uncalled.available, true);
    assert.strictEqual(uncalled.targetExecuted, false);
    assert.strictEqual(uncalled.targetFullyCovered, false);
    assert.deepStrictEqual(uncalled.missingTargetLines, evidence.targetStatements);
    assert.strictEqual(assessTargetCoverageEvidence(evidence, exactFile, 'target', sourceHash).available, false);
    assert.strictEqual(assessTargetCoverageEvidence(evidence, exactFile, 'target', sourceHash,
        { ...expected, testRunId: 'another-attempt' }).available, false);
    assert.strictEqual(assessTargetCoverageEvidence(evidence, exactFile, 'target', sourceHash,
        { ...expected, testHash: 'd'.repeat(64) }).available, false);
});

test('missing native fields and inconsistent partitions fail closed', () => {
    for (const field of ['canonicalFile', 'sourceHash', 'target', 'scopeStatus', 'invocationRequired', 'statements', 'executedStatements', 'missingStatements',
        'targetStatements', 'branchCoverageAvailable', 'executedBranches', 'missingBranches', 'branchCounts']) {
        const missing: Record<string, unknown> = { ...nativeEvidence() };
        delete missing[field];
        assert.strictEqual(assessTargetCoverageEvidence(missing, exactFile, 'target').available, false, field);
    }
    for (const override of [
        { executedStatements: [1, 3, 5, 6, 10, 11] }, { targetStatements: [2, 3] },
        { statements: [1, 1, 3, 5, 6, 10, 11] }, { missingBranches: [[3, 5]] },
        { missingBranches: [[999, 11]] }, { branchCounts: { total: 4, executed: 1, missing: 3 } }
    ]) {
        assert.strictEqual(assessTargetCoverageEvidence({ ...nativeEvidence(), ...override }, exactFile, 'target').available, false);
    }
});

test('detects that every executable target line was missed', () => {
    const assessment = assessTargetCoverage([
        'Name                 Stmts   Miss  Cover   Missing',
        'C:\\project\\target.py      5      4    20%   2-5',
        'TOTAL                    5      4    20%'
    ].join('\n'), 'C:\\project\\target.py', [2, 3, 4, 5]);

    assert.strictEqual(assessment.available, true);
    assert.strictEqual(assessment.targetExecuted, false);
});

test('reports partial target coverage separately from basic execution', () => {
    const assessment = assessTargetCoverage(
        'target.py 5 2 60% 4-5',
        'target.py',
        [2, 3, 4, 5]
    );
    assert.strictEqual(assessment.targetExecuted, true);
    assert.strictEqual(assessment.coverageText, '60%');
    assert.deepStrictEqual(assessment.missingTargetLines, [4, 5]);
    assert.strictEqual(assessment.targetFullyCovered, false);
});

test('detects a missing branch even when all target statements ran', () => {
    const assessment = assessTargetCoverage(
        'target.py 4 0 2 1 83% 2->4',
        'target.py',
        [2, 3, 4]
    );

    assert.strictEqual(assessment.targetFullyCovered, true);
    assert.deepStrictEqual(assessment.missingTargetBranches, ['2->4']);
    assert.strictEqual(assessment.targetBranchesCovered, false);
});

test('limits branch failures to arcs that originate in the selected target', () => {
    const assessment = assessTargetCoverage(
        'target.py 7 0 4 1 91% 8->10',
        'target.py',
        [2, 3, 4]
    );

    assert.deepStrictEqual(assessment.missingTargetBranches, []);
    assert.strictEqual(assessment.targetBranchesCovered, true);
});

test('does not mistake an unavailable or malformed report for zero coverage', () => {
    assert.strictEqual(assessTargetCoverage('no coverage available', 'target.py', [2]).available, false);
    assert.strictEqual(
        assessTargetCoverage('target.py 5 2 60% branch 3', 'target.py', [2, 3]).targetExecuted,
        undefined
    );
    assert.strictEqual(
        assessTargetCoverage('target.py 5 2 60% branch 3', 'target.py', [2, 3]).targetFullyCovered,
        undefined
    );
});
