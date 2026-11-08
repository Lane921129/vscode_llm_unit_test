/**
 * v2 case-table golden (test/fixtures/golden/v2). Independent of the v1 golden:
 * `npm run test:golden -- --update` never rewrites these files. Record only with
 * UPDATE_CASE_TABLE_GOLDEN=1, and only for an intentional v2 behaviour change.
 * Fixed role replies; capture, isolated test runs and builtin mutation are real.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { readCaseTable } from '../pipeline/caseTable/caseTableStore';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const root = path.resolve(__dirname, '../..');
const goldenDirectory = path.join(root, 'test', 'fixtures', 'golden', 'v2');
const update = process.env.UPDATE_CASE_TABLE_GOLDEN === '1';
const line = (fields: Record<string, string>) => JSON.stringify({ kwargs: '{}', mocks: '', requirement: '', ...fields });

const scenarios = [
    {
        name: 'bmi', source: path.join(root, 'test', 'test_mut', 'bmi.py'), target: 'calculate_bmi',
        replies: [[
            line({ scenario: '一般體重', category: 'normal', args: '(65, 170)' }),
            line({ scenario: '健康下界', category: 'boundary', args: '(53.465, 170)' }),
            line({ scenario: '身高為 0', category: 'error', args: '(60, 0)' }),
            line({ scenario: '肥胖', category: 'normal', args: '(90, 170)' }),
            line({ scenario: '參數過多（故意壞列）', category: 'error', args: '(1, 2, 3)' })
        ].join('\n')]
    },
    {
        name: 'database', source: path.join(root, 'eval', 'eval_screening', 'vehicle_db.py'), target: 'authenticate_user',
        replies: [[
            line({ scenario: '帳密正確', category: 'normal', args: '("amy", "pw")', mocks: 'cur.fetchone -> ("amy", "Amy", "admin")' }),
            line({ scenario: '查無使用者', category: 'dependency-failure', args: '("amy", "bad")', mocks: 'cur.fetchone -> None' }),
            line({ scenario: '資料庫錯誤', category: 'dependency-failure', args: '("amy", "pw")', mocks: '_connect -> raise sqlite3.OperationalError' }),
            line({ scenario: '未模擬資料庫（隔離擋下）', category: 'normal', args: '("amy", "pw")' })
        ].join('\n')]
    }
];

for (const scenario of scenarios) {
    test(`v2 golden: ${scenario.name} reaches usable with a measured mutation score`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), `v2-golden-${scenario.name}-`));
        try {
            const project = path.join(directory, 'project');
            fs.mkdirSync(project);
            const file = path.join(project, path.basename(scenario.source));
            fs.copyFileSync(scenario.source, file);
            const replies = [...scenario.replies];
            const result = await runCaseTablePipeline({
                filePath: file, funcName: scenario.target, projectRoot: project, outputPath: path.join(directory, 'out'),
                sessionDate: 'golden', pythonExecutable: resolvePythonExecutable(undefined, root), specOracle: 'off',
                requestModel: async () => { const reply = replies.shift(); if (reply === undefined) { throw new Error('unexpected request'); } return reply; },
                log: () => undefined, mutation: { engine: 'builtin', workers: 1, stageSeconds: 120 }
            });
            const stage = result.stage!;
            assert.equal(stage.terminal, 'usable');
            assert.ok(typeof stage.mutation?.score === 'number');
            assert.ok(result.rows.some(row => row.status === 'test-passed'));
            assert.ok(result.rows.some(row => row.status === 'invalid' || row.status === 'capture-failed'),
                'the deliberately broken row fails on its own');
            const run = stage.mutation!.run!;
            const snapshot = {
                scenario: scenario.name, terminal: stage.terminal, reasonCode: stage.reasonCode, modelRequests: result.modelRequests,
                rows: readCaseTable(result.directory).rows.map(row => ({ id: row.id, status: row.status, reason: row.reason ?? null,
                    actual: row.actual ?? null, expected: row.expected ?? null, oracleStatus: row.oracleStatus ?? null,
                    testMethod: row.testMethod ?? null })),
                testFile: fs.readFileSync(stage.testFile!, 'utf8').replace(/\r\n/g, '\n'),
                mutation: { engine: run.engine, selected: run.counts.selected, executed: run.counts.executed,
                    killed: run.counts.killed, survived: run.counts.survived, score: stage.mutation!.score }
            };
            const goldenFile = path.join(goldenDirectory, `${scenario.name}.json`);
            if (update) {
                fs.mkdirSync(goldenDirectory, { recursive: true });
                fs.writeFileSync(goldenFile, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
            }
            assert.ok(fs.existsSync(goldenFile), `missing v2 golden ${goldenFile}; record it with UPDATE_CASE_TABLE_GOLDEN=1`);
            assert.deepEqual(snapshot, JSON.parse(fs.readFileSync(goldenFile, 'utf8')));
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
}
