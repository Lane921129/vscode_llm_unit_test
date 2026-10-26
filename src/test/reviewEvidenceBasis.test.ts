import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { evidenceHash } from '../pipeline/analysisJournal';
import { NumericEvidenceLedger } from '../pipeline/numericEvidenceLedger';
import { scalarProbeInput } from '../pipeline/probeInputs';
import { buildReviewFacts, ReviewFacts, reviewFactsForPrompt } from '../roles/reviewFacts';
import { fitReviewPrompt, parseTestReviewDetailed, ReviewConstraints } from '../roles/testReviewer';
import { ReviewEvidenceBasis } from '../roles/reviewEvidenceBasis';
import { reviewWithContractRepair } from '../roles/reviewContractRepair';
import { responseSchemaForOutputFormat } from '../llm/customApi';
import { QUALIFICATION_VERSION, qualificationAppliesToRequest } from '../llm/modelQualification';
import { testCodeBasis } from './reviewBasisFixture';

const identity = { runId: 'review-basis', sourceHash: 'a'.repeat(64), target: 'increment' };
const code = 'import unittest\nfrom sample import increment\nclass Cases(unittest.TestCase):\n'
    + '    def test_first(self):\n        self.assertEqual(increment(1), 2)\n'
    + '    def test_second(self):\n        self.assertEqual(increment(2), 3)\n';
