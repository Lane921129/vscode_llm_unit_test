import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CandidateCheckpointStore, ExecutableCandidate } from '../pipeline/candidateCheckpoint';
import { validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { evidenceHash } from '../pipeline/analysisJournal';
import { createStrictQualityPolicy } from '../pipeline/qualityPolicy';

const execution = 'test_keep (Cases.test_keep) ... ok\nRan 1 test\nOK';
function candidate(code = 'import unittest\n'): ExecutableCandidate {
    return { code, execution, coverage: { coverageText: '80%', missingLines: '4' },
        scenarios: [{ id: 'Cases.test_keep', fingerprint: 'setup-and-method' }],
        qualityGaps: ['line 4'], measuredQualityGaps: ['line 4'], reviewStatus: 'incomplete',
        reviewWarnings: [], tier: 1, dependencyVersions: [{ module: 'helper', hash: 'dependency-v1' }] };
}

test('executable checkpoint survives later review failure without fabricating mutation evidence', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'executable-checkpoint-'));
    try {
        const store = new CandidateCheckpointStore(directory, 'source-v1', 'Container.target');
        await assert.rejects(validateTestCandidate('import unittest\n', {
            validate: async () => undefined,
            execute: async () => ({ ok: true, out: execution, qualityGaps: ['line 4'] }),
            executable: code => { store.saveExecutable(candidate(code)); },
            review: async () => { throw new Error('review transport failed'); },
            revise: async () => { throw new Error('unexpected revision'); },
            event: () => {}, checkCancelled: () => {}
        }), /review transport failed/);
        const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'executable_baseline.json'), 'utf8'));
        assert.equal(persisted.sourceHash, 'source-v1');
        assert.equal(persisted.target, 'Container.target');
        assert.equal(persisted.mutationScore, null);
        assert.equal(persisted.mutationStatus, 'not-measured');
        assert.equal(persisted.reviewStatus, 'incomplete');
        assert.equal(evidenceHash(fs.readFileSync(path.join(directory, persisted.testFile), 'utf8')), persisted.codeHash);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('checkpoint retains immutable versions and rejects corrupted artifacts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'executable-checkpoint-'));
    try {
        const store = new CandidateCheckpointStore(directory, 'source-v1', 'target');
        const input = candidate();
        const first = store.saveExecutable(input);
        assert.match(first.testFile, /^exec_[a-f0-9]{16}\.py$/);
        assert.equal(first.codeHash.length, 64);
        assert.equal(store.saveExecutable(input).testFile, first.testFile);
        input.scenarios[0].id = 'changed';
        input.qualityGaps.push('new');
        assert.equal(first.scenarios[0].id, 'Cases.test_keep');
        assert.deepEqual(first.qualityGaps, ['line 4']);
        assert.throws(() => first.scenarios.push({ id: 'other', fingerprint: 'other' }), TypeError);
        const second = store.saveExecutable(candidate('import unittest\n# next candidate\n'));
        assert.notEqual(first.testFile, second.testFile);
        assert.ok(fs.existsSync(path.join(directory, first.testFile)));
        fs.writeFileSync(path.join(directory, second.testFile), 'corrupted');
        assert.throws(() => store.saveExecutable(candidate(second.code)), /code hash/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failed or regressed execution does not enter the executable checkpoint hook', async () => {
    let checkpointed = 0;
    await assert.rejects(validateTestCandidate('candidate', {
        validate: async () => undefined,
        execute: async () => ({ ok: false, out: 'AssertionError: failed', qualityGaps: [] }),
        executable: () => { checkpointed++; },
        review: async () => ({ issues: [] }), revise: async () => 'revision',
        event: () => {}, checkCancelled: () => {}
    }, 0), /未通過/);
    assert.equal(checkpointed, 0);
});

test('invalid measured evidence cannot replace a quality baseline or erase executable work', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-checkpoint-'));
    try {
        const vectors = JSON.parse(fs.readFileSync(path.resolve('contracts/quality-policy-cases-v1.json'), 'utf8'));
        const input = structuredClone(vectors.cases[0].evidence);
        const policy = createStrictQualityPolicy();
        const sourceHash = input.identity.sourceHash;
        const store = new CandidateCheckpointStore(directory, sourceHash, 'target', {
            policy, sourcePath: input.identity.sourcePath, targetScope: input.identity.targetScope });
        const first = store.saveExecutable({ ...candidate(), qualityGaps: [], measuredQualityGaps: [], reviewStatus: 'completed',
            coverage: { assessment: { ...input.coverage.assessment,
                invocationEvidence: { ...input.coverage.assessment.invocationEvidence, testHash: evidenceHash(candidate().code) } },
            coverageText: '100%', missingLines: '' } });
        const mutation = { ...input.mutation, testHash: first.codeHash };
        const good = store.saveQuality(first, mutation);
        assert.equal(good.qualityAssessment?.fullyPassed, true);
        const saved = fs.readFileSync(path.join(directory, 'quality_baseline.json'), 'utf8');
        const next = store.saveExecutable({ ...candidate(first.code + '# later candidate\n'), reviewStatus: 'completed' });
        assert.throws(() => store.saveQuality(next, { ...mutation, testHash: next.codeHash }), /not assessable/);
        assert.equal(store.quality, good);
        assert.equal(store.executable, next);
        assert.equal(fs.readFileSync(path.join(directory, 'quality_baseline.json'), 'utf8'), saved);
        assert.equal(fs.readFileSync(path.join(directory, next.testFile), 'utf8'), next.code);
        assert.throws(() => store.saveQuality(first, { ...mutation, candidateSetId: 'f'.repeat(64) }), /not assessable/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
