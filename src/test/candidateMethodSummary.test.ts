import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { summarizeCandidateMethods, renderCandidateMethodCounts, renderCandidateMethodTimeline, readCandidateMethodSummary } from '../pipeline/candidateMethodSummary';
import { createResultLayout, resultArtifactPath, roundDirectory } from '../pipeline/resultLayout';
import { ReportIdentity, writeTargetReports } from '../pipeline/targetReport';
import { describeStageEvent } from '../pipeline/resultPresentation';
import { getLanguage, setLanguage } from '../i18n/core';

const sourceHash = evidenceHash('source'), seedHash = evidenceHash('seed'), generatedHash = evidenceHash('generated'), mergedHash = evidenceHash('merged');
const seed = { id: 'Cases.test_keep', fingerprint: evidenceHash('seed method') };
const added = { id: 'Cases.test_boundary', fingerprint: evidenceHash('boundary method') };
const identity = { runId: 'run', sourceHash, target: 'target', retainedCodeHash: seedHash };
const event = (stage: string, status: string, detail: unknown, loop = 1) => ({ runId: 'run', sourceHash, loop, stage, status, detail });
const inventoried = (codeHash: string, methods: unknown[], phase = 'generated', baselineMethods: unknown[] = []) =>
    event('candidate-methods', 'inventoried', { schemaVersion: 'candidate-methods-v1', target: 'target', codeHash,
        phase, methods, baselineCodeHash: seedHash, baselineMethods });

test('counts use distinct AST method versions and never count merged baseline or duplicate generation attempts twice', () => {
    const events = [inventoried(seedHash, [seed]), inventoried(generatedHash, [added], 'generated', [seed]),
        inventoried(generatedHash, [added], 'generated', [seed]), inventoried(mergedHash, [seed, added], 'merged', [seed]),
        event('candidate-artifact', 'rejected', { codeHash: mergedHash }),
        event('candidate-artifact', 'rejected', { codeHash: mergedHash }),
        event('executable-baseline', 'checkpointed', { codeHash: seedHash })];
    const summary = summarizeCandidateMethods(events, identity);
    assert.deepEqual(summary.generated, { count: 2, incomplete: false });
    assert.deepEqual(summary.added, { count: 2, incomplete: false });
    assert.deepEqual(summary.rejected, { count: 2, incomplete: false });
    assert.deepEqual(summary.retained, { count: 1, incomplete: false });
    assert.equal(summary.candidates.length, 3);
    assert.equal(summary.candidates.find(row => row.codeHash === mergedHash)?.status, 'rejected');
    assert.equal(summary.candidates.find(row => row.codeHash === seedHash)?.status, 'retained');
    assert.deepEqual(summarizeCandidateMethods(events, { ...identity, retainedCodeHash: mergedHash }).retained,
        { count: 2, incomplete: false });
});

test('changed existing methods are generated versions, not newly added methods', () => {
    const changed = { ...seed, fingerprint: evidenceHash('changed assertion') };
    const summary = summarizeCandidateMethods([inventoried(generatedHash, [changed, added], 'generated', [seed])], identity);
    assert.deepEqual(summary.generated, { count: 2, incomplete: false });
    assert.deepEqual(summary.added, { count: 1, incomplete: false });
});

test('unparsed responses and missing inventories preserve unknown counts and known lower bounds', () => {
    const unavailable = event('candidate-methods', 'unavailable', { codeHash: evidenceHash('bad syntax'), phase: 'generated' });
    const events = [inventoried(seedHash, [seed]), unavailable,
        event('candidate-artifact', 'rejected', { codeHash: evidenceHash('bad syntax'), withheldReason: 'not-extracted-python' })];
    const summary = summarizeCandidateMethods(events, identity);
    assert.deepEqual(summary.generated, { count: 1, incomplete: true });
    assert.deepEqual(summary.added, { count: 1, incomplete: true });
    assert.deepEqual(summary.rejected, { count: null, incomplete: true });
    assert.equal(summary.candidates.find(row => row.phase === 'generated' && row.codeHash !== seedHash)?.methods, null);
    const legacy = summarizeCandidateMethods([event('scenarios', 'observed', { codeHash: seedHash, scenarios: [seed] })], identity);
    assert.equal(legacy.generated.count, null, 'execution inventories alone cannot establish total generation');
    assert.equal(legacy.rejected.count, null);
    assert.equal(legacy.retained.count, 1, 'a verified same-hash legacy scenario inventory can establish retained methods');
    assert.equal(summarizeCandidateMethods([], identity).retained.count, null);
});

