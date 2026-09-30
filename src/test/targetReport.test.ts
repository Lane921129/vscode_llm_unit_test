import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { BatchJournal } from '../pipeline/batchJournal';
import { ReportIdentity, summarizeTarget, writeTargetReports } from '../pipeline/targetReport';
import { setLanguage } from '../i18n/core';

test('concise reports bind tests, target coverage and mutations to one retained candidate in both languages', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-report-'));
    try {
        const code = 'import unittest\n# retained test ```` and <script>\n';
        fs.writeFileSync(path.join(root, 'retained.py'), code);
        fs.writeFileSync(path.join(root, 'newer_rejected.py'), 'UNRELATED_REJECTED_CODE');
        const identity: ReportIdentity = { schemaVersion: 'target-report-v1', sourcePath: path.join(root, 'sample.py'),
            sourceFile: 'sample.py', target: 'target', modelIdentity: 'local/neutral-model', requestedTier: 'tier2' };
        const sourceHash = evidenceHash('source');
        const mutation = structuredClone(require('../../contracts/quality-policy-cases-v1.json').cases[0].evidence.mutation);
        Object.assign(mutation, { sourcePath: identity.sourcePath, sourceHash, testHash: evidenceHash(code) });
        const state = { target: 'target', terminalStatus: 'round-limit', acceptedTest: 'retained.py',
            acceptedCodeHash: evidenceHash(code), coverage: { coverageText: '20%', selectedTarget: {
                qualifiedName: 'target', executableLines: [2, 3, 4], missingLines: [4], branchesCovered: false } },
            mutation, mutationScore: 100, reviewStatus: 'incomplete', qualityGaps: [],
            sourceStructure: 'UNRELATED_SOURCE', latestMutation: { score: 5 } };
        const journal = new AnalysisJournal(root, 'source', 'target', 'neutral-model');
        journal.record(1, 'pipeline', 'running', {});
        journal.record(1, 'reviewer', 'invalid-response', { diagnostics: ['schema'] });
        for (const language of ['zh-tw', 'en']) {
            setLanguage(language);
            const summary = summarizeTarget(root, state, identity, sourceHash);
            assert.equal(summary.coverage, '66.67% (2/3)');
            assert.equal(summary.mutation, '100.00% (1/1)');
            writeTargetReports(root, identity, sourceHash, journal.runId, { ...journal.snapshot(), ...state }, 'ANALYST_DETAILS');
            const report = fs.readFileSync(path.join(root, 'final_report.md'), 'utf8');
            const failure = fs.readFileSync(path.join(root, 'failure_report.md'), 'utf8');
            assert.match(report, /retained test/);
            assert.match(report, /`````python/);
            assert.match(report, /Lt.*LtE.*KILLED/);
            assert.doesNotMatch(report, /ANALYST_DETAILS|UNRELATED|20%|role_events/);
            assert.match(failure, /ANALYST_DETAILS/);
            assert.match(failure, /\| 1 \| .* \| 1 \| pipeline \| running/);
            assert.match(failure, /\| 2 \| .* \| 1 \| reviewer \| invalid-response/);
            if (language === 'en') { assert.doesNotMatch(report, /[\u4e00-\u9fff]/); }
        }
        for (const changed of [
            { acceptedCodeHash: 'wrong' }, { evidenceValid: false }, { target: 'other' },
            { acceptedTest: '../foreign.py' }
        ]) {
            const summary = summarizeTarget(root, { ...state, ...changed }, identity, sourceHash);
            assert.equal(summary.testFile, undefined);
            assert.match(summary.coverage, /^N\/A/);
            assert.match(summary.mutation, /^N\/A/);
            const claimedPass = summarizeTarget(root, { ...state, terminalStatus: 'passed',
                qualityAssessment: { fullyPassed: true }, ...changed }, identity, sourceHash);
            assert.notEqual(claimedPass.outcome, 'Fully passed');
        }
        for (const changed of [{ targetScope: { kind: 'function', qualifiedName: 'other' } },
            { testHash: 'c'.repeat(64) }, { sourceHash: 'd'.repeat(64) }, { status: 'partial' }]) {
            const summary = summarizeTarget(root, { ...state, mutation: { ...mutation, ...changed } }, identity, sourceHash);
            assert.equal(summary.testFile, 'retained.py');
            assert.equal(summary.mutants, undefined);
            assert.match(summary.mutation, /^N\/A/);
            const claimedPass = summarizeTarget(root, { ...state, terminalStatus: 'passed',
                qualityAssessment: { fullyPassed: true }, mutation: { ...mutation, ...changed } }, identity, sourceHash);
            assert.match(claimedPass.reason, /could not be verified/);
        }
        const execution = summarizeTarget(root, { ...state, validationMode: 'execution' }, identity, sourceHash);
        assert.equal(execution.mutation, 'N/A (Not run)');
        assert.equal(execution.coverage, 'N/A (Not run)');
        writeTargetReports(root, identity, sourceHash, journal.runId, { ...state, terminalStatus: 'passed',
            qualityAssessment: { fullyPassed: true }, acceptedCodeHash: 'missing' }, 'AUDIT');
        const incomplete = fs.readFileSync(path.join(root, 'failure_report.md'), 'utf8');
        assert.match(incomplete, /could not be verified/);
        assert.doesNotMatch(incomplete, /final tests passed|## Final outcome: Fully passed/);
    } finally { setLanguage('zh-tw'); fs.rmSync(root, { recursive: true, force: true }); }
});

test('batch reports exclude skipped and unselected targets while preserving failures and missing evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-report-'));
    try {
        const source = path.join(root, 'source'), output = path.join(root, 'output');
        fs.mkdirSync(source); fs.mkdirSync(output);
        fs.mkdirSync(path.join(output, 'unrelated-project'));
        fs.writeFileSync(path.join(output, 'unrelated-project', 'final_report.md'), 'UNSELECTED_PROJECT_CODE');
        const batch = new BatchJournal(output, source, { model: 'local/neutral', buildTimestamp: 'test', python: 'python' });
        batch.discover(path.join(source, 'empty.py'), []);
        batch.discover(path.join(source, 'sample.py'), ['dummy_noise', 'placeholder', 'target', 'not_started']);
        batch.start();
        for (const [id, target, status] of [[0, 'dummy_noise', 'dummy-skipped'], [1, 'placeholder', 'stub-smoke-generated'],
            [2, 'target', 'failed']] as const) {
            const directory = path.join(output, target); fs.mkdirSync(directory);
            batch.begin(id); batch.attach(id, directory);
            const identity: ReportIdentity = { schemaVersion: 'target-report-v1', sourcePath: path.join(source, 'sample.py'),
                sourceFile: 'sample.py', target, modelIdentity: 'local/neutral', requestedTier: 'tier2' };
            const journal = new AnalysisJournal(directory, 'source', target, 'neutral', undefined, 'full', identity);
            journal.record(0, 'pipeline', 'running', {});
            journal.knowledge({ terminalStatus: status, ...(status === 'failed' ? {
                failure: 'ModuleNotFoundError: missing_fixture', failureCategory: 'environment' } : {}) });
            writeTargetReports(directory, identity, journal.sourceHash, journal.runId, journal.snapshot(), 'PROCESS_DETAILS');
            assert.equal(fs.existsSync(path.join(directory, 'final_report.md')), status === 'failed');
            if (status === 'dummy-skipped') { batch.dummy(id); }
            batch.refresh(id);
        }
        batch.finish('cancelled');
        const summary = fs.readFileSync(path.join(output, 'batch_summary.md'), 'utf8');
        assert.doesNotMatch(summary, /dummy_noise|placeholder|not_started|empty.py|UNSELECTED|unrelated-project/);
        assert.match(summary, /sample.py :: target/);
        assert.match(summary, /missing_fixture/);
        assert.match(summary, /target\/final_report.md/);
        assert.match(fs.readFileSync(path.join(output, 'failure_report.md'), 'utf8'), /target\/failure_report.md/);
        const inventory = JSON.parse(fs.readFileSync(path.join(output, 'batch_manifest.json'), 'utf8'));
        assert.equal(inventory.expectedTargets, 4); assert.equal(inventory.finishedTargets, 3);
        assert.equal(inventory.allTargetsPassed, false);
        // A workflow alone cannot stand in for a missing final report on a real target.
        fs.unlinkSync(path.join(output, 'target', 'final_report.md'));
        batch.refresh(2);
        const reread = JSON.parse(fs.readFileSync(path.join(output, 'batch_manifest.json'), 'utf8'));
        assert.equal(reread.targets[2].terminalStatus, 'incomplete-report');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
