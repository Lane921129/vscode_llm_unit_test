import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { collectDesignFindings, SurvivorRowEvidence } from '../pipeline/caseTable/designFindings';
import { CaseRow } from '../pipeline/caseTable/caseTable';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

test('requirements reports include each requirement and an empty no-file table without changing usable', async () => {
    for (const configured of [true, false]) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-requirements-'));
        try {
            const file = path.join(directory, 'sample.py');
            fs.writeFileSync(file, 'def inc(value):\n    return value + 1\n');
            fs.writeFileSync(path.join(directory, 'requirements.md'), 'R1: increment\nR2: boundary\n');
            const result = await runCaseTablePipeline({ caseTableReview: 'off', filePath: file, funcName: 'inc', projectRoot: directory,
                outputPath: path.join(directory, 'out'), sessionDate: 'requirements',
                pythonExecutable: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')),
                specOracle: 'off', qualityAnalyst: configured ? 'off' : 'auto',
                requirementsFile: configured ? 'requirements.md' : '', log: () => {},
                mutation: { engine: 'builtin', workers: 1, stageSeconds: 30 },
                requestModel: async () => JSON.stringify({ scenario: 'increment', category: 'normal', args: '(2,)',
                    kwargs: '{}', mocks: '', requirement: configured ? 'R1' : '' }) });
            assert.equal(result.stage?.terminal, 'usable');
            const report = JSON.parse(fs.readFileSync(path.join(result.directory, 'req.json'), 'utf8'));
            assert.equal(report.hasRequirementsFile, configured);
            assert.equal(report.total, configured ? 2 : 0);
            assert.equal(report.covered, configured ? 1 : 0);
            if (configured) {
                assert.equal(report.rate, 0.5);
                assert.deepEqual(report.requirements[0].rows.map((row: any) => [row.id, row.status]), [['C1', 'test-passed']]);
                assert.equal(report.requirements[1].hasPassingRow, false);
                assert.equal(fs.existsSync(path.join(result.directory, 'design.json')), false);
            } else {
                assert.equal(report.rate, null);
                assert.match(fs.readFileSync(path.join(result.directory, 'req.md'), 'utf8'), /無需求檔/);
                assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.directory, 'design.json'), 'utf8')).findings, []);
            }
            assert.match(fs.readFileSync(path.join(result.directory, 'final_report.md'), 'utf8'), /需求涵蓋/);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
});

test('design findings require every proposed row for the same mutant to be indistinguishable', () => {
    const evidence: SurvivorRowEvidence[] = [1, 2].map(index => ({ mutantId: 'same', rowId: `C${index}`,
        line: 3, original: 'if x > 0:', mutated: 'if x >= 0:' }));
    const rows = evidence.map(item => ({ id: item.rowId, reason: 'survivor-row-indistinguishable' } as CaseRow));
    assert.equal(collectDesignFindings(evidence, rows).length, 1);
    rows[1].reason = 'capture-failed';
    assert.deepEqual(collectDesignFindings(evidence, rows), []);
    assert.deepEqual(collectDesignFindings([], rows), []);
});

test('requirement and design report names fit the v2 path preflight bound', async () => {
    const names = await import('../pipeline/caseTable/artifactNames.js');
    const { LONGEST_V2_ARTIFACT } = await import('../pipeline/batchOutputPath.js');
    for (const name of [names.REQUIREMENTS_COVERAGE_JSON, names.REQUIREMENTS_COVERAGE_MD,
        names.DESIGN_FINDINGS_JSON, names.DESIGN_FINDINGS_MD, names.CASE_TABLE_REVIEW_JSON, names.CASE_TABLE_QUALITY_JSON]) {
        assert.ok(name.length <= LONGEST_V2_ARTIFACT.length, name);
    }
});