test('a bare-method inventory recovered after successful AST merge resolves the same raw hash once', () => {
    const rawHash = evidenceHash('    def test_boundary(self):\n        self.assertEqual(target(2), 3)\n');
    const unavailable = event('candidate-methods', 'unavailable', { schemaVersion: 'candidate-methods-v1',
        codeHash: rawHash, phase: 'generated', baselineCodeHash: seedHash, baselineMethods: [seed] }, 2);
    const baseline = event('scenarios', 'observed', { codeHash: seedHash, scenarios: [seed] });
    const pending = summarizeCandidateMethods([baseline, unavailable], identity, 2);
    assert.deepEqual(pending.generated, { count: null, incomplete: true });
    assert.equal(pending.added.count, null);
    const recovered = { ...inventoried(rawHash, [added], 'generated', [seed]), loop: 2 };
    const merged = { ...inventoried(mergedHash, [seed, added], 'merged', [seed]), loop: 2 };
    const accepted = event('validation', 'accepted', { codeHash: mergedHash }, 2);
    const events = [baseline, unavailable, merged, recovered, recovered, accepted];
    const summary = summarizeCandidateMethods(events, { ...identity, retainedCodeHash: mergedHash }, 2);
    assert.deepEqual(summary.generated, { count: 1, incomplete: false });
    assert.deepEqual(summary.added, { count: 1, incomplete: false });
    assert.deepEqual(summary.retained, { count: 2, incomplete: false });
    assert.equal(summary.candidates.filter(row => row.codeHash === rawHash).length, 1,
        'failed extraction and recovered inventory refer to one raw candidate');
    assert.deepEqual(summary.candidates.find(row => row.codeHash === rawHash), { codeHash: rawHash, loop: 2,
        phase: 'generated', methods: 1, added: 1, status: 'inventoried' });
    assert.equal(summary.candidates.find(row => row.codeHash === mergedHash)?.phase, 'merged');
    assert.equal(summary.candidates.find(row => row.codeHash === mergedHash)?.status, 'retained');
    assert.deepEqual(summarizeCandidateMethods(events.filter(item => item !== merged), identity, 2).generated,
        summary.generated, 'the merged baseline cannot be counted as model generation');
    const foreign = { ...recovered, runId: 'another-run' };
    assert.equal(summarizeCandidateMethods([baseline, unavailable, foreign], identity, 2).generated.count, null,
        'a recovered inventory from another run cannot resolve unknown generation');
});

test('foreign identity, conflicting inventories, malformed method identities, and limits cannot manufacture counts', () => {
    for (const events of [
        [{ ...inventoried(seedHash, [seed]), runId: 'other' }],
        [{ ...inventoried(seedHash, [seed]), sourceHash: evidenceHash('foreign') }],
        [event('candidate-methods', 'inventoried', { schemaVersion: 'candidate-methods-v1', target: 'other', codeHash: seedHash, methods: [seed] })],
        [inventoried(seedHash, [seed]), event('candidate-artifact', 'rejected', { codeHash: seedHash, runId: 'foreign' })],
        [inventoried(seedHash, [seed]), event('candidate-artifact', 'rejected', { codeHash: seedHash, sourceHash: evidenceHash('foreign') })],
        [inventoried(seedHash, [seed]), inventoried(seedHash, [added])],
        Array.from({ length: 4097 }, () => inventoried(seedHash, [seed]))
    ]) { assert.equal(summarizeCandidateMethods(events, identity).generated.count, null); }
    for (const invalid of [[seed, seed], [{ ...seed, fingerprint: 'forged' }], Array.from({ length: 257 }, () => seed)]) {
        const summary = summarizeCandidateMethods([inventoried(seedHash, invalid)], identity);
        assert.equal(summary.generated.count, null);
        assert.equal(summary.retained.count, null);
    }
});

test('per-round tables do not inherit later candidates or final retained counts', () => {
    const later = { ...inventoried(mergedHash, [seed, added]), loop: 2 };
    const summary = summarizeCandidateMethods([inventoried(seedHash, [seed]), later], { ...identity, retainedCodeHash: undefined }, 1);
    assert.equal(summary.generated.count, 1);
    assert.equal(summary.retained.count, null);
    assert.ok(summary.candidates.every(row => row.loop === 1));
});

