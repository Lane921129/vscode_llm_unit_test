import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
    CASE_ROW_STATUSES, CASE_ROW_TRANSITIONS, CaseRow, CaseRowStatus, CaseTableFile,
    caseRowId, isCaseCategory, needsSetup, nextCaseRowIndex, transitionCaseRow
} from '../pipeline/caseTable/caseTable';
import { CASE_TABLE_FILE, CaseTableFormatError, readCaseTable, writeCaseTable } from '../pipeline/caseTable/caseTableStore';
import { parseCaseMocks, parseCaseRows } from '../pipeline/caseTable/caseRowParser';
import {
    CASE_ROW_VALIDATION_REQUEST_VERSION, CASE_ROW_VALIDATION_VERSION,
    applyCaseRowValidation, buildCaseRowValidationRequest
} from '../pipeline/caseTable/caseRowValidation';

const options = { origin: 'analyst' as const, requirementIds: ['R1', 'R2'] };
const line = (fields: Record<string, unknown>) => JSON.stringify(fields);
const valid = (overrides: Record<string, unknown> = {}) => line({
    scenario: 'BMI 剛好 18.5 為健康下界', category: 'boundary', args: '(18.5, 100)', kwargs: '{}', mocks: '', requirement: 'R2', ...overrides
});

test('a broken line is recorded and dropped without affecting the lines around it', () => {
    const text = [
        valid(),
        '{"scenario": "unterminated',
        valid({ scenario: '負數身高', category: 'mystery' }),
        'Here are the rows you asked for:',
        valid({ scenario: '查無車輛', category: 'dependency-failure', args: '(999,)', mocks: 'db.fetchone -> None', requirement: '' })
    ].join('\n');
    const result = parseCaseRows(text, options);
    assert.deepStrictEqual(result.rows.map(row => [row.id, row.scenario, row.status]), [
        ['C1', 'BMI 剛好 18.5 為健康下界', 'proposed'],
        ['C2', '查無車輛', 'proposed']
    ]);
    assert.deepStrictEqual(result.rejected, [
        { line: 2, reason: 'invalid-json' },
        { line: 3, reason: 'unknown-category', field: 'category' },
        { line: 4, reason: 'invalid-json' }
    ]);
    assert.deepStrictEqual(result.rows[1].mocks, [{ dependency: 'db.fetchone', behavior: 'return', value: 'None' }]);
    assert.strictEqual(result.rows[1].requirementId, undefined);
});

test('a valid row keeps every field the host needs later', () => {
    const [row] = parseCaseRows(valid(), options).rows;
    assert.deepStrictEqual(row, {
        id: 'C1', origin: 'analyst', scenario: 'BMI 剛好 18.5 為健康下界', category: 'boundary',
        call: { args: '(18.5, 100)', kwargs: '{}' }, mocks: [], requirementId: 'R2', status: 'proposed'
    });
});

test('category must be one of the five listed values', () => {
    for (const category of ['Boundary', 'edge', '', 'normal ']) {
        const result = parseCaseRows(valid({ category }), options);
        if (category === 'normal ') {
            assert.strictEqual(result.rows[0].category, 'normal', 'surrounding whitespace is not a different category');
            continue;
        }
        assert.deepStrictEqual(result.rejected, [{ line: 1, reason: 'unknown-category', field: 'category' }], category);
    }
    assert.ok(['normal', 'boundary', 'error', 'dependency-failure', 'state'].every(isCaseCategory));
    assert.strictEqual(isCaseCategory('Normal'), false);
});

test('a requirement id that is not in the requirements list is rejected', () => {
    assert.deepStrictEqual(parseCaseRows(valid({ requirement: 'R9' }), options).rejected,
        [{ line: 1, reason: 'unknown-requirement', field: 'requirement' }]);
    assert.deepStrictEqual(parseCaseRows(valid({ requirement: 'R1' }), { ...options, requirementIds: [] }).rejected,
        [{ line: 1, reason: 'unknown-requirement', field: 'requirement' }], 'no requirements file means no requirement id can match');
    assert.strictEqual(parseCaseRows(valid({ requirement: ' R1 ' }), options).rows[0].requirementId, 'R1');
});

