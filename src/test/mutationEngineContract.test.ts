import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MutationContext, MutationRun, mutationCandidateSetId, parseIsolatedMutationRun, readStoredMutationRun } from '../mutation/mutationResult';
import { createDefaultQualityPolicy, evaluateQuality } from '../pipeline/qualityPolicy';

const context: MutationContext = { sourcePath: path.resolve('sample.py'), sourceHash: 'a'.repeat(64), testHash: 'b'.repeat(64),
    targetScope: { kind: 'function', qualifiedName: 'combine' }, stageTimeoutSeconds: 30 };
const candidateId = 'c'.repeat(64);
function evidence(engine = 'builtin', version = 'builtin-ast-v2'): any {
    return { ...structuredClone(context), schemaVersion: 1, engine, operatorSetVersion: version,
        scopeVersion: 'selected-function-body-v1', executionBackend: 'isolated-unittest-v1',
        ...(engine === 'mutatest' ? { engineVersion: '3.1.0' } : {}),
        baseline_passed: true, baselinePassed: true, baselineStatus: 'passed', scope_found: true,
        status: 'complete', scoreAvailable: true, candidateIds: [candidateId], candidateSetId: mutationCandidateSetId([candidateId]),
        counts: { available: 1, selected: 1, executed: 1, notRun: 0, killed: 1, survived: 0, timeout: 0, error: 0 },
        excluded: { noop: 0, duplicate: 0, invalid: 0 },
        mutants: [{ id: candidateId, kind: 'BinOp', line: 2, column: 11, position: 0, from: 'Add', to: 'Sub',
            status: 'KILLED', killedBy: ['test_sample.Cases.test_sum'], elapsedMs: 25 }] };
}

function qualityFixture(run: MutationRun, identity: MutationContext) {
    const policy = createDefaultQualityPolicy();
    return { policy, evidence: { identity: { ...identity, policyHash: policy.policyHash }, executionPassed: true,
        reviewStatus: 'completed', qualityGaps: [], mutation: run,
        coverage: { sourceHash: identity.sourceHash, testHash: identity.testHash, targetScope: identity.targetScope,
            assessment: { available: true, evidenceVersion: 'coverage-evidence-v1' as const, scopeStatus: 'verified' as const,
                coverageText: '100%', missingLines: '',
                executableTargetLines: [2], invocationEvidence: { observed: true, testRunId: 'engine-contract-fixture', testHash: identity.testHash },
                targetExecuted: true, targetFullyCovered: true, missingTargetLines: [], targetBranchesCovered: true, missingTargetBranches: [] } } } };
}

test('historical builtin v1 remains readable and new v2/external evidence retains attribution', () => {
    const historical = evidence('builtin', 'builtin-ast-v1');
    delete historical.executionBackend; delete historical.mutants[0].killedBy;
    for (const raw of [historical, evidence(), evidence('mutatest', 'mutatest-ast-3.1.0-v1')]) {
        const run = parseIsolatedMutationRun(raw, context, raw.engine);
        assert.equal(run.status, 'complete', run.diagnostic);
        const stored = readStoredMutationRun(JSON.stringify(run), context);
        assert.ok(stored.ok, stored.ok ? '' : stored.reason);
        assert.equal(stored.run.engine, raw.engine);
        assert.deepEqual(stored.run.mutants[0].killedBy, raw.mutants[0].killedBy);
        const fixture = qualityFixture(run, context);
        assert.equal(evaluateQuality(fixture.policy, fixture.evidence).fullyPassed, true);
    }
});

test('engine/version/backend mismatch cannot inherit full mutation quality', () => {
    const valid = evidence('mutatest', 'mutatest-ast-3.1.0-v1');
    for (const changed of [
        { ...valid, engine: 'unknown' }, { ...valid, engine: ['mutatest'] },
        { ...valid, engine: 'mutmut' }, { ...valid, engineVersion: '9.0.0' }, { ...valid, engineVersion: undefined },
        { ...valid, operatorSetVersion: 'builtin-ast-v2' }, { ...valid, operatorSetVersion: 'mutatest-ast-3.2.0-v1' },
        { ...valid, executionBackend: undefined }, { ...valid, executionBackend: 'native-unverified' },
        { ...evidence(), executionBackend: undefined }, { ...evidence(), executionBackend: 'native-unverified' }
    ]) { assert.equal(readStoredMutationRun(changed, context).ok, false, JSON.stringify(changed)); }
    const selectedWrong = parseIsolatedMutationRun(valid, context, 'builtin');
    assert.equal(selectedWrong.status, 'failed'); assert.equal(selectedWrong.scoreAvailable, false);
});

