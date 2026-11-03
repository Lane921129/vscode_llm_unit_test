import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MutationRun, mutationCandidateSetId } from '../mutation/mutationResult';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';
import { QualityFocus, selectQualityFocus } from '../roles/qualityAnalyst';
import { QualityImprovementSession } from '../pipeline/qualityImprovementSession';
import { QualityProgress } from '../pipeline/analysisJournal';
import { coverageGapIds } from '../pipeline/qualityRegression';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

function mutation(round: number, killed = 27): MutationRun {
    const candidateIds = Array.from({ length: 39 }, (_, i) => digest(`candidate-${i}`));
    return {
        schemaVersion: 1, sourcePath: path.resolve('neutral.py'), sourceHash: digest('source'), testHash: digest(`tests-${round}`),
        targetScope: { kind: 'function', qualifiedName: 'categorize', startLine: 1, endLine: 18 },
        engine: 'mutatest', engineVersion: '3.1.0', operatorSetVersion: 'mutatest-ast-3.1.0-v1',
        scopeVersion: 'selected-function-body-v1', executionBackend: 'isolated-unittest-v1',
        candidateSetId: mutationCandidateSetId(candidateIds), candidateIds,
        status: 'complete', baselinePassed: true, baselineStatus: 'passed', scoreAvailable: true,
        excluded: { noop: 0, duplicate: 0, invalid: 0 },
        counts: { available: 39, selected: 39, executed: 39, notRun: 0, killed, survived: 39 - killed, timeout: 0, error: 0 },
        mutants: candidateIds.map((id, index) => ({ id, kind: 'compare', line: 5 + index % 10,
            column: 8, position: index, from: 'Lt', to: 'LtE', status: index < killed ? 'KILLED' : 'SURVIVED',
            killedBy: index < killed ? ['Cases.test_observed'] : [] }))
    };
}

function coverage(run: MutationRun, missing: number[], branches: string[] = []): TargetCoverageAssessment {
    return { available: true, evidenceVersion: 'coverage-evidence-v1', scopeStatus: 'verified',
        executableTargetLines: Array.from({ length: 18 }, (_, i) => i + 1),
        invocationEvidence: { observed: true, testHash: run.testHash, testRunId: `execution-${run.testHash}` },
        targetExecuted: true, coverageText: 'measured', missingLines: missing.join(','),
        missingTargetLines: [...missing], missingTargetBranches: [...branches] };
}

function survivorFocus(run: MutationRun, index = 27): QualityFocus {
    const item = run.mutants[index];
    return { id: 'E-focused', kind: 'survivor', evidence: `- id ${item.id}, line ${item.line}, column ${item.column}, position ${item.position}, kind ${item.kind}: mutation from ${item.from} to ${item.to}` };
}

test('three measured rounds preserve an unresolved mutant while recognizing an independent coverage gain', () => {
    const session = new QualityImprovementSession();
    const rounds = [mutation(1), mutation(2), mutation(3)];
    const coverages = [coverage(rounds[0], [15, 16, 17]), coverage(rounds[1], [15, 16, 17]), coverage(rounds[2], [16, 17])];
    const focus = survivorFocus(rounds[0]);
    const pending = session.beginFocus(focus, coverages[0], rounds[0]);
    const second = session.measureFocus(pending, coverages[1], rounds[1]);
    const third = session.measureFocus(pending, coverages[2], rounds[2]);
    assert.equal(second.status, 'unchanged');
    assert.equal(second.globalProgress, 'unchanged');
    assert.equal(third.status, 'unchanged', 'a different covered line cannot resolve the selected survivor');
    assert.equal(third.globalProgress, 'improved', 'the real coverage gain is still retained');
    assert.equal(third.candidateId, rounds[0].candidateIds[27]);
    assert.equal(third.retainEvidence, true);
    assert.match(third.feedback, /selected mutant survived/);
    assert.match(third.feedback, /No individual assertion failure attribution/);
    assert.equal(session.events.at(-1)?.status, 'unchanged');
    assert.equal(session.events.at(-1)?.measurement?.globalProgress, 'improved');
    const events = session.events;
    events.at(-1)!.measurement!.focus.evidence = 'caller edit';
    assert.equal(session.events.at(-1)?.measurement?.focus.evidence, focus.evidence);

    const stagnation = new QualityProgress(2);
    const survivors = rounds[0].mutants.filter(item => item.status === 'SURVIVED').map(item => item.id);
    assert.equal(stagnation.observe(survivors, coverageGapIds(coverages[0])), false);
    assert.equal(stagnation.observe(survivors, coverageGapIds(coverages[1])), false);
    assert.equal(stagnation.observe(survivors, coverageGapIds(coverages[2])), false, 'global gain keeps the existing bounded policy');
    assert.equal(stagnation.observe(survivors, coverageGapIds(coverages[2])), false);
    assert.equal(stagnation.observe(survivors, coverageGapIds(coverages[2])), true);
});