test('needs-setup rows become a setup description instead of a literal call', () => {
    const [row] = parseCaseRows(valid({ args: '<needs-setup: 已連線的 sqlite3 Connection，含一筆車輛>', kwargs: '{"x": 1}' }), options).rows;
    assert.deepStrictEqual(row.call, { needsSetup: '已連線的 sqlite3 Connection，含一筆車輛' });
    assert.ok(needsSetup(row.call));
    for (const args of ['<needs-setup:>', '<needs-setup:   >', '<needs-setup 少冒號>']) {
        assert.deepStrictEqual(parseCaseRows(valid({ args }), options).rejected,
            [{ line: 1, reason: 'invalid-needs-setup', field: 'args' }], args);
    }
});

test('scenario text must be present and at most 80 characters', () => {
    assert.deepStrictEqual(parseCaseRows(valid({ scenario: '   ' }), options).rejected, [{ line: 1, reason: 'scenario-empty', field: 'scenario' }]);
    assert.strictEqual(parseCaseRows(valid({ scenario: '界'.repeat(80) }), options).rows.length, 1, '80 CJK characters is within the limit');
    assert.deepStrictEqual(parseCaseRows(valid({ scenario: 'a'.repeat(81) }), options).rejected,
        [{ line: 1, reason: 'scenario-too-long', field: 'scenario' }]);
});

test('missing or mistyped fields are rejected; optional fields may be absent', () => {
    assert.deepStrictEqual(parseCaseRows(line({ category: 'normal', args: '()' }), options).rejected,
        [{ line: 1, reason: 'missing-field', field: 'scenario' }]);
    assert.deepStrictEqual(parseCaseRows(valid({ args: [1, 2] }), options).rejected,
        [{ line: 1, reason: 'field-type', field: 'args' }]);
    assert.deepStrictEqual(parseCaseRows(valid({ args: '  ' }), options).rejected,
        [{ line: 1, reason: 'missing-field', field: 'args' }]);
    assert.deepStrictEqual(parseCaseRows(valid({ kwargs: {} }), options).rejected,
        [{ line: 1, reason: 'field-type', field: 'kwargs' }]);
    assert.deepStrictEqual(parseCaseRows('[1, 2]\n"text"\nnull', options).rejected,
        [{ line: 1, reason: 'not-an-object' }, { line: 2, reason: 'not-an-object' }, { line: 3, reason: 'not-an-object' }]);
    const [row] = parseCaseRows(line({ scenario: '空字串', category: 'normal', args: "('',)" }), options).rows;
    assert.deepStrictEqual(row.call, { args: "('',)", kwargs: '{}' });
    assert.deepStrictEqual(row.mocks, []);
    assert.strictEqual(row.requirementId, undefined);
});

test('blank lines and markdown fences are skipped without being counted as rejected', () => {
    const result = parseCaseRows(['```json', '', valid(), '   ', '```'].join('\r\n'), options);
    assert.strictEqual(result.rows.length, 1);
    assert.deepStrictEqual(result.rejected, []);
});

test('mocks parse return literals and raised exception names; malformed segments reject the row', () => {
    assert.deepStrictEqual(parseCaseMocks('db.fetchone -> None; cache.get -> {"a": 1} ;api.call -> raise requests.Timeout'), [
        { dependency: 'db.fetchone', behavior: 'return', value: 'None' },
        { dependency: 'cache.get', behavior: 'return', value: '{"a": 1}' },
        { dependency: 'api.call', behavior: 'raise', value: 'requests.Timeout' }
    ]);
    assert.deepStrictEqual(parseCaseMocks(''), []);
    for (const mocks of ['db.fetchone None', '-> None', 'db.fetchone -> ', 'db.fetchone -> raise ValueError("x")', '1db -> 2']) {
        assert.deepStrictEqual(parseCaseRows(valid({ mocks }), options).rejected,
            [{ line: 1, reason: 'invalid-mocks', field: 'mocks' }], mocks);
    }
});

