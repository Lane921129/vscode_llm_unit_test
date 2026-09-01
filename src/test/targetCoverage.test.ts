import * as assert from 'assert';
import { test } from 'node:test';
import { assessTargetCoverage } from '../targetCoverage';

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
