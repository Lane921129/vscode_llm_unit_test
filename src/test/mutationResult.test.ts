import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { test } from 'node:test';
import { MutationContext, MutationRun, mutationMeetsThreshold, mutationScore, parseBuiltinMutationRun,
    parseExternalMutationRun, mutationCandidateSetId, BUILTIN_MUTATION_OPERATOR_SET_VERSION,
    FUNCTION_BODY_MUTATION_SCOPE_VERSION, readStoredMutationRun } from '../mutation/mutationResult';

const context: MutationContext = { sourcePath: path.resolve('sample.py'), sourceHash: 'a'.repeat(64), testHash: 'b'.repeat(64),
    targetScope: { kind: 'function', qualifiedName: 'target' }, stageTimeoutSeconds: 20 };

function builtin() {
    return { ...context, schemaVersion: 1, engine: 'builtin', status: 'complete', scope_found: true,
        operatorSetVersion: BUILTIN_MUTATION_OPERATOR_SET_VERSION, scopeVersion: FUNCTION_BODY_MUTATION_SCOPE_VERSION,
        candidateIds: ['c'.repeat(64)], candidateSetId: mutationCandidateSetId(['c'.repeat(64)]),
        baseline_passed: true, baselineStatus: 'passed', scoreAvailable: true,
        excluded: { noop: 0, duplicate: 0, invalid: 0 },
        counts: { available: 1, selected: 1, executed: 1, notRun: 0, killed: 1, survived: 0, timeout: 0, error: 0 },
        mutants: [{ id: 'c'.repeat(64), kind: 'compare', line: 2, column: 5, position: 0, from: 'Lt', to: 'LtE', status: 'KILLED' }] };
}

test('builtin contract validates candidate identity and exact outcome counts', () => {
    const good = parseBuiltinMutationRun(JSON.stringify(builtin()), context);
    assert.equal(good.status, 'complete');
    assert.equal(mutationScore(good), 100);
    assert.equal(mutationMeetsThreshold(good), true);
    for (const mutate of [
        (value: ReturnType<typeof builtin>) => { value.testHash = 'd'.repeat(64); },
        (value: ReturnType<typeof builtin>) => { value.sourceHash = 'd'.repeat(64); },
        (value: ReturnType<typeof builtin>) => { value.targetScope = { kind: 'function', qualifiedName: 'other' }; },
        (value: ReturnType<typeof builtin>) => { value.counts.killed = 2; },
        (value: ReturnType<typeof builtin>) => { value.mutants[0].status = 'SURVIVED'; },
        (value: ReturnType<typeof builtin>) => { value.stageTimeoutSeconds = 30; },
        (value: ReturnType<typeof builtin>) => { value.counts.selected = -1; },
        (value: ReturnType<typeof builtin>) => { value.operatorSetVersion = 'unknown' as typeof value.operatorSetVersion; },
        (value: ReturnType<typeof builtin>) => { value.scopeVersion = 'old-function-scope' as typeof value.scopeVersion; },
        (value: ReturnType<typeof builtin>) => { value.candidateSetId = 'e'.repeat(64); },
        (value: ReturnType<typeof builtin>) => { value.candidateIds = ['d'.repeat(64)]; }
    ]) {
        const value = builtin(); mutate(value);
        const invalid = parseBuiltinMutationRun(value, context);
        assert.equal(invalid.status, 'failed');
        assert.equal(mutationScore(invalid), null);
    }
    assert.equal(mutationScore(parseBuiltinMutationRun('not json', context)), null);
});

test('persisted camelCase mutation results are revalidated and malformed evidence stays distinct from failed measurement', () => {
    const original = parseBuiltinMutationRun(builtin(), context);
    const saved = readStoredMutationRun(JSON.stringify(original), context);
    assert.equal(saved.ok, true);
    if (saved.ok) { assert.equal(mutationMeetsThreshold(saved.run), true); }
    const failed = builtin();
    failed.mutants[0].status = 'ERROR'; failed.counts.killed = 0; failed.counts.error = 1;
    failed.status = 'failed'; failed.scoreAvailable = false;
    const validFailure = readStoredMutationRun(parseBuiltinMutationRun(failed, context), context);
    assert.equal(validFailure.ok, true);
    if (validFailure.ok) { assert.equal(validFailure.run.status, 'failed'); }
    for (const altered of [
        { ...original, testHash: 'e'.repeat(64) }, { ...original, sourceHash: 'e'.repeat(64) },
        { ...original, scopeVersion: 'old-scope' }, { ...original, operatorSetVersion: 'unknown' },
        { ...original, candidateSetId: '0'.repeat(64) }, { ...original, candidateIds: [] },
        { ...original, targetScope: { kind: 'function', qualifiedName: 'other' } },
        { ...original, counts: { ...original.counts, killed: 0 } }, { ...original, baselineStatus: ['passed'] },
        { ...original, targetScope: { ...original.targetScope, startLine: 3, endLine: 1 } }
    ]) { assert.equal(readStoredMutationRun(altered, context).ok, false); }
});