test('only the exact selected mutant outcome can resolve the mutation task', () => {
    const session = new QualityImprovementSession();
    const before = mutation(1), after = mutation(2, 28);
    const selected = session.beginFocus(survivorFocus(before, 28), coverage(before, []), before);
    const otherKilled = session.measureFocus(selected, coverage(after, []), after);
    assert.equal(otherKilled.status, 'unchanged');
    assert.equal(otherKilled.globalProgress, 'improved');
    const exact = session.beginFocus(survivorFocus(before, 27), coverage(before, []), before);
    const resolved = session.measureFocus(exact, coverage(after, []), after);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.retainEvidence, false);
    assert.equal(resolved.reason, 'focused-mutant-killed');
});

test('rebasing an unresolved focus reports an independent gain only in the round that actually gained it', () => {
    const session = new QualityImprovementSession();
    const rounds = [mutation(1), mutation(2), mutation(3)];
    const focus = survivorFocus(rounds[0]);
    let pending = session.beginFocus(focus, coverage(rounds[0], [15, 16]), rounds[0]);
    const nextCoverage = coverage(rounds[1], [16]);
    const second = session.measureFocus(pending, nextCoverage, rounds[1]);
    assert.equal(second.status, 'unchanged');
    assert.equal(second.globalProgress, 'improved');
    pending = session.beginFocus(pending.focus, nextCoverage, rounds[1]);
    const third = session.measureFocus(pending, coverage(rounds[2], [16]), rounds[2]);
    assert.equal(third.status, 'unchanged');
    assert.equal(third.globalProgress, 'unchanged');
    assert.equal(third.focus.id, focus.id);
    assert.equal(third.candidateId, second.candidateId);
    assert.equal(third.retainEvidence, true);
    assert.equal(third.previousTestHash, rounds[1].testHash);
});

test('temporary focus deferral selects another measured gap without erasing or declaring the survivor equivalent', () => {
    const run = mutation(1), assessed = coverage(run, [15]);
    const survivors = [survivorFocus(run, 27).evidence, survivorFocus(run, 28).evidence];
    const selected = selectQualityFocus(assessed, survivors, 1, [survivors[0]])!;
    assert.equal(selected.evidence, survivors[0]);
    const alternative = selectQualityFocus(assessed, survivors, 2, [survivors[0]], [selected.id])!;
    assert.notEqual(alternative.id, selected.id);
    assert.ok([...coverageGapIds(assessed), ...survivors].includes(alternative.evidence));
    const coverageOnlyAlternative = selectQualityFocus(assessed, [survivors[0]], 3, [survivors[0]], [selected.id])!;
    assert.equal(coverageOnlyAlternative.evidence, 'line:15', 'a preferred but deferred mutant does not hide other coverage work');
    const sole = selectQualityFocus(coverage(run, []), [survivors[0]], 3, [], [selected.id])!;
    assert.equal(sole.id, selected.id, 'the only measured gap remains available');
    assert.equal(selectQualityFocus(assessed, survivors, 1, [survivors[0]])!.id, selected.id, 'a one-turn deferral does not erase the gap');
    assert.deepEqual(survivors, [survivorFocus(run, 27).evidence, survivorFocus(run, 28).evidence]);
    assert.equal(run.counts.available, 39);
    assert.equal(run.counts.survived, 12);
});

test('line and branch tasks follow their exact measured gap instead of total coverage', () => {
    const session = new QualityImprovementSession();
    const before = mutation(1), after = mutation(2);
    const initial = coverage(before, [10, 11], ['10->11', '12->-1']);
    for (const [evidence, remaining, resolved] of [
        ['line:10', coverage(after, [10], []), coverage(after, [11], ['12->-1'])],
        ['branch:12->-1', coverage(after, [], ['12->-1']), coverage(after, [10, 11], ['10->11'])]
    ] as const) {
        const pending = session.beginFocus({ id: evidence, kind: 'coverage', evidence }, initial, before);
        const unchanged = session.measureFocus(pending, remaining, after);
        assert.equal(unchanged.status, 'unchanged');
        assert.equal(unchanged.globalProgress, 'improved');
        assert.equal(session.measureFocus(pending, resolved, after).status, 'resolved');
    }
    const unknown = session.beginFocus({ id: 'unknown', kind: 'coverage', evidence: 'line:99' }, initial, before);
    assert.equal(session.measureFocus(unknown, coverage(after, []), after).status, 'unavailable');
});

