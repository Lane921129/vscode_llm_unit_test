import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCaseTablePipeline } from '../pipeline/caseTable/runCaseTablePipeline';
import { reviewCaseTable } from '../pipeline/caseTable/reviewCaseTable';
import { readCaseTable, writeCaseTable } from '../pipeline/caseTable/caseTableStore';
import { CaseRow } from '../pipeline/caseTable/caseTable';
import { getCaseTableReviewPrompt, parseCaseTableReview } from '../roles/testReviewer';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const row = (args: string, action?: string) => JSON.stringify({ ...(action ? { action } : {}), scenario: 'increment',
    category: 'normal', args, kwargs: '{}', mocks: '', requirement: '' });

test('default case-table review additions execute and receive spec predictions; flags do not block usable; off makes no request', async () => {
    for (const enabled of [true, false]) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-review-'));
        try {
            const file = path.join(directory, 'sample.py');
            fs.writeFileSync(file, 'def inc(value):\n    """Return value plus one."""\n    return value + 1\n');
            const roles: string[] = [];
            const result = await runCaseTablePipeline({ filePath: file, funcName: 'inc', projectRoot: directory,
                outputPath: path.join(directory, 'out'), sessionDate: 'review', specOracle: 'auto', qualityAnalyst: 'off',
                ...(enabled ? {} : { caseTableReview: 'off' as const }),
                pythonExecutable: resolvePythonExecutable(undefined, path.resolve(__dirname, '../..')), log: () => {},
                mutation: { engine: 'builtin', workers: 1, stageSeconds: 30 },
                requestModel: async (system, user) => {
                    const role = system.startsWith('Review the input') ? 'case-table-review'
                        : system.startsWith('You predict') ? 'analyst-spec' : 'analyst-scenario';
                    roles.push(role);
                    if (role === 'analyst-scenario') { return row('(1,)'); }
                    if (role === 'case-table-review') {
                        assert.ok(enabled);
                        assert.match(user, /\| C1 \|/);
                        assert.doesNotMatch(user, /self\.assert|def test_/);
                        return [row('(2,)', 'add'), JSON.stringify({ action: 'flag', id: 'C1', reason: 'Confirm this input with the requirement owner.' })].join('\n');
                    }
                    assert.equal(role, 'analyst-spec');
                    assert.doesNotMatch(user, /return value \+ 1|self\.assert/);
                    return JSON.stringify({ expect: user.includes('inc(2)') ? 'return 3' : 'return 2', basis: 'Return value plus one.' });
                } });
            assert.equal(result.stage?.terminal, 'usable');
            assert.equal(result.rows.length, enabled ? 2 : 1);
            assert.equal(roles.filter(role => role === 'case-table-review').length, enabled ? 1 : 0);
            assert.equal(roles.filter(role => role === 'analyst-spec').length, enabled ? 6 : 3);
            if (enabled) {
                const persisted = readCaseTable(result.directory);
                assert.deepEqual(persisted.rows[0].reviewFlags, ['Confirm this input with the requirement owner.']);
                assert.equal(persisted.rows[1].origin, 'reviewer');
                assert.equal(persisted.rows[1].status, 'test-passed');
                assert.equal(persisted.rows[1].oracleStatus, 'spec-matched');
                assert.match(fs.readFileSync(result.stage!.testFile!, 'utf8'), /def test_c2/);
                assert.match(fs.readFileSync(path.join(result.directory, 'final_report.md'), 'utf8'), /Confirm this input/);
            } else { assert.equal(fs.existsSync(path.join(result.directory, 'review.json')), false); }
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
});

test('review repairs only a malformed line once, retains valid flags and caps accepted actions at three', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-review-format-'));
    const seed: CaseRow = { id: 'C1', origin: 'analyst', scenario: 'increment', category: 'normal',
        call: { args: '(1,)', kwargs: '{}' }, mocks: [], status: 'proposed' };
    try {
        let requests = 0;
        const rows = await reviewCaseTable({ directory, rows: [seed], source: 'def inc(x): return x+1', requirements: [],
            validate: async rows => rows,
            ask: async (_system, user, options) => {
                requests++;
                if (options.role === 'case-table-review') { return '{"action":"flag","id":"C1","reason":"keep-valid-flag"}\n{"action":'; }
                assert.equal(options.role, 'case-table-review-correction');
                assert.match(user, /Malformed line:\n\{"action":/);
                assert.doesNotMatch(user, /keep-valid-flag/);
                return row('(2,)', 'add');
            } });
        assert.equal(requests, 2);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[0].reviewFlags, ['keep-valid-flag']);
        writeCaseTable(directory, { version: 'case-table-v1', target: 'inc', rows });
        assert.deepEqual(readCaseTable(directory).rows, rows);
        const flags = Array.from({ length: 4 }, () => '{"action":"flag","id":"C1","reason":"check"}').join('\n');
        assert.equal(parseCaseTableReview(flags, [seed], []).actions.length, 3);
        assert.equal(parseCaseTableReview(flags, [seed], []).rejected[0].reason, 'review-limit');
        let badRequests = 0;
        const unchanged = await reviewCaseTable({ directory, rows: [seed], source: 'def inc(x): return x+1', requirements: [],
            validate: async rows => rows, ask: async () => { badRequests++; return 'bad json'; } });
        assert.equal(badRequests, 2);
        assert.deepEqual(unchanged, [seed]);
        const prompt = getCaseTableReviewPrompt({ table: '| C1 | input |', source: 'def inc(x): return x+1', requirements: [] });
        assert.match(prompt.user, /at most 3 JSON lines/);
        assert.equal((prompt.user.match(/Example:/g) ?? []).length, 1);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