const python = path.join(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const ledger = new NumericEvidenceLedger(identity);
for (const input of [1, 2]) {
    ledger.add('VERIFIED NUMERIC OBSERVATIONS (evidence only; the AI must revise the test):\n' + JSON.stringify({
        schemaVersion: 'numeric-observation-handoff-v1', ...identity, testHash: 'b'.repeat(64),
        corrections: [{ method: 'test_first', line: 5, basis: { call: scalarProbeInput({ args: [input], kwargs: {} }).input,
            result_snapshot: { schema_version: 'trace-value-v1', replayable: true, value: { type: 'int', value: String(input + 1) } } } }]
    }));
}
const facts = (tests = code) => buildReviewFacts({ ...identity, module: 'sample', code: tests, executionVerified: true,
    python, env: process.env, numericEvidencePrompt: ledger.prompt(12000) });
const context = (value: ReviewFacts): ReviewConstraints => ({ ...identity, methodKind: 'module', module: 'sample', identity, facts: value });
const finding = (basis: unknown = testCodeBasis(5), line = 5) => ({ category: 'assertion-quality', test_line: `L${line}`,
    reason: 'This input checks one return value; the additional negative input has no case.',
    action: 'Add a separate negative-input case using a controlled observation.', ...(basis === undefined ? {} : { basis }) });
const raw = (basis?: unknown, line = 5) => JSON.stringify({ findings: [finding(basis, line)] });
const host = (ref = 'A1.1', field = 'expectedOrigin', value = 'static-literal'): ReviewEvidenceBasis => ({ kind: 'host-fact', ref, field, value });

test('review-v8 requires a basis while the historical reader keeps v7 findings and empty approval has no fabricated premise', () => {
    const previous = finding(); delete (previous as { basis?: unknown }).basis;
    assert.deepEqual(parseTestReviewDetailed(JSON.stringify({ findings: [previous] }), code, true).diagnostics, ['missing-evidence-basis']);
    assert.equal(parseTestReviewDetailed(JSON.stringify({ findings: [previous] }), code, false).review?.issues.length, 1);
    assert.deepEqual(parseTestReviewDetailed('{"findings":[]}', code, true).review, { issues: [] });
    assert.equal(parseTestReviewDetailed(raw(), code, true).review?.issues[0].basis?.kind, 'test-code');
    assert.deepEqual(parseTestReviewDetailed(raw(host()), code, true).diagnostics, ['evidence-reference-missing']);
    const schema = responseSchemaForOutputFormat('review-json') as any;
    assert.ok(schema.properties.findings.items.required.includes('basis'));
    assert.deepEqual(schema.properties.findings.items.properties.basis.required, ['kind', 'ref', 'field', 'value']);
});

test('prompt fact IDs address only explicit scalar facts and match current AST identities', async () => {
    const current = await facts();
    const projected = JSON.parse(reviewFactsForPrompt(current).split('\n')[1]);
    assert.equal(projected.id, 'E1');
    assert.equal(projected.imports[0].id, 'I1');
    assert.equal(projected.classes[0].id, 'H1');
    assert.equal(projected.methods[0].id, 'M1');
    assert.equal(projected.methods[0].assertions[0].id, 'A1.1');
    assert.equal(projected.methods[0].calls[0].id, 'C1.1');
    for (const basis of [host(), host('A1.1', 'targetResult', 'true'), host('A1.1', 'observationStatus', 'verified'),
        host('C1.1', 'observationReturned', 'true'), host('E1', 'executionVerified', 'true')]) {
        assert.equal(parseTestReviewDetailed(raw(basis), code, true, context(current)).review?.issues.length, 1, JSON.stringify(basis));
    }
    assert.deepEqual(parseTestReviewDetailed(raw(host('A1.1', 'expected', '2')), code, true, context(current)).diagnostics,
        ['evidence-reference-missing'], 'raw expected values are not arbitrary addressable fact fields');
});

test('fact contradictions use structured premises independently of the language of reason or action', async () => {
    const current = await facts();
    const response = JSON.stringify({ findings: [{ ...finding(host('A1.1', 'expectedOrigin', 'runtime-computed')),
        reason: '這個預期值是在執行期間計算的，未提供固定結果。', action: '把這個預期值改為可核對的固定結果。' }] });
    assert.deepEqual(parseTestReviewDetailed(response, code, true, context(current)).diagnostics, ['evidence-fact-contradiction']);
    assert.deepEqual(parseTestReviewDetailed(raw(host('A1.1', 'targetResult', 'false')), code, true, context(current)).diagnostics,
        ['evidence-fact-contradiction']);
    assert.deepEqual(parseTestReviewDetailed(raw(host('A9.1')), code, true, context(current)).diagnostics, ['evidence-reference-missing']);
    assert.deepEqual(parseTestReviewDetailed(raw(host('A2.1')), code, true, context(current)).diagnostics, ['evidence-reference-unrelated']);
    const changed = code + '# new candidate\n';
    assert.deepEqual(parseTestReviewDetailed(raw(host()), changed, true, context(current)).diagnostics, ['review-facts-identity-mismatch']);
});

test('an evidence gap requires an explicit unknown field, never absence or a false claim of conflict', async () => {
    const tests = code.replace('increment(1), 2', 'increment(1), helper()');
    const current = await facts(tests);
    const basis: ReviewEvidenceBasis = { kind: 'evidence-gap', ref: 'A1.1', field: 'expectedOrigin', value: 'unknown' };
    assert.equal(parseTestReviewDetailed(raw(basis), tests, true, context(current)).review?.issues.length, 1);
    assert.deepEqual(parseTestReviewDetailed(raw({ ...basis, value: 'static-literal' }), tests, true, context(current)).diagnostics,
        ['evidence-fact-contradiction']);
    const verified = await facts();
    assert.deepEqual(parseTestReviewDetailed(raw({ ...basis, field: 'observationStatus' }), code, true, context(verified)).diagnostics,
        ['evidence-fact-contradiction']);
    const legacy = structuredClone(current);
    delete legacy.methods[0].assertions[0].expectedOrigin;
    assert.deepEqual(parseTestReviewDetailed(raw(basis), tests, true, context(legacy)).diagnostics, ['evidence-reference-missing']);
});

test('test-code judgments stay unverified and cannot cite another line or smuggle extra fields', () => {
    for (const basis of [{ ...testCodeBasis(5), ref: 'L7' }, { ...testCodeBasis(5), value: 'verified' },
        { ...testCodeBasis(5), field: 'executionVerified' }, { ...testCodeBasis(5), approved: true },
        { ...testCodeBasis(5), value: true }, null]) {
        assert.deepEqual(parseTestReviewDetailed(raw(basis), code, true).diagnostics, ['invalid-evidence-basis']);
    }
});

test('independent requirements need a supplied unique source-bound ID and verbatim statement', async () => {
    const current = await facts();
    const requirements = { ...identity, items: [{ id: 'R' + '1'.repeat(16), statement: 'Input 1 must return 3.' }] };
    const basis: ReviewEvidenceBasis = { kind: 'requirement', ref: requirements.items[0].id, field: 'statement', value: requirements.items[0].statement };
    assert.deepEqual(parseTestReviewDetailed(raw(basis), code, true, context(current)).diagnostics, ['requirement-evidence-missing']);
    const bound = { ...context(current), requirements };
    assert.equal(parseTestReviewDetailed(raw(basis), code, true, bound).review?.issues.length, 1);
    for (const change of [{ ...basis, ref: 'R' + '2'.repeat(16) }, { ...basis, value: 'Input 1 must return 4.' }]) {
        assert.deepEqual(parseTestReviewDetailed(raw(change), code, true, bound).diagnostics, ['requirement-evidence-missing']);
    }
    for (const change of [{ ...requirements, sourceHash: 'f'.repeat(64) },
        { ...requirements, items: [...requirements.items, ...requirements.items] },
        { ...requirements, private_provider_field: 'not-forwarded' },
        { ...requirements, items: [{ ...requirements.items[0], private_provider_field: 'not-forwarded' }] }]) {
        assert.deepEqual(parseTestReviewDetailed('{"findings":[]}', code, true, { ...bound, requirements: change }).diagnostics,
            ['requirement-identity-mismatch']);
        assert.throws(() => fitReviewPrompt({ tests: code, evidence: 'complete source', facts: current, requirements: change }, 100000), /not bound/);
    }
    const prompt = fitReviewPrompt({ tests: code, evidence: 'complete source', facts: current, requirements }, 100000)!;
    assert.match(prompt, /REVIEW_REQUEST_V8/);
    assert.match(prompt, /HOST_REVIEW_REQUIREMENTS_V1/);
    assert.ok(prompt.includes(JSON.stringify(requirements)));
});

test('structured contradictions use the same candidate and original single correction, never an automatic approval', async () => {
    const current = await facts();
    const response = raw(host('A1.1', 'expectedOrigin', 'unknown'));
    let requests = 0;
    const deadlines: number[] = [];
    const statuses: string[] = [];
    const review = await reviewWithContractRepair({ tests: code, prompt: 'complete candidate and evidence', constraints: context(current),
        deadlineAt: 1000, now: () => 1, checkCancelled: () => {}, event: status => statuses.push(status),
        request: async (prompt, deadline) => { requests++; deadlines.push(deadline); assert.ok(prompt.startsWith('complete candidate and evidence')); return response; } });
    assert.equal(review, undefined);
    assert.equal(requests, 2);
    assert.deepEqual(deadlines, [1000, 1000]);
    assert.deepEqual(statuses, ['invalid-response', 'repair-requested', 'invalid-response']);
    assert.equal(current.testHash, evidenceHash(code));
});

test('registered independent requirements remain reviewable across languages when implementation observations differ', async () => {
    const current = await facts();
    for (const [statement, reason, action] of [
        ['Input 1 must raise ValueError.', '依使用者文件，這個輸入應提出 ValueError。', 'Replace the assertion with self.assertRaises(ValueError) around increment(1).'],
        ['Input 1 must return 3.', '依使用者文件，這個輸入必須回傳三。', 'Change the expected value to 3.'],
        ['Input 1 must return 3.', 'The required result is not asserted.', 'Change the expected value to 3.'],
    ]) {
        const requirements = { ...identity, items: [{ id: 'R' + '3'.repeat(16), statement }] };
        const basis: ReviewEvidenceBasis = { kind: 'requirement', ref: requirements.items[0].id, field: 'statement', value: statement };
        const response = JSON.stringify({ findings: [{ ...finding(basis), reason, action }] });
        assert.equal(parseTestReviewDetailed(response, code, true, { ...context(current), requirements }).review?.issues.length, 1);
        assert.deepEqual(parseTestReviewDetailed(response, code, true, context(current)).diagnostics, ['requirement-evidence-missing']);
    }
    const invented = JSON.stringify({ findings: [{ ...finding(),
        reason: 'The documented business contract requires ValueError for increment(1).',
        action: 'Replace the assertion with self.assertRaises(ValueError) around increment(1).' }] });
    assert.ok(parseTestReviewDetailed(invented, code, true, context(current)).diagnostics.includes('expected-exception-contradiction'),
        'unverified prose cannot invent an independent requirement that overrules this observed return');
    const guarded = code.replace('self.assertEqual(increment(1), 2)', 'with self.assertRaises(ZeroDivisionError):\n            increment(0)');
    const guardedFacts = await facts(guarded);
    const requirements = { ...identity, items: [{ id: 'R' + '4'.repeat(16), statement: 'Input 0 must return 0.' }] };
    const response = JSON.stringify({ findings: [{ ...finding({ kind: 'requirement', ref: requirements.items[0].id,
        field: 'statement', value: requirements.items[0].statement }), category: 'setup-error',
        reason: '此案例的 ZeroDivisionError 預期違反使用者文件。',
        action: 'Replace the assertRaises block with assertEqual(increment(0), 0) for the supplied contract.' }] });
    assert.equal(parseTestReviewDetailed(response, guarded, true, { ...context(guardedFacts), requirements }).review?.issues.length, 1);
});

test('old qualifications cannot certify the new Reviewer contract', () => {
    assert.equal(QUALIFICATION_VERSION, 'python-unittest-v9');
    assert.equal(qualificationAppliesToRequest({ qualificationVersion: 'python-unittest-v8', envType: 'custom', modelName: 'fixture',
        endpointKey: 'fixture-endpoint' }, { envType: 'custom', modelName: 'fixture', endpointKey: 'fixture-endpoint' }), false);
});
