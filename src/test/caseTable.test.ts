import * as assert from 'assert';
import { test } from 'node:test';
import { CaseRow, caseRowId, isCaseCategory, needsSetup, nextCaseRowIndex } from '../pipeline/caseTable/caseTable';
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
    const updated = applyCaseRowValidation(rows, { version: CASE_ROW_VALIDATION_VERSION, results: [
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
    for (const report of [
        null, {}, { version: 'other', results: [] },
        { version: CASE_ROW_VALIDATION_VERSION, error: 'target-not-found' },
        { version: CASE_ROW_VALIDATION_VERSION, results: 'no' },
        { version: CASE_ROW_VALIDATION_VERSION, results: [{ id: 'C1', valid: false }] },
        { version: CASE_ROW_VALIDATION_VERSION, results: [ok, ok] },
        { version: CASE_ROW_VALIDATION_VERSION, results: [ok, { id: 'C2', valid: true }] }
    ]) {
        assert.throws(() => applyCaseRowValidation(rows, report), /case-row-validation-/, JSON.stringify(report));
    }
});