test('ids continue from a given index so later roles never reuse an id', () => {
    const first = parseCaseRows([valid(), valid()].join('\n'), options).rows;
    const later = parseCaseRows(valid(), { ...options, origin: 'reviewer', firstIndex: nextCaseRowIndex(first) }).rows;
    assert.deepStrictEqual(later.map(row => [row.id, row.origin]), [['C3', 'reviewer']]);
    assert.strictEqual(nextCaseRowIndex([]), 1);
    assert.strictEqual(nextCaseRowIndex([{ id: 'C7' }, { id: 'C2' }, { id: 'X9' }]), 8);
    assert.throws(() => caseRowId(0));
});

function proposedRows(): CaseRow[] {
    return parseCaseRows([
        valid(),
        valid({ scenario: '需要連線', args: '<needs-setup: sqlite 連線>', mocks: 'db.fetchone -> raise sqlite3.Error' }),
        valid({ scenario: '參數過多', args: '(1, 2, 3)' })
    ].join('\n'), options).rows;
}

test('the validator request carries only proposed rows and the AST dependency list', () => {
    const rows = proposedRows();
    rows[0] = { ...rows[0], status: 'invalid', reason: 'earlier' };
    const request = buildCaseRowValidationRequest(rows, { source: 'def bmi(w, h): ...', target: 'bmi', dependencies: ['db.fetchone'] });
    assert.deepStrictEqual(request, {
        version: CASE_ROW_VALIDATION_REQUEST_VERSION, source: 'def bmi(w, h): ...', target: 'bmi', dependencies: ['db.fetchone'],
        rows: [
            { id: 'C2', needsSetup: 'sqlite 連線', mocks: [{ dependency: 'db.fetchone', behavior: 'raise', value: 'sqlite3.Error' }] },
            { id: 'C3', args: '(1, 2, 3)', kwargs: '{}', mocks: [] }
        ]
    });
});

test('validator verdicts mark only the rejected rows invalid', () => {
    const rows = proposedRows();
    const { rows: updated } = applyCaseRowValidation(rows, { version: CASE_ROW_VALIDATION_VERSION, decorated: false, results: [
        { id: 'C1', valid: true }, { id: 'C2', valid: true },
        { id: 'C3', valid: false, reason: 'signature-mismatch', detail: 'too many positional arguments' }
    ] });
    assert.deepStrictEqual(updated.map(row => [row.id, row.status, row.reason]),
        [['C1', 'proposed', undefined], ['C2', 'proposed', undefined], ['C3', 'invalid', 'signature-mismatch']]);
    assert.strictEqual(rows[2].status, 'proposed', 'input rows are not mutated');
});

test('a malformed or incomplete validator report is a tool failure, never a row verdict', () => {
    const rows = proposedRows();
    const ok = { id: 'C1', valid: true };
    const v = CASE_ROW_VALIDATION_VERSION;
    for (const report of [
        null, {}, { version: 'other', decorated: false, results: [] },
        { version: v, error: 'target-not-found' },
        { version: v, decorated: false, results: 'no' },
        { version: v, results: [ok, { id: 'C2', valid: true }, { id: 'C3', valid: true }] },
        { version: v, decorated: false, results: [{ id: 'C1', valid: false }] },
        { version: v, decorated: false, results: [ok, ok] },
        { version: v, decorated: false, results: [ok, { id: 'C2', valid: true }] },
        { version: v, decorated: false, results: [{ id: 'C1', valid: true, normalizedArgs: '(1,)' }, { id: 'C2', valid: true }, { id: 'C3', valid: true }] },
        { version: v, decorated: false, results: [ok, { id: 'C2', valid: true, normalizedArgs: '(1,)', normalizations: ['args-wrapped-single'] },
            { id: 'C3', valid: true }] }
    ]) {
        assert.throws(() => applyCaseRowValidation(rows, report), /case-row-validation-/, JSON.stringify(report));
    }
});

