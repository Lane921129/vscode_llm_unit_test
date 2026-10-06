import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CandidatePipelineHooks, CandidateValidationError, validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { RejectedCandidateStore } from '../pipeline/rejectedCandidateStore';
import { RepairResponseError } from '../pipeline/repairDiagnostics';
import { createResultLayout, roundDirectory } from '../pipeline/resultLayout';
import { ReportIdentity, writeTargetReports } from '../pipeline/targetReport';

const passed = 'test_keep (Cases.test_keep) ... ok\nRan 1 test\nOK';
const noopHooks: CandidatePipelineHooks = {
    validate: async () => undefined,
    review: async () => ({ issues: [] }),
    revise: async () => { throw Error('unexpected revision'); },
    execute: async () => ({ ok: true, out: passed, qualityGaps: [] }),
    event: () => {}, checkCancelled: () => {}
};

test('rejected versions preserve actual attempt, gate, and code before retained baseline restoration', async () => {
    const rejections: unknown[][] = [];
    const validated: string[] = [];
    const executed: string[] = [];
    const result = await validateTestCandidate('invalid-initial', {
        ...noopHooks,
        validate: async code => {
            validated.push(code);
            return code === 'invalid-initial' ? {
                reason: 'observed assertion mismatch', gate: 'assertion-evidence', reasonCode: 'trace-evidence-rejected'
            } : undefined;
        },
        revise: async (_code, _feedback, _role, attempt) => {
            assert.equal(rejections.length, attempt, 'each rejection is recorded before requesting the next candidate');
            return `revision-${attempt}`;
        },
        validateRevision: async (_previous, candidate) => candidate === 'revision-1'
            ? { reason: 'changed passing method', reasonCode: 'unrelated-method-change' } : undefined,
        execute: async code => {
            executed.push(code);
            return { ok: code === 'revision-3', out: code === 'revision-3' ? passed : 'AssertionError: failed', qualityGaps: [] };
        },
        rejectedCandidate: async (...args) => { await Promise.resolve(); rejections.push(args); }
    }, 3);
    assert.equal(result.code, 'revision-3');
    assert.deepEqual(rejections, [
        ['invalid-initial', 0, 'assertion-evidence', 'trace-evidence-rejected'],
        ['revision-1', 1, 'revision-scope', 'unrelated-method-change'],
        ['revision-2', 2, 'execution', 'candidate-execution-failed']
    ]);
    assert.deepEqual(validated, ['invalid-initial', 'revision-2', 'revision-3']);
    assert.deepEqual(executed, ['revision-2', 'revision-3']);
});

test('legacy structure failures, regressions, repeated candidates, and blocking reviews have distinct stable reasons', async () => {
    const rejections: unknown[][] = [];
    const record: CandidatePipelineHooks['rejectedCandidate'] = (...args) => { rejections.push(args); };
    await assert.rejects(validateTestCandidate('bad-structure', {
        ...noopHooks, validate: async () => 'missing tests', rejectedCandidate: record
    }, 0), CandidateValidationError);
    let checkpointed = 0;
    await assert.rejects(validateTestCandidate('dropped-passing-case', {
        ...noopHooks, execute: async () => ({ ok: true, out: 'Ran 0 tests\nOK', qualityGaps: [] }),
        executable: () => { checkpointed++; }, rejectedCandidate: record
    }, 0, { code: 'baseline', output: passed }), CandidateValidationError);
    await assert.rejects(validateTestCandidate('same', {
        ...noopHooks, execute: async () => ({ ok: false, out: 'ImportError: missing setup', qualityGaps: [] }),
        revise: async () => 'same', rejectedCandidate: record
    }, 1), CandidateValidationError);
    await assert.rejects(validateTestCandidate('review-rejected', {
        ...noopHooks, review: async () => ({ issues: [{ id: 'self-mock', severity: 'blocking',
            reason: 'target replaced', evidence: 'target replaced', action: 'call target', test: 'test_keep' }] }),
        rejectedCandidate: record
    }, 0), CandidateValidationError);
    assert.equal(checkpointed, 0);
    assert.deepEqual(rejections, [
        ['bad-structure', 0, 'unittest-structure', 'candidate-structure-rejected'],
        ['dropped-passing-case', 0, 'execution', 'candidate-regression'],
        ['same', 0, 'execution', 'candidate-execution-failed'],
        ['same', 1, 'candidate-deduplication', 'repeated-candidate'],
        ['review-rejected', 0, 'review', 'review-blocking']
    ]);
});

test('unusable repair response records no invented Python, while transport failure is not a candidate rejection', async () => {
    const rejections: unknown[][] = [];
    let revisions = 0;
    const result = await validateTestCandidate('first', {
        ...noopHooks,
        execute: async code => ({ ok: code === 'recovered', out: code === 'recovered' ? passed : 'AssertionError: first', qualityGaps: [] }),
        revise: async () => {
            if (++revisions === 1) {
                throw new RepairResponseError({ version: 'repair-diagnostics-v1', gate: 'response-format',
                    reasonCodes: ['extra-text'], previousTestHash: evidenceHash('first'), previousTestUnchanged: true });
            }
            return 'recovered';
        },
        rejectedCandidate: (...args) => { rejections.push(args); }
    }, 1);
    assert.equal(result.code, 'recovered');
    assert.deepEqual(rejections, [
        ['first', 0, 'execution', 'candidate-execution-failed'],
        ['', 1, 'response-format', 'extra-text']
    ]);
    rejections.length = 0;
    await assert.rejects(validateTestCandidate('first', {
        ...noopHooks, execute: async () => ({ ok: false, out: 'AssertionError: first', qualityGaps: [] }),
        revise: async () => { throw Error('transport unavailable'); },
        rejectedCandidate: (...args) => { rejections.push(args); }
    }), /transport unavailable/);
    assert.deepEqual(rejections, [['first', 0, 'execution', 'candidate-execution-failed']]);
});

