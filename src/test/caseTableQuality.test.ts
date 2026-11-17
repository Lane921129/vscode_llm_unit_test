import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assessCaseTableQuality, CaseTableQualityEvidence } from '../pipeline/caseTable/caseTableQuality';
import { CaseRow } from '../pipeline/caseTable/caseTable';
import { MutationRun } from '../mutation/mutationResult';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { BatchJournal } from '../pipeline/batchJournal';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const passingRows = (): CaseRow[] => [{ id: 'C1', origin: 'analyst', scenario: 'increment', category: 'normal',
    call: { args: '(1,)', kwargs: '{}' }, mocks: [], status: 'test-passed' }];
function evidence(): CaseTableQualityEvidence {
    return { usable: true, coverage: { available: true, linePercent: 100, executableLines: 2,
        missingLines: [], branchesCovered: true, missingBranches: [] },
    mutation: { score: 100, run: { status: 'complete', baselinePassed: true, scoreAvailable: true,
        counts: { selected: 100, killed: 100 } } as MutationRun },
    review: { enabled: true, completed: true, addedRowIds: [] } };
}
for (const item of [
    { name: 'all approved conditions promote to quality-passed', expected: true, change: (_e: CaseTableQualityEvidence, _rows: CaseRow[]) => {} },
    { name: '79 percent mutation remains usable', expected: false, change: (e: CaseTableQualityEvidence) => { e.mutation!.run!.counts.killed = 79; e.mutation!.score = 79; } },
    { name: 'one unresolved Reviewer flag remains usable', expected: false, change: (_e: CaseTableQualityEvidence, rows: CaseRow[]) => { rows[0].reviewFlags = ['confirm requirement']; } },
    { name: 'Reviewer off remains usable', expected: false, change: (e: CaseTableQualityEvidence) => { e.review.enabled = false; } },
    { name: 'one uncovered line remains usable even if displayed percentage is 100', expected: false, change: (e: CaseTableQualityEvidence) => { e.coverage!.missingLines = [2]; } },
    { name: 'an uncovered branch remains usable', expected: false, change: (e: CaseTableQualityEvidence) => { e.coverage!.branchesCovered = false; e.coverage!.missingBranches = ['2->4']; } },
    { name: 'an unfinished Reviewer addition remains usable', expected: false, change: (e: CaseTableQualityEvidence, rows: CaseRow[]) => { e.review.addedRowIds = ['C1']; rows[0].status = 'proposed'; } },
    { name: 'a Reviewer row with a completed spec-mismatch disposition is processed', expected: true, change: (e: CaseTableQualityEvidence, rows: CaseRow[]) => { e.review.addedRowIds = ['C2']; rows.push({ ...rows[0], id: 'C2', status: 'captured', oracleStatus: 'spec-mismatch' }); } },
    { name: 'an incomplete review remains usable', expected: false, change: (e: CaseTableQualityEvidence) => { e.review.completed = false; } },
    { name: 'a failed base never becomes quality-passed', expected: false, change: (e: CaseTableQualityEvidence) => { e.usable = false; } }
]) {
    test(item.name, () => {
        const input = evidence(), rows = passingRows();
        item.change(input, rows);
        const result = assessCaseTableQuality(input, rows);
        assert.equal(result.fullyPassed, item.expected);
        assert.equal(result.reasons.length === 0, item.expected);
    });
}

test('real v2 quality and off targets update cards and verified batch tiers; changed flags invalidate quality', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-quality-'));
    try {
        const source = path.join(directory, 'sample.py');
        fs.writeFileSync(source, 'def inc(value):\n    return value + 1\n');
        const output = path.join(directory, 'batch'); fs.mkdirSync(output);
        const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
        const batch = new BatchJournal(output, directory, { model: 'fixed-reply', buildTimestamp: 'test', python });
        batch.discover(source, ['inc', 'inc']); batch.start();
        const reports: string[] = [];
        for (const id of [0, 1]) {
            const messages: Record<string, any>[] = [];
            batch.begin(id);
            const result = await runCaseTablePipeline({ filePath: source, funcName: 'inc', projectRoot: directory,
                outputPath: directory, batchDirectory: output, sessionDate: `quality-${id}`, pythonExecutable: python,
                qualityAnalyst: 'off', specOracle: 'off', ...(id ? { caseTableReview: 'off' as const } : {}),
                log: () => {}, postMessage: message => messages.push(message),
                onTargetDirectory: report => batch.attach(id, report),
                mutation: { engine: 'builtin', workers: 1, stageSeconds: 30 },
                requestModel: async system => system.startsWith('Review the input') ? '' : JSON.stringify({
                    scenario: 'increment', category: 'normal', args: '(1,)', kwargs: '{}', mocks: '', requirement: '' }) });
            reports.push(result.directory);
            const expected = id ? 'usable' : 'quality-passed';
            assert.equal(result.stage!.terminal, expected);
            assert.equal(result.stage!.qualityAssessment!.fullyPassed, id === 0);
            assert.equal(result.stage!.coverage!.branchesCovered, true);
            const card = messages.find(message => message.command === 'updateOutcome')!;
            assert.equal(card.caseTable.tier, expected);
            assert.equal(card.outcome.kind, id ? 'executed' : 'passed');
            assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'v2_result.json'), 'utf8')).terminal, expected);
            batch.refresh(id);
        }
        batch.finish('completed');
        const summary = JSON.parse(fs.readFileSync(path.join(output, 'batch_failure_summary.json'), 'utf8'));
        assert.equal(summary.tierCounts['quality-passed'], 1);
        assert.equal(summary.tierCounts.usable, 1);
        assert.equal(summary.targets[0].terminalStatus, 'quality-passed');
        const tableFile = path.join(reports[0], 'case_table.json');
        const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
        table.rows[0].reviewFlags = ['new unresolved concern'];
        fs.writeFileSync(tableFile, JSON.stringify(table));
        batch.refresh(0);
        const invalidated = JSON.parse(fs.readFileSync(path.join(output, 'batch_failure_summary.json'), 'utf8'));
        assert.equal(invalidated.tierCounts['quality-passed'], 0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