test('mocks split only on semicolons outside string literals and brackets', () => {
    assert.deepStrictEqual(parseCaseMocks(`log.write -> "a;b -> c"; cfg.load -> {'sep': ';', 'arrow': 'x->y'}; q.get -> ("x;", [1; 2])`), [
        { dependency: 'log.write', behavior: 'return', value: '"a;b -> c"' },
        { dependency: 'cfg.load', behavior: 'return', value: "{'sep': ';', 'arrow': 'x->y'}" },
        { dependency: 'q.get', behavior: 'return', value: '("x;", [1; 2])' }
    ]);
    assert.deepStrictEqual(parseCaseMocks(String.raw`p.read -> 'it\'s; fine'; p.close -> None`), [
        { dependency: 'p.read', behavior: 'return', value: String.raw`'it\'s; fine'` },
        { dependency: 'p.close', behavior: 'return', value: 'None' }
    ]);
    const [row] = parseCaseRows(valid({ mocks: 'db.fetchone -> ("A;B", "x -> y")' }), options).rows;
    assert.deepStrictEqual(row.mocks, [{ dependency: 'db.fetchone', behavior: 'return', value: '("A;B", "x -> y")' }]);
    for (const mocks of ['db.fetchone -> "open', 'db.fetchone -> (1, 2', 'db.fetchone -> 1)', 'db.fetchone -> [1)']) {
        assert.deepStrictEqual(parseCaseRows(valid({ mocks }), options).rejected,
            [{ line: 1, reason: 'invalid-mocks', field: 'mocks' }], mocks);
    }
});

test('wrapped single arguments replace the literal call and keep the normalization code', () => {
    const rows = parseCaseRows([valid({ args: '(70)' }), valid({ args: '<needs-setup: 物件>' }), valid({ args: '(1, 2)' })].join('\n'), options).rows;
    const outcome = applyCaseRowValidation(rows, { version: CASE_ROW_VALIDATION_VERSION, decorated: true, results: [
        { id: 'C1', valid: true, normalizedArgs: '(70,)', normalizations: ['args-wrapped-single'] },
        { id: 'C2', valid: true }, { id: 'C3', valid: true }
    ] });
    assert.strictEqual(outcome.decorated, true);
    assert.deepStrictEqual(outcome.rows[0].call, { args: '(70,)', kwargs: '{}' });
    assert.deepStrictEqual(outcome.rows[0].normalizations, ['args-wrapped-single']);
    assert.strictEqual(outcome.rows[2].normalizations, undefined, 'tuples are not normalized');
    assert.deepStrictEqual(rows[0].call, { args: '(70)', kwargs: '{}' }, 'input rows are not mutated');
});

const allowedTransitions: [CaseRowStatus, CaseRowStatus][] = [
    ['proposed', 'invalid'], ['proposed', 'captured'], ['proposed', 'capture-failed'],
    ['captured', 'test-generated'], ['test-generated', 'test-passed'], ['test-generated', 'test-failed']
];

test('each allowed status transition succeeds; failures need a reason and success drops it', () => {
    const base = proposedRows()[0];
    for (const [from, to] of allowedTransitions) {
        const failure = to === 'invalid' || to === 'capture-failed' || to === 'test-failed';
        const next = transitionCaseRow({ ...base, status: from, reason: 'old' }, to, failure ? 'why' : undefined);
        assert.strictEqual(next.status, to, `${from} -> ${to}`);
        assert.strictEqual(next.reason, failure ? 'why' : undefined, `${from} -> ${to}`);
        assert.ok(!(!failure && 'reason' in next), 'a success status does not keep a stale reason');
    }
    assert.throws(() => transitionCaseRow(base, 'invalid'), /case-row-transition-reason-required/);
    assert.throws(() => transitionCaseRow(base, 'capture-failed', '  '), /case-row-transition-reason-required/);
    const allowedCount = CASE_ROW_STATUSES.reduce((total, status) => total + CASE_ROW_TRANSITIONS[status].length, 0);
    assert.strictEqual(allowedCount, allowedTransitions.length, 'no transition beyond section 3.2 is allowed');
});