test('journal hashes complete provider responses and preserves parsed evidence, Python, and execution output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'response-journal-'));
    try {
        const journal = new AnalysisJournal(root, 'source', 'target', 'model');
        const raw = 'PRIVATE_PROVIDER_ENVELOPE';
        const providerResponse = { choices: [{ content: 'PRIVATE_PROVIDER_CHOICE' }] };
        const detail = { raw, responseHash: 'forged', responseCharacters: -1, providerResponse,
            code: 'import unittest\n# extracted candidate', rawExecution: 'Ran 1 test\nOK',
            result: { issues: [] }, diagnostics: ['schema'], nested: { raw_response: raw } };
        journal.record(1, 'reviewer', 'invalid-response', detail);
        const text = fs.readFileSync(path.join(root, 'role_events.jsonl'), 'utf8');
        const saved = JSON.parse(text).detail;
        assert.doesNotMatch(text, /PRIVATE_PROVIDER/);
        assert.equal(saved.responseHash, evidenceHash(raw));
        assert.equal(saved.responseCharacters, raw.length);
        assert.equal(saved.providerResponseHash, evidenceHash(JSON.stringify(providerResponse)));
        assert.equal(saved.providerResponseCharacters, JSON.stringify(providerResponse).length);
        assert.equal(saved.nested.raw_responseHash, evidenceHash(raw));
        assert.equal(saved.code, detail.code);
        assert.equal(saved.rawExecution, detail.rawExecution);
        assert.deepEqual(saved.result, detail.result);
        assert.equal(detail.raw, raw, 'the provider parser input is not mutated');
        assert.doesNotMatch(fs.readFileSync(path.join(root, 'function_knowledge.json'), 'utf8'), /PRIVATE_PROVIDER/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failure timeline links only hash-matching rejected artifacts within its session in both layouts', () => {
    for (const organized of [false, true]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rejection-report-'));
        try {
            fs.writeFileSync(path.join(root, 'target.json'), '{}');
            const directory = organized ? createResultLayout(root) : root;
            if (organized) { fs.mkdirSync(roundDirectory(directory, 1), { recursive: true }); }
            const journal = new AnalysisJournal(directory, 'source', 'target', 'model');
            const store = new RejectedCandidateStore(directory, { sourceHash: journal.sourceHash, target: 'target', runId: journal.runId });
            const code = 'import unittest\nclass Cases(unittest.TestCase):\n    def test_bad(self):\n        self.assertEqual(1, 2)\n';
            const artifact = store.record({ code, phase: 'seed', tier: 1, attempt: 2,
                gate: 'execution', reasonCode: 'candidate-execution-failed' });
            journal.record(1, 'candidate-artifact', 'rejected', artifact);
            for (const artifactPath of ['../outside.py', `rejected_candidates/../${path.basename(artifact.artifactPath!)}`,
                artifact.artifactPath!.replace('/', '\\'), `/${artifact.artifactPath}`, 'https://example.test/candidate.py']) {
                journal.record(1, 'candidate-artifact', 'rejected', { ...artifact, artifactPath });
            }
            journal.record(1, 'candidate-artifact', 'rejected', { ...artifact, runId: 'other-run' });
            journal.record(1, 'candidate-artifact', 'rejected', { ...artifact, sourceHash: 'other-source' });
            journal.record(1, 'candidate-artifact', 'rejected', { ...artifact, status: 'withheld' });
            journal.record(1, 'candidate-artifact', 'rejected', { ...artifact, codeHash: 'a'.repeat(64) });
            const corrupt = store.record({ code: code + '# corrupt later\n', phase: 'seed', tier: 1, attempt: 3,
                gate: 'execution', reasonCode: 'candidate-execution-failed' });
            fs.writeFileSync(path.join(directory, corrupt.artifactPath!), 'tampered');
            journal.record(1, 'candidate-artifact', 'rejected', corrupt);
            const identity: ReportIdentity = { schemaVersion: 'target-report-v1', sourcePath: 'sample.py',
                sourceFile: 'sample.py', target: 'target', modelIdentity: 'local/model', requestedTier: 'tier1' };
            writeTargetReports(directory, identity, journal.sourceHash, journal.runId,
                { ...journal.snapshot(), terminalStatus: 'failed' }, '');
            const shared = fs.readFileSync(path.join(directory, 'workflow_report.md'), 'utf8');
            assert.equal((shared.match(/\[candidate_[a-f0-9]+\.py\]/g) || []).length, 1);
            assert.ok(shared.includes(`](${artifact.artifactPath})`));
            assert.match(shared, /attempt: 2/);
            assert.match(shared, /gate: execution/);
            const failure = fs.readFileSync(path.join(organized ? roundDirectory(directory, 1) : root, 'failure_report.md'), 'utf8');
            assert.ok(failure.includes(`](${organized ? '../_run/' : ''}${artifact.artifactPath})`));
            assert.equal((failure.match(/\[candidate_[a-f0-9]+\.py\]/g) || []).length, 1);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});
