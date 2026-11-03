import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mutationCandidateSetId } from '../mutation/mutationResult';
import { createDefaultQualityPolicy, createFixtureQualityPolicy, createStrictQualityPolicy, evaluateQuality, qualityPolicyHash,
    QualityEvidenceInput, validateQualityPolicy } from '../pipeline/qualityPolicy';

const fixtures = JSON.parse(readFileSync(resolve('contracts/quality-policy-cases-v1.json'), 'utf8'));
const standard = JSON.parse(readFileSync(resolve('contracts/quality-policy-standard80-tests-v1.json'), 'utf8'));
fixtures.policies.standard = standard.policy;
for (const spec of standard.thresholdCases) {
    const evidence = structuredClone(fixtures.cases.find((item: any) => item.name === 'strict-199-of-200-does-not-round').evidence);
    evidence.identity.policyHash = standard.policy.policyHash;
    const run = evidence.mutation;
    run.mutants = run.mutants.slice(0, spec.total).map((item: any, index: number) => ({ ...item, status: index < spec.killed ? 'KILLED' : 'SURVIVED' }));
    run.candidateIds = run.mutants.map((item: any) => item.id);
    run.candidateSetId = mutationCandidateSetId(run.candidateIds);
    run.counts = { available: spec.total, selected: spec.total, executed: spec.total, notRun: 0,
        killed: spec.killed, survived: spec.total - spec.killed, timeout: 0, error: 0 };
    fixtures.cases.push({ name: 'standard-' + spec.name, policyKey: 'standard', evidence,
        expected: { measurementStatus: 'complete', policyStatus: spec.passed ? 'met' : 'below-threshold',
            toolsSatisfied: spec.passed, fullyPassed: spec.passed, reasons: spec.passed ? [] : ['mutation-threshold-not-met'] } });
}
// The new threshold must preserve execution, review, coverage and completeness gates.
for (const name of ['review-incomplete-tools-remain-met', 'branch-gap-failed', 'line-threshold-failed',
    'sample-30-of-86-not-complete', 'timeout-is-not-killed', 'error-is-unavailable', 'no-candidates-is-unpassed',
    'baseline-failed-is-unavailable', 'execution-did-not-pass']) {
    const item = structuredClone(fixtures.cases.find((entry: any) => entry.name === name));
    item.name = 'standard-' + name; item.policyKey = 'standard'; item.evidence.identity.policyHash = standard.policy.policyHash;
    fixtures.cases.push(item);
}


test('quality policies use the shared fixed definition and portable snapshot hashes', () => {
    assert.deepEqual(createDefaultQualityPolicy(), standard.policy);
    assert.equal(validateQualityPolicy(standard.policy).ok, true);
    assert.notEqual(createDefaultQualityPolicy().policyHash, createStrictQualityPolicy().policyHash);
    assert.deepEqual(createStrictQualityPolicy(), fixtures.policies.strict100);
    assert.deepEqual(createFixtureQualityPolicy({ fixtureId: 'neutral-fixture', manifestHash: 'f'.repeat(64),
        minLineCoverage: 100, minMutationScore: 85 }), fixtures.policies.fixture85);
    assert.throws(() => createFixtureQualityPolicy({ fixtureId: 'neutral-fixture', manifestHash: 'f'.repeat(64),
        minLineCoverage: 100, minMutationScore: 85.5 }));
    const strict = createStrictQualityPolicy();
    assert.ok(Object.isFrozen(strict)); assert.ok(Object.isFrozen(strict.mutationThreshold));
    assert.equal(qualityPolicyHash(strict), strict.policyHash);
    const invalid = { ...strict, mode: ['strict100'] };
    invalid.policyHash = qualityPolicyHash(invalid);
    assert.equal(validateQualityPolicy(invalid).ok, false);
});

test('all shared policy vectors retain exact measurement, threshold and review distinctions', () => {
    for (const item of fixtures.cases) {
        const input = structuredClone(item.evidence);
        const result = evaluateQuality(item.policy || fixtures.policies[item.policyKey], input);
        for (const [field, value] of Object.entries(item.expected)) {
            assert.deepEqual(result[field as keyof typeof result], value, `${item.name}: ${field}`);
        }
        assert.deepEqual(input, item.evidence, `${item.name}: evaluation mutated evidence`);
    }
});

test('Python and TypeScript return identical complete assessments for the shared corpus', () => {
    const python = resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    const script = 'import json,sys;sys.path.insert(0,"python_scripts");from quality_policy import evaluate_quality;'
        + 'data=json.load(sys.stdin);print(json.dumps([evaluate_quality(v.get("policy",data["policies"][v["policyKey"]]),v["evidence"]) for v in data["cases"]]))';
    const run = spawnSync(python, ['-B', '-c', script], { input: JSON.stringify(fixtures), encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const pythonResults = JSON.parse(run.stdout);
    fixtures.cases.forEach((item: { name: string; policy?: unknown; policyKey: string; evidence: QualityEvidenceInput }, index: number) => {
        assert.deepEqual(evaluateQuality(item.policy || fixtures.policies[item.policyKey], item.evidence),
            pythonResults[index], item.name);
    });
});

test('a termination reason does not rewrite the retained candidate assessment', () => {
    const input = structuredClone(fixtures.cases[0].evidence);
    const baseline = evaluateQuality(fixtures.policies.strict100, input);
    for (const terminationReason of ['cancelled', 'round-limit', 'budget-exhausted', 'retained-after-failure']) {
        assert.deepEqual(evaluateQuality(fixtures.policies.strict100, { ...input, terminationReason }), baseline);
    }
    // Run/batch consumers must still reject those terminal states; this pure
    // result only certifies the identified saved candidate, never the whole run.
});