test('illegal status transitions throw', () => {
    const base = proposedRows()[0];
    for (const [from, to] of [['proposed', 'test-passed'], ['captured', 'invalid'], ['test-passed', 'test-failed'],
        ['invalid', 'proposed'], ['test-failed', 'test-generated'], ['proposed', 'proposed']] as [CaseRowStatus, CaseRowStatus][]) {
        assert.throws(() => transitionCaseRow({ ...base, status: from }, to, 'why'), /case-row-transition-invalid/, `${from} -> ${to}`);
    }
});

function tableFixture(): CaseTableFile {
    const [first, second, third] = proposedRows();
    return { version: 'case-table-v1', target: 'Garage.find', rows: [
        { ...first, status: 'test-passed', normalizations: ['args-wrapped-single'], testMethod: 'test_c1',
            predictions: [{ kind: 'return', value: '(18.5, "健康")', basis: 'docstring: 18.5 <= BMI', basisVerified: true }],
            actual: { kind: 'return', value: '(18.5, "健康")' },
            expected: { kind: 'return', value: '(18.5, "健康")', source: 'spec', confirmedBySpec: true }, oracleStatus: 'spec-matched' },
        second,
        { ...third, status: 'invalid', reason: 'signature-mismatch' }
    ] };
}

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'case-table-'));
}

test('case_table.json round-trips through an atomic write without leaving a pending file', () => {
    const directory = tempDir();
    try {
        const table = tableFixture();
        writeCaseTable(directory, table);
        assert.deepStrictEqual(fs.readdirSync(directory), [CASE_TABLE_FILE]);
        assert.deepStrictEqual(readCaseTable(directory), table);
        writeCaseTable(directory, { ...table, rows: table.rows.slice(0, 1) });
        assert.strictEqual(readCaseTable(directory).rows.length, 1, 'a second write replaces the file');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('damaged or wrong-version case tables throw a clear error instead of an empty table', () => {
    const directory = tempDir();
    const write = (content: string) => fs.writeFileSync(path.join(directory, CASE_TABLE_FILE), content, 'utf8');
    const table = tableFixture();
    try {
        assert.throws(() => readCaseTable(directory), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
        const cases: [string, string][] = [
            ['{"version": "case-table-v1", "target": "x", "rows": [', '$'],
            ['[]', '$'],
            [JSON.stringify({ ...table, version: 'case-table-v0' }), 'version'],
            [JSON.stringify({ version: 'case-table-v1', target: 'x' }), 'rows'],
            [JSON.stringify({ ...table, target: '' }), 'target'],
            [JSON.stringify({ ...table, rows: [{ ...table.rows[0], status: 'done' }] }), 'rows[0].status'],
            [JSON.stringify({ ...table, rows: [{ ...table.rows[0], category: 'edge' }] }), 'rows[0].category'],
            [JSON.stringify({ ...table, rows: [table.rows[1], table.rows[1]] }), 'rows[1].id'],
            [JSON.stringify({ ...table, rows: [{ ...table.rows[1], call: { args: '(1,)' } }] }), 'rows[0].call.kwargs'],
            [JSON.stringify({ ...table, rows: [{ ...table.rows[1], surprise: 1 }] }), 'rows[0].surprise'],
            [JSON.stringify({ ...table, rows: [{ ...table.rows[1], mocks: [{ dependency: 'db.x', behavior: 'patch', value: '1' }] }] }),
                'rows[0].mocks[0].behavior']
        ];
        for (const [content, field] of cases) {
            write(content);
            assert.throws(() => readCaseTable(directory), (error: unknown) =>
                error instanceof CaseTableFormatError && error.code === 'case-table-invalid' && error.field === field, field);
        }
        assert.throws(() => writeCaseTable(directory, { ...table, version: 'v0' } as unknown as CaseTableFile), CaseTableFormatError,
            'an invalid table is never written');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
