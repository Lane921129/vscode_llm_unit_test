import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CASE_TABLE_REJECTIONS_FILE, CaseTablePipelineOptions, runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { readCaseTable } from '../pipeline/caseTable/caseTableStore';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const root = path.resolve(__dirname, '../..');
const python = resolvePythonExecutable(undefined, root);
const line = (fields: Record<string, string>) => JSON.stringify({ kwargs: '{}', mocks: '', requirement: '', ...fields });

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-case-'));
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const file = path.join(project, 'bmi.py');
    fs.copyFileSync(path.join(root, 'test', 'test_mut', 'bmi.py'), file);
    fs.writeFileSync(path.join(project, 'requirements.md'), '# 需求\n- R1: 18.5 為健康下界\nR2: 身高為 0 時拋出例外\n', 'utf8');
    return { directory, project, file };
}

function options(env: ReturnType<typeof fixture>, replies: string[], prompts: { system: string; user: string }[],
    overrides: Partial<CaseTablePipelineOptions> = {}): CaseTablePipelineOptions {
    return {
        filePath: env.file, funcName: 'calculate_bmi', projectRoot: env.project, outputPath: path.join(env.directory, 'out'),
        sessionDate: '2026_11_09_01_00', pythonExecutable: python, requirementsFile: 'requirements.md', specOracle: 'auto',
        requestModel: async (system, user) => {
            prompts.push({ system, user });
            const reply = replies.shift();
            if (reply === undefined) { throw new Error('unexpected model request'); }
            return reply;
        },
        log: () => undefined, ...overrides
    };
}

test('BMI in v2 produces case_table.json; invalid rows are marked invalid without affecting the others', async () => {
    const env = fixture();
    const prompts: { system: string; user: string }[] = [];
    const scenario = [
        line({ scenario: '一般體重', category: 'normal', args: '(65, 170)' }),
        line({ scenario: '剛好健康下界', category: 'boundary', args: '(53.465, 170)', requirement: 'R1' }),
        line({ scenario: '參數過多', category: 'error', args: '(1, 2, 3)' }),
        line({ scenario: '模擬不存在的相依', category: 'dependency-failure', args: '(60, 170)', mocks: 'db.fetchone -> None' }),
        line({ scenario: '分類寫錯', category: 'edge', args: '(1, 1)' }),
        'Here are the scenarios:',
        line({ scenario: '只給一個值', category: 'error', args: '(70)' })
    ].join('\n');
    const correction = line({ scenario: '身高為 0', category: 'error', args: '(60, 0)', requirement: 'R2' });
    try {
        const result = await runCaseTablePipeline(options(env, [scenario, correction], prompts));
        assert.equal(result.modelRequests, 2, 'one scenario request and one correction for the single broken JSON line');
        assert.deepEqual(result.rows.map(row => [row.id, row.status, row.reason ?? null]), [
            ['C1', 'proposed', null], ['C2', 'proposed', null], ['C3', 'invalid', 'signature-mismatch'],
            ['C4', 'invalid', 'unknown-dependency'], ['C5', 'invalid', 'signature-mismatch'], ['C6', 'proposed', null]
        ]);
        assert.equal(result.rows[5].requirementId, 'R2');
        const table = readCaseTable(result.directory);
        assert.equal(table.target, 'calculate_bmi');
        assert.deepEqual(table.rows, result.rows);
        const rejections = JSON.parse(fs.readFileSync(path.join(result.directory, CASE_TABLE_REJECTIONS_FILE), 'utf8'));
        assert.deepEqual(rejections.rejected, [
            { line: 5, reason: 'unknown-category', field: 'category', source: 'scenario', corrected: true },
            { line: 6, reason: 'invalid-json', source: 'scenario', corrected: false }
        ]);
        assert.match(prompts[0].user, /line 14: if bmi < 18\.5/);
        assert.match(prompts[0].user, /R1: 18\.5 為健康下界/);
        assert.match(prompts[1].user, /"category":"edge"/);
        assert.match(prompts[1].user, /Output only the one corrected JSON line/);
    } finally { fs.rmSync(env.directory, { recursive: true, force: true }); }
});

test('rows beyond eight are dropped and recorded; a failed correction is recorded for both attempts', async () => {
    const env = fixture();
    const prompts: { system: string; user: string }[] = [];
    const rows = Array.from({ length: 10 }, (_, index) => line({ scenario: `情境 ${index + 1}`, category: 'normal', args: `(${60 + index}, 170)` }));
    try {
        const first = await runCaseTablePipeline(options(env, [rows.join('\n')], prompts));
        assert.equal(first.rows.length, 8);
        assert.deepEqual(first.overLimit, [{ line: 9, reason: 'row-limit' }, { line: 10, reason: 'row-limit' }]);
        assert.equal(first.modelRequests, 1);

        const second = await runCaseTablePipeline(options(env, [[rows[0], '{"scenario": "壞掉'].join('\n'), 'still not json'], prompts));
        assert.equal(second.modelRequests, 2);
        assert.deepEqual(second.rejected, [
            { line: 2, reason: 'invalid-json', source: 'scenario', corrected: false },
            { line: 2, reason: 'invalid-json', source: 'correction' }
        ]);
        assert.notEqual(first.directory, second.directory, 'a second run never overwrites the first');
    } finally { fs.rmSync(env.directory, { recursive: true, force: true }); }
});

test('no usable row stops the target with a model-format failure but keeps the case table evidence', async () => {
    const env = fixture();
    const prompts: { system: string; user: string }[] = [];
    try {
        await assert.rejects(runCaseTablePipeline(options(env, [line({ scenario: '參數過多', category: 'error', args: '(1, 2, 3)' })], prompts)),
            (error: unknown) => error instanceof AnalysisStageError && error.category === 'model-format'
                && (error.diagnostic as { reasonCode: string }).reasonCode === 'no-valid-case-rows'
                && readCaseTable((error.diagnostic as { directory: string }).directory).rows[0].status === 'invalid');
    } finally { fs.rmSync(env.directory, { recursive: true, force: true }); }
});

test('an unreadable or duplicated requirements file is an environment failure before any model request', async () => {
    const env = fixture();
    const prompts: { system: string; user: string }[] = [];
    try {
        await assert.rejects(runCaseTablePipeline(options(env, [], prompts, { requirementsFile: 'missing.md' })),
            (error: unknown) => error instanceof AnalysisStageError && error.category === 'environment');
        fs.writeFileSync(path.join(env.project, 'dup.md'), 'R1: a\nR1: b\n', 'utf8');
        await assert.rejects(runCaseTablePipeline(options(env, [], prompts, { requirementsFile: 'dup.md' })),
            (error: unknown) => error instanceof AnalysisStageError && /requirements-duplicate-id/.test(error.message));
        assert.equal(prompts.length, 0);
    } finally { fs.rmSync(env.directory, { recursive: true, force: true }); }
});