test('new killed evidence requires real unique test identifiers and cannot attribute a survivor', () => {
    for (const engine of ['builtin', 'mutatest']) {
        const base = evidence(engine, engine === 'builtin' ? 'builtin-ast-v2' : 'mutatest-ast-3.1.0-v1');
        for (const killedBy of [undefined, [], ['x', 'x'], [''], ['x\ny'], ['x\0y'], ['x'.repeat(1025)], [1], 'test_sample.Cases.test_sum']) {
            const changed = { ...base, mutants: [{ ...base.mutants[0], killedBy }] };
            assert.equal(readStoredMutationRun(changed, context).ok, false, `${engine}: ${JSON.stringify(killedBy)}`);
        }
        assert.equal(readStoredMutationRun({ ...base,
            mutants: [{ ...base.mutants[0], killedBy: ['x'.repeat(1024)] }] }, context).ok, true);
        const survived = { ...base, counts: { ...base.counts, killed: 0, survived: 1 },
            mutants: [{ ...base.mutants[0], status: 'SURVIVED' }] };
        assert.equal(readStoredMutationRun(survived, context).ok, false);
    }
});

test('real Mutatest artifacts cross Python/TypeScript readers and the complete-quality fixture', t => {
    const python = process.env.LLM_TEST_EXTERNAL_PYTHON || path.resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    const adapter = path.resolve('python_scripts/external_mutation_runner.py');
    const probe = spawnSync(python, ['-B', adapter, '--probe', 'mutatest'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
    const availability = JSON.parse(probe.stdout);
    if (process.env.LLM_TEST_EXTERNAL_PYTHON) { assert.equal(availability.supported, true, availability.diagnosticCode); }
    if (!availability.supported) { t.skip('verified mutatest AST API is absent from this test Python'); return; }
    const prefix = path.join(os.tmpdir(), 'external-engine-contract-');
    const directory = fs.mkdtempSync(prefix);
    try {
        const source = path.join(directory, 'sample.py'), tests = path.join(directory, 'test_sample.py');
        fs.writeFileSync(source, 'def combine(a, b):\n    return a + b\n');
        fs.writeFileSync(tests, 'import unittest\nfrom sample import combine\nclass Cases(unittest.TestCase):\n'
            + '    def test_sum(self):\n        self.assertEqual(combine(2, 3), 5)\n');
        const actual: MutationContext = { sourcePath: source, sourceHash: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
            testHash: createHash('sha256').update(fs.readFileSync(tests)).digest('hex'),
            targetScope: { kind: 'function', qualifiedName: 'combine' }, stageTimeoutSeconds: 30 };
        const trial = spawnSync(python, ['-B', adapter, 'mutatest', source, tests, '0', '5', 'combine', '', '30', '2'],
            { encoding: 'utf8', timeout: 35000 });
        assert.equal(trial.status, 0, trial.stderr || trial.error?.message);
        const run = parseIsolatedMutationRun(trial.stdout, actual, 'mutatest');
        assert.equal(run.status, 'complete', run.diagnostic);
        assert.equal(run.counts.available, 6); assert.equal(run.counts.killed, 6);
        assert.ok(run.mutants.every(m => m.killedBy?.includes('test_sample.Cases.test_sum')));
        assert.ok(readStoredMutationRun(JSON.stringify(run), actual).ok);
        const fixture = qualityFixture(run, actual);
        const tsAssessment = evaluateQuality(fixture.policy, fixture.evidence);
        assert.equal(tsAssessment.fullyPassed, true);
        const policyScript = 'import json,sys;sys.path.insert(0,"python_scripts");from quality_policy import evaluate_quality;'
            + 'data=json.load(sys.stdin);print(json.dumps(evaluate_quality(data["policy"],data["evidence"])))';
        const checked = spawnSync(python, ['-B', '-c', policyScript], { encoding: 'utf8', input: JSON.stringify(fixture), timeout: 15000 });
        assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
        assert.deepEqual(JSON.parse(checked.stdout), tsAssessment);
    } finally {
        assert.ok(directory.startsWith(prefix)); fs.rmSync(directory, { recursive: true, force: true });
    }
});