test('the Python runner and TypeScript adapter agree on the actual wire contract', () => {
    const tempPrefix = path.join(os.tmpdir(), 'mutation-contract-');
    const directory = fs.mkdtempSync(tempPrefix);
    try {
        const sourcePath = path.join(directory, 'sample.py'), testPath = path.join(directory, 'test_sample.py');
        fs.writeFileSync(sourcePath, 'def target():\r\n    return True\r\n');
        fs.writeFileSync(testPath, 'import unittest\r\nfrom sample import target\r\nclass Cases(unittest.TestCase):\r\n    def test_target(self): self.assertTrue(target())\r\n');
        const python = path.resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
        const completed = spawnSync(python, [path.resolve('python_scripts/basic_mutation_runner.py'), sourcePath, testPath,
            '0', '5', 'target', '', '20'], { encoding: 'utf8', timeout: 25000 });
        assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
        const actualContext: MutationContext = { sourcePath, sourceHash: createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
            testHash: createHash('sha256').update(fs.readFileSync(testPath)).digest('hex'),
            targetScope: { kind: 'function', qualifiedName: 'target' }, stageTimeoutSeconds: 20 };
        const run = parseBuiltinMutationRun(completed.stdout, actualContext);
        assert.equal(run.status, 'complete', run.diagnostic);
        assert.equal(run.counts.available, 2);
        assert.equal(mutationMeetsThreshold(run), true);
    } finally {
        assert.ok(directory.startsWith(tempPrefix));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('sampling and timeout never constitute complete mutation validation', () => {
    const sample = builtin(); sample.counts.available = 40; sample.status = 'partial';
    sample.candidateIds = ['c'.repeat(64), ...Array.from({ length: 39 }, (_, index) => index.toString(16).padStart(64, '0'))];
    sample.candidateSetId = mutationCandidateSetId(sample.candidateIds);
    const result = parseBuiltinMutationRun(sample, context);
    assert.equal(mutationScore(result), 100);
    assert.equal(mutationMeetsThreshold(result), false);
    const timed = builtin(); timed.counts.killed = 0; timed.counts.timeout = 1;
    timed.mutants[0].status = 'TIMEOUT'; timed.scoreAvailable = false; timed.status = 'partial';
    const timeout = parseBuiltinMutationRun(timed, context);
    assert.equal(timeout.status, 'partial');
    assert.equal(timeout.counts.timeout, 1);
    assert.equal(mutationScore(timeout), null);
});

test('candidate universe identity is order independent and rejects undeclared selected mutants', () => {
    assert.equal(mutationCandidateSetId(['a'.repeat(64), 'b'.repeat(64)]), mutationCandidateSetId(['b'.repeat(64), 'a'.repeat(64)]));
    const invalid = builtin();
    invalid.mutants[0].id = 'd'.repeat(64);
    assert.equal(parseBuiltinMutationRun(invalid, context).status, 'failed');
    const first = parseBuiltinMutationRun(builtin(), context);
    const secondContext = { ...context, testHash: 'e'.repeat(64) };
    const second = parseBuiltinMutationRun({ ...builtin(), testHash: secondContext.testHash }, secondContext);
    assert.equal(first.candidateSetId, second.candidateSetId);
    assert.notEqual(first.testHash, second.testHash);
});

test('success uses exact counts instead of rounding a near-perfect score', () => {
    const run: MutationRun = { ...parseBuiltinMutationRun(builtin(), context),
        counts: { available: 200, selected: 200, executed: 200, notRun: 0, killed: 199, survived: 1, timeout: 0, error: 0 } };
    assert.equal(mutationScore(run), 99.5);
    assert.equal(mutationMeetsThreshold(run, 100), false);
    assert.equal(mutationMeetsThreshold(run, 99), true);
});

test('the checked-in complete Mutatest RST proves zero omitted statuses through its detail records', () => {
    const report = fs.readFileSync(path.resolve('test/test_mut/report.rst'), 'utf8');
    const sourcePath = report.match(/ - Source location: (.+)/)![1].trim();
    const external = { ...context, sourcePath, targetScope: { kind: 'module' as const, qualifiedName: 'module' },
        baselinePassed: true, isolationVerified: true };
    const run = parseExternalMutationRun('mutatest', report, 0, external);
    assert.equal(run.counts.killed, 6);
    assert.equal(mutationScore(run), 100);
    assert.equal(run.counts.available, null);
    assert.equal(run.status, 'partial');
    assert.equal(mutationMeetsThreshold(run), false);
    for (const invalid of [
        parseExternalMutationRun('mutatest', report, 1, external),
        parseExternalMutationRun('mutatest', report.replace('TOTAL RUNS: 6', 'TOTAL RUNS: 7'), 0, external),
        parseExternalMutationRun('mutatest', 'TOTAL RUNS: 6\nSURVIVED: 0', 0, external),
        parseExternalMutationRun('mutatest', report, 0, { ...external, isolationVerified: false }),
        parseExternalMutationRun('mutatest', report, 0, { ...external, targetScope: context.targetScope }),
        parseExternalMutationRun('mutmut', '6 mutants\n0 survived', 0, external)
    ]) {
        assert.equal(invalid.status, 'failed');
        assert.equal(mutationScore(invalid), null);
    }
});