test('reports show concise counts and separate candidate disposition in both layouts and languages without changing scores', () => {
    const originalLanguage = getLanguage();
    for (const organized of [false, true]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'method-report-'));
        try {
            if (organized) { fs.writeFileSync(path.join(root, 'target.json'), '{}'); }
            const directory = organized ? createResultLayout(root) : root;
            if (organized) { fs.mkdirSync(roundDirectory(directory, 1), { recursive: true }); }
            const journal = new AnalysisJournal(directory, 'source', 'target', 'model');
            const code = 'import unittest\nclass Cases(unittest.TestCase):\n    def test_keep(self):\n        self.assertEqual(1, 1)\n';
            const hash = evidenceHash(code);
            fs.writeFileSync(resultArtifactPath(directory, 'loop1_test.py'), code);
            journal.record(1, 'candidate-methods', 'inventoried', { schemaVersion: 'candidate-methods-v1', target: 'target',
                codeHash: hash, phase: 'generated', methods: [seed], baselineCodeHash: evidenceHash(''), baselineMethods: [] });
            journal.record(1, 'candidate-methods', 'inventoried', { schemaVersion: 'candidate-methods-v1', target: 'target',
                codeHash: generatedHash, phase: 'generated', methods: [seed, added], baselineCodeHash: hash, baselineMethods: [seed] });
            journal.record(1, 'candidate-artifact', 'rejected', { codeHash: generatedHash, reasonCode: 'candidate-execution-failed' });
            const reportIdentity: ReportIdentity = { schemaVersion: 'target-report-v1', sourcePath: 'source.py', sourceFile: 'source.py',
                target: 'target', modelIdentity: 'local/model', requestedTier: 'tier2' };
            const state = { ...journal.snapshot(), terminalStatus: 'retained-after-failure', acceptedTest: 'loop1_test.py', acceptedCodeHash: hash };
            for (const language of ['zh-tw', 'en']) {
                setLanguage(language);
                const final = writeTargetReports(directory, reportIdentity, journal.sourceHash, journal.runId, state, '');
                const text = fs.readFileSync(final, 'utf8');
                const failed = fs.readFileSync(path.join(root, 'failure_report.md'), 'utf8');
                assert.match(text, language === 'en' ? /generated 2; added relative to baseline 2; rejected 2; currently retained 1/ : /生成 2；新增（相對基線）2；拒絕 2；目前保留 1/);
                assert.match(failed, language === 'en' ? /Candidate test method counts/ : /候選測試方法統計/);
                assert.ok(failed.includes(generatedHash.slice(0, 12)));
                assert.match(text, /N\/A/);
                if (language === 'en') { assert.doesNotMatch(text + failed, /\p{Script=Han}/u); }
            }
            fs.writeFileSync(resultArtifactPath(directory, 'loop1_test.py'), 'tampered retained candidate');
            const text = fs.readFileSync(writeTargetReports(directory, reportIdentity, journal.sourceHash, journal.runId, state, ''), 'utf8');
            assert.match(text, getLanguage() === 'en' ? /currently retained Unknown/ : /目前保留 未知/);
            const foreign = readCandidateMethodSummary(directory, { runId: 'foreign', sourceHash: journal.sourceHash, target: 'target' });
            assert.equal(foreign.generated.count, null);
        } finally { setLanguage(originalLanguage); fs.rmSync(root, { recursive: true, force: true }); }
    }
});

test('count rendering is bounded and localized while extraction diagnostics do not mislabel an unparsed reply as missing imports', () => {
    const originalLanguage = getLanguage();
    try {
        for (const language of ['zh-tw', 'en']) {
            setLanguage(language);
            const summary = summarizeCandidateMethods([inventoried(seedHash, [seed]),
                event('candidate-methods', 'unavailable', { codeHash: generatedHash, phase: 'generated' })], identity);
            const text = renderCandidateMethodCounts(summary) + renderCandidateMethodTimeline(summary);
            assert.match(text, /≥ 1/);
            const label = describeStageEvent('candidate-artifact', 'rejected', { withheldReason: 'not-extracted-python',
                reason: 'missing unittest import', raw: 'PRIVATE_PROVIDER_RESPONSE' });
            assert.match(label, language === 'en' ? /Import and test-method checks have not started/ : /尚未進入 import 或測試方法檢查/);
            assert.doesNotMatch(label, /missing unittest import|PRIVATE_PROVIDER_RESPONSE/);
            assert.equal(describeStageEvent('structure', 'rejected', { reasonCode: 'response-not-extracted-python' }), label);
            if (language === 'en') { assert.doesNotMatch(text + label, /\p{Script=Han}/u); }
        }
    } finally { setLanguage(originalLanguage); }
});
