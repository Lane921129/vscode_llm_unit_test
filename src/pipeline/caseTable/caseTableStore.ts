/**
 * case_table.json persistence for one target's result folder.
 *
 * Writes go through a pending file plus renameAtomicSync, like the other
 * result artifacts. Reads validate the version and every row field and throw
 * CaseTableFormatError on a damaged file; they never return an empty table.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renameAtomicSync } from '../../utils/atomicRename';
import { isTestFocus } from '../testFocus';
import {
    CASE_ORIGINS, CASE_ROW_STATUSES, CASE_TABLE_VERSION, CaseRow, CaseTableFile, EXPECTED_SOURCES,
    ORACLE_STATUSES, OUTCOME_KINDS, SCENARIO_MAX_LENGTH, isCaseCategory
} from './caseTable';

export const CASE_TABLE_FILE = 'case_table.json';
const PENDING_FILE = 'case_table.pending.json';
const ROW_ID = /^C[1-9]\d*$/;
const ROW_KEYS = new Set(['id', 'origin', 'scenario', 'category', 'call', 'mocks', 'requirementId', 'predictions',
    'actual', 'expected', 'oracleStatus', 'status', 'reason', 'testMethod', 'normalizations']);

export class CaseTableFormatError extends Error {
    readonly code = 'case-table-invalid';
    /** JSON location of the first problem, e.g. `rows[2].status`. */
    constructor(readonly field: string, detail: string) {
        super(`case-table-invalid: ${field}: ${detail}`);
        this.name = 'CaseTableFormatError';
    }
}

export function writeCaseTable(directory: string, table: CaseTableFile): void {
    const checked = validateCaseTable(table);
    const pending = path.join(directory, PENDING_FILE);
    fs.writeFileSync(pending, JSON.stringify(checked, null, 2) + '\n', 'utf8');
    renameAtomicSync(pending, path.join(directory, CASE_TABLE_FILE));
}

/** Missing files keep the file system error; damaged content throws CaseTableFormatError. */
export function readCaseTable(directory: string): CaseTableFile {
    const text = fs.readFileSync(path.join(directory, CASE_TABLE_FILE), 'utf8');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new CaseTableFormatError('$', 'not valid JSON'); }
    return validateCaseTable(value);
}

export function validateCaseTable(value: unknown): CaseTableFile {
    const table = record(value, '$');
    for (const key of Object.keys(table)) {
        if (!['version', 'target', 'rows', 'testFocus'].includes(key)) { fail(key, 'unknown field'); }
    }
    if (table.version !== CASE_TABLE_VERSION) { fail('version', `expected ${CASE_TABLE_VERSION}`); }
    const target = text(table.target, 'target');
    if (!Array.isArray(table.rows)) { fail('rows', 'must be an array'); }
    const ids = new Set<string>();
    const rows = (table.rows as unknown[]).map((entry, index) => {
        const row = validateRow(entry, `rows[${index}]`);
        if (ids.has(row.id)) { fail(`rows[${index}].id`, `duplicate id ${row.id}`); }
        ids.add(row.id);
        return row;
    });
    const testFocus = table.testFocus !== undefined ? (isTestFocus(table.testFocus) ? table.testFocus : fail('testFocus', 'unknown test focus')) : undefined;
    return { version: CASE_TABLE_VERSION, target, rows, ...(testFocus ? { testFocus } : {}) };
}

