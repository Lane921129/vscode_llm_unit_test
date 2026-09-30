import { createResultLayout, resultArtifactPath, preserveCandidate, roundDirectory } from '../pipeline/resultLayout';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalysisJournal, evidenceHash } from '../pipeline/analysisJournal';
import { BatchJournal } from '../pipeline/batchJournal';
import { ReportIdentity, summarizeTarget, writeTargetReports, renderFinalReport } from '../pipeline/targetReport';
import { MutationRecord } from '../mutation/mutationResult';
import { createDefaultQualityPolicy, createStrictQualityPolicy } from '../pipeline/qualityPolicy';
import { setLanguage } from '../i18n/core';

test('mutation code table follows the unchanged summary with one row per variant and safe bilingual code', () => {
    const identity: ReportIdentity = { schemaVersion: 'target-report-v1', sourcePath: 'sample.py',
        sourceFile: 'sample.py', target: 'target', modelIdentity: 'local/test', requestedTier: 'tier2' };
    const mutants: MutationRecord[] = [
        { id: 'a'.repeat(64), kind: 'binop', line: 8, column: 15, position: 0,
            from: 'Div', to: 'FloorDiv', status: 'KILLED', codeChange: { schemaVersion: 'mutation-code-v1',
                before: 'height_m = height_cm / 100', after: 'height_m = height_cm // 100' } },
        { id: 'b'.repeat(64), kind: 'constant', line: 8, column: 27, position: 0,
            from: '100', to: '0', status: 'SURVIVED', codeChange: { schemaVersion: 'mutation-code-v1',
                before: 'height_m = height_cm / 100', after: 'height_m = height_cm / 0' } },
        { id: 'c'.repeat(64), kind: 'constant', line: 10, column: 4, position: 0,
            from: 'True', to: 'False', status: 'TIMEOUT', codeChange: { schemaVersion: 'mutation-code-v1',
                before: 'if True:\n    return "<script>|`*_[]&"', after: 'if False:\n    return "<script>|`*_[]&"' } },
        { id: 'd'.repeat(64), kind: 'return', line: 12, column: 4, position: 0,
            from: 'return_value', to: 'None', status: 'NOT_RUN' }
    ];
    const summary = { included: true, outcome: 'Pending', reason: 'Incomplete', coverage: '100%', mutation: 'N/A', mutants };
    try {
        for (const language of ['zh-tw', 'en']) {
            setLanguage(language);
            const report = renderFinalReport(identity, summary, false);
            const heading = language === 'en' ? '### Code changes for each mutation' : '### 突變程式碼逐項對照';
            const [original, detail] = report.split(heading);
            assert.match(original, /\| 8:15 \| Div \| FloorDiv \| KILLED \|/);
            assert.match(original, /\| 8:27 \| 100 \| 0 \| SURVIVED \|/);
            const rows = detail.split('\n').filter(line => /^\| \d+:/.test(line));
            assert.equal(rows.length, 4);
            assert.ok(rows[0].includes('`height_m = height_cm // 100`'));
            assert.ok(rows[1].includes('`height_m = height_cm / 0`'));
            assert.ok(rows.every(row => row.split(/(?<!\\)\|/).length === 7), 'code cannot inject extra table cells');
            assert.ok(rows[2].includes('`if True:` ↵ ``return "<script>\\|`*_[]&"``'));
            assert.doesNotMatch(detail, /<\/?code>|<br>|&nbsp;|&#\d+;/);
            assert.match(rows[3], language === 'en' ? /Code was not saved/ : /此筆紀錄未保存程式碼/);
            if (language === 'en') { assert.doesNotMatch(report, /[\u4e00-\u9fff]/); }
            assert.ok(!renderFinalReport(identity, { ...summary, mutants: [] }, false).includes(heading));
        }
    } finally { setLanguage('zh-tw'); }
});

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
        const scored = structuredClone(require('../../contracts/quality-policy-cases-v1.json').cases
            .find((item: any) => item.name === 'strict-90-of-100-below').evidence.mutation);
        Object.assign(scored, { sourcePath: identity.sourcePath, sourceHash, testHash: evidenceHash(code) });
        for (const language of ['zh-tw', 'en']) {
            setLanguage(language);
            const updated = summarizeTarget(root, { ...state, mutation: scored, qualityPolicy: createDefaultQualityPolicy(),
                terminalStatus: 'execution-passed-review-incomplete' }, identity, sourceHash);
            assert.match(updated.mutation, /90.00%.*80%/);
            assert.doesNotMatch(updated.reason, /存活突變|surviving mutants/);
            assert.match(updated.reason, /Reviewer|review/i);
            const historical = summarizeTarget(root, { ...state, mutation: scored, qualityPolicy: createStrictQualityPolicy() }, identity, sourceHash);
            assert.match(historical.mutation, /90.00%.*100%/);
            assert.match(historical.reason, /存活突變|surviving mutants/);
            const invalidPolicy = { ...createDefaultQualityPolicy(), policyHash: '0'.repeat(64) };
            const unverified = summarizeTarget(root, { ...state, mutation: scored, qualityPolicy: invalidPolicy }, identity, sourceHash);
            assert.doesNotMatch(unverified.mutation, /threshold|門檻/);
            if (language === 'en') { assert.doesNotMatch(updated.mutation + updated.reason, /[\u4e00-\u9fff]/); }
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


test('organized reports isolate rounds, preserve rejected candidates and fail closed on missing evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round-report-'));
    try {
        setLanguage('en');
        fs.writeFileSync(path.join(root, 'target.json'), '{}');
        const data = createResultLayout(root);
        const identity: ReportIdentity = { schemaVersion: 'target-report-v1', sourcePath: path.join(root, 'source.py'),
            sourceFile: 'source.py', target: 'target', modelIdentity: 'local/neutral', requestedTier: 'tier2' };
        const journal = new AnalysisJournal(data, 'source', 'target', 'neutral');
        const round1 = roundDirectory(data, 1), round2 = roundDirectory(data, 2);
        fs.mkdirSync(round1); fs.mkdirSync(round2);
        const code = 'import unittest\n# retained\n';
        fs.writeFileSync(path.join(round1, 'loop1_test.py'), code);
        const candidate = path.join(round2, 'loop2_test.py');
        fs.writeFileSync(candidate, '# rejected'); preserveCandidate(candidate); preserveCandidate(candidate);
        fs.writeFileSync(candidate, code); preserveCandidate(candidate);
        assert.equal(fs.readdirSync(round2).filter(name => name.startsWith('candidate_')).length, 2);
        journal.record(1, 'validation', 'accepted', {});
        journal.record(2, 'validation', 'failed', { reason: 'ROUND_TWO_ONLY' });
        journal.knowledge({ terminalStatus: 'retained-after-failure', acceptedTest: 'loop1_test.py', acceptedCodeHash: evidenceHash(code),
            failure: 'ROUND_TWO_ONLY', failureCategory: 'validation', reviewStatus: 'incomplete' });
        const body = 'setup\n## Test round 1\nFIRST_ROUND_ONLY\n```python\n## Test round 99\n```\n'
            + '## Test round 2\nSECOND_ROUND_ONLY\n';
        writeTargetReports(data, identity, journal.sourceHash, journal.runId, journal.snapshot(), body);
        assert.deepEqual(fs.readdirSync(root).sort(), ['failure_report.md', 'final_report.md', 'loop']);
        const first = fs.readFileSync(path.join(round1, 'report.md'), 'utf8');
        const second = fs.readFileSync(path.join(round2, 'failure_report.md'), 'utf8');
        assert.match(first, /FIRST_ROUND_ONLY/); assert.doesNotMatch(first, /SECOND_ROUND_ONLY|ROUND_TWO_ONLY/);
        assert.match(second, /SECOND_ROUND_ONLY|ROUND_TWO_ONLY/); assert.doesNotMatch(second, /FIRST_ROUND_ONLY/);
        assert.equal(fs.existsSync(roundDirectory(data, 99)), false);
        assert.doesNotMatch(first + second, /[\u4e00-\u9fff]/);
        const final = fs.readFileSync(path.join(root, 'final_report.md'), 'utf8');
        assert.match(final, /loop\/1\/loop1_test.py/); assert.doesNotMatch(final, /rejected|SECOND_ROUND_ONLY/);
        assert.equal(resultArtifactPath(data, 'loop1_test.py'), path.join(round1, 'loop1_test.py'));
        for (const name of ['../escape.py', 'a:b', 'loop/1/test.py', '..']) {
            assert.throws(() => resultArtifactPath(data, name));
        }
        fs.unlinkSync(path.join(round1, 'loop1_test.py'));
        assert.equal(summarizeTarget(data, journal.snapshot(), identity, journal.sourceHash).testFile, undefined);
        fs.writeFileSync(path.join(data, 'layout.json'), '{"schemaVersion":"unknown"}');
        assert.throws(() => resultArtifactPath(root, 'loop1_test.py'));
    } finally { setLanguage('zh-tw'); fs.rmSync(root, { recursive: true, force: true }); }
});