test('changed sources, engines, candidate sets, target scopes and incomplete runs cannot certify focus progress', () => {
    const session = new QualityImprovementSession();
    const before = mutation(1);
    const pending = session.beginFocus(survivorFocus(before), coverage(before, [10]), before);
    for (const change of [
        (value: MutationRun) => { value.sourceHash = digest('new-source'); },
        (value: MutationRun) => { value.sourcePath = path.resolve('other.py'); },
        (value: MutationRun) => { value.targetScope.qualifiedName = 'other'; },
        (value: MutationRun) => { value.targetScope.startLine = 2; },
        (value: MutationRun) => { value.engine = 'builtin'; value.operatorSetVersion = 'builtin-ast-v2'; },
        (value: MutationRun) => { value.candidateIds[38] = digest('new-candidate'); value.mutants[38].id = value.candidateIds[38];
            value.candidateSetId = mutationCandidateSetId(value.candidateIds); },
        (value: MutationRun) => { value.mutants[27].status = 'TIMEOUT'; value.counts.killed--; value.counts.timeout++;
            value.mutants[27].killedBy = []; value.status = 'partial'; value.scoreAvailable = false; },
        (value: MutationRun) => { value.mutants[27].status = 'NOT_RUN'; value.counts.killed--; value.counts.executed--;
            value.counts.notRun++; value.mutants[27].killedBy = []; value.status = 'partial'; value.scoreAvailable = false; }
    ]) {
        const after = mutation(2, 28); change(after);
        const result = session.measureFocus(pending, coverage(after, []), after);
        assert.equal(result.status, 'unavailable');
        assert.equal(result.globalProgress, 'unavailable');
        assert.equal(result.retainEvidence, true);
    }
    const after = mutation(2, 28), wrongCoverage = coverage(after, []);
    wrongCoverage.invocationEvidence!.testHash = before.testHash;
    const line = session.beginFocus({ id: 'line', kind: 'coverage', evidence: 'line:10' }, coverage(before, [10]), before);
    assert.equal(session.measureFocus(line, wrongCoverage, after).status, 'unavailable');
    wrongCoverage.invocationEvidence!.testHash = after.testHash;
    wrongCoverage.missingTargetBranches = undefined;
    assert.equal(session.measureFocus(line, wrongCoverage, after).status, 'unavailable');
    const missingScopeLine = coverage(after, []);
    missingScopeLine.executableTargetLines = missingScopeLine.executableTargetLines!.filter(line => line !== 10);
    assert.equal(session.measureFocus(line, missingScopeLine, after).status, 'unavailable');
});

test('an empty verified mutant universe still permits exact coverage-gap tracking without claiming a mutation score', () => {
    const session = new QualityImprovementSession();
    const before = mutation(1), after = mutation(2);
    for (const run of [before, after]) {
        run.candidateIds = []; run.candidateSetId = mutationCandidateSetId([]); run.mutants = [];
        run.counts = { available: 0, selected: 0, executed: 0, notRun: 0, killed: 0, survived: 0, timeout: 0, error: 0 };
        run.status = 'no-candidates'; run.scoreAvailable = false;
    }
    const pending = session.beginFocus({ id: 'line', kind: 'coverage', evidence: 'line:10' }, coverage(before, [10]), before);
    const result = session.measureFocus(pending, coverage(after, []), after);
    assert.equal(result.status, 'resolved');
    assert.equal(result.globalProgress, 'improved');
    assert.equal(result.candidateId, undefined);
    assert.equal(after.scoreAvailable, false);
});

test('global regressions remain visible independently of a genuinely resolved focus', () => {
    const session = new QualityImprovementSession();
    const before = mutation(1), after = mutation(2, 28);
    const pending = session.beginFocus(survivorFocus(before), coverage(before, []), before);
    const result = session.measureFocus(pending, coverage(after, [11]), after);
    assert.equal(result.status, 'resolved');
    assert.equal(result.globalProgress, 'regressed', 'a resolved task does not authorize keeping a weaker global baseline');
});