function validateRow(value: unknown, at: string): CaseRow {
    const row = record(value, at);
    for (const key of Object.keys(row)) {
        if (!ROW_KEYS.has(key)) { fail(`${at}.${key}`, 'unknown field'); }
    }
    const id = text(row.id, `${at}.id`);
    if (!ROW_ID.test(id)) { fail(`${at}.id`, 'must look like C1'); }
    const scenario = text(row.scenario, `${at}.scenario`);
    if (Array.from(scenario).length > SCENARIO_MAX_LENGTH) { fail(`${at}.scenario`, 'too long'); }
    if (!isCaseCategory(row.category)) { fail(`${at}.category`, 'unknown category'); }
    const result: CaseRow = {
        id,
        origin: oneOf(row.origin, CASE_ORIGINS, `${at}.origin`),
        scenario,
        category: row.category,
        call: call(row.call, `${at}.call`),
        mocks: list(row.mocks, `${at}.mocks`).map((mock, index) => {
            const item = exactRecord(mock, `${at}.mocks[${index}]`, ['dependency', 'behavior', 'value']);
            return { dependency: text(item.dependency, `${at}.mocks[${index}].dependency`),
                behavior: oneOf(item.behavior, OUTCOME_KINDS, `${at}.mocks[${index}].behavior`),
                value: text(item.value, `${at}.mocks[${index}].value`) };
        }),
        status: oneOf(row.status, CASE_ROW_STATUSES, `${at}.status`)
    };
    if (row.requirementId !== undefined) { result.requirementId = text(row.requirementId, `${at}.requirementId`); }
    if (row.predictions !== undefined) {
        result.predictions = list(row.predictions, `${at}.predictions`).map((entry, index) => {
            const where = `${at}.predictions[${index}]`;
            const item = exactRecord(entry, where, ['kind', 'value', 'basis', 'basisVerified']);
            return { ...outcome(item, where), basis: string(item.basis, `${where}.basis`),
                basisVerified: boolean(item.basisVerified, `${where}.basisVerified`) };
        });
    }
    if (row.actual !== undefined) { result.actual = outcome(exactRecord(row.actual, `${at}.actual`, ['kind', 'value']), `${at}.actual`); }
    if (row.expected !== undefined) {
        const where = `${at}.expected`;
        const item = exactRecord(row.expected, where, ['kind', 'value', 'source', 'confirmedBySpec']);
        result.expected = { ...outcome(item, where), source: oneOf(item.source, EXPECTED_SOURCES, `${where}.source`),
            confirmedBySpec: boolean(item.confirmedBySpec, `${where}.confirmedBySpec`) };
    }
    if (row.oracleStatus !== undefined) { result.oracleStatus = oneOf(row.oracleStatus, ORACLE_STATUSES, `${at}.oracleStatus`); }
    if (row.reason !== undefined) { result.reason = text(row.reason, `${at}.reason`); }
    if (row.testMethod !== undefined) { result.testMethod = text(row.testMethod, `${at}.testMethod`); }
    if (row.normalizations !== undefined) {
        result.normalizations = list(row.normalizations, `${at}.normalizations`)
            .map((code, index) => text(code, `${at}.normalizations[${index}]`));
    }
    return result;
}

function call(value: unknown, at: string): CaseRow['call'] {
    const item = record(value, at);
    if ('needsSetup' in item) {
        exactRecord(item, at, ['needsSetup']);
        return { needsSetup: text(item.needsSetup, `${at}.needsSetup`) };
    }
    exactRecord(item, at, ['args', 'kwargs']);
    return { args: text(item.args, `${at}.args`), kwargs: text(item.kwargs, `${at}.kwargs`) };
}

function outcome(item: Record<string, unknown>, at: string): { kind: 'return' | 'raise'; value: string } {
    return { kind: oneOf(item.kind, OUTCOME_KINDS, `${at}.kind`), value: string(item.value, `${at}.value`) };
}

function record(value: unknown, at: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { fail(at, 'must be an object'); }
    return value as Record<string, unknown>;
}

function exactRecord(value: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
    const item = record(value, at);
    for (const key of Object.keys(item)) {
        if (!keys.includes(key)) { fail(`${at}.${key}`, 'unknown field'); }
    }
    return item;
}

function list(value: unknown, at: string): unknown[] {
    if (!Array.isArray(value)) { fail(at, 'must be an array'); }
    return value as unknown[];
}

function string(value: unknown, at: string): string {
    if (typeof value !== 'string') { fail(at, 'must be a string'); }
    return value as string;
}

/** Non-empty string. */
function text(value: unknown, at: string): string {
    const result = string(value, at);
    if (!result.trim()) { fail(at, 'must not be empty'); }
    return result;
}

function boolean(value: unknown, at: string): boolean {
    if (typeof value !== 'boolean') { fail(at, 'must be a boolean'); }
    return value as boolean;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) { fail(at, `must be one of ${allowed.join(', ')}`); }
    return value as T;
}

function fail(field: string, detail: string): never {
    throw new CaseTableFormatError(field, detail);
}
