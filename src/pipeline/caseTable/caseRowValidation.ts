/**
 * Host side of python_scripts/case_row_validator.py.
 *
 * Builds the JSON request for proposed rows and applies the per-row verdicts.
 * A malformed or incomplete report is a tool failure and throws; it never
 * silently marks model rows invalid or valid.
 */
import { CaseMock, CaseRow, needsSetup } from './caseTable';

export const CASE_ROW_VALIDATION_REQUEST_VERSION = 'case-row-validation-request-v1';
export const CASE_ROW_VALIDATION_VERSION = 'case-row-validation-v1';

export type CaseRowValidationRequestRow =
    | { id: string; args: string; kwargs: string; mocks: CaseMock[] }
    | { id: string; needsSetup: string; mocks: CaseMock[] };

export interface CaseRowValidationRequest {
    version: typeof CASE_ROW_VALIDATION_REQUEST_VERSION;
    /** Full source text of the target module; the validator parses it, never imports it. */
    source: string;
    /** `function` or `Class.method`. */
    target: string;
    /** Dependency names from AST facts; mocks may only name these. */
    dependencies: string[];
    rows: CaseRowValidationRequestRow[];
}

export interface CaseRowValidationResult {
    id: string;
    valid: boolean;
    reason?: string;
    detail?: string;
    /** Rewritten literal call, e.g. "(70,)" when the model wrote "(70)". */
    normalizedArgs?: string;
    normalizations?: string[];
}

export interface CaseRowValidationOutcome {
    rows: CaseRow[];
    /** The target has decorators other than staticmethod/classmethod; binding used the def itself. */
    decorated: boolean;
}

export interface CaseRowValidationContext {
    source: string;
    target: string;
    dependencies: readonly string[];
}

export function buildCaseRowValidationRequest(rows: readonly CaseRow[], context: CaseRowValidationContext): CaseRowValidationRequest {
    return {
        version: CASE_ROW_VALIDATION_REQUEST_VERSION,
        source: context.source,
        target: context.target,
        dependencies: [...context.dependencies],
        rows: rows.filter(row => row.status === 'proposed').map(row => needsSetup(row.call)
            ? { id: row.id, needsSetup: row.call.needsSetup, mocks: row.mocks.map(mock => ({ ...mock })) }
            : { id: row.id, args: row.call.args, kwargs: row.call.kwargs, mocks: row.mocks.map(mock => ({ ...mock })) })
    };
}

/**
 * Return new rows: proposed rows judged invalid become `invalid` with the validator's
 * reason code; valid rows take any normalized args and keep the normalization codes.
 */
export function applyCaseRowValidation(rows: readonly CaseRow[], report: unknown): CaseRowValidationOutcome {
    const { results, decorated } = readReport(report);
    return {
        decorated,
        rows: rows.map(row => {
            if (row.status !== 'proposed') { return row; }
            const result = results.get(row.id);
            if (!result) { throw new Error(`case-row-validation-incomplete: no verdict for ${row.id}`); }
            if (!result.valid) { return { ...row, status: 'invalid', reason: result.reason }; }
            if (result.normalizedArgs === undefined) { return row; }
            if (needsSetup(row.call)) { throw new Error(`case-row-validation-malformed: normalized args for setup row ${row.id}`); }
            return { ...row, call: { args: result.normalizedArgs, kwargs: row.call.kwargs },
                normalizations: [...(row.normalizations ?? []), ...(result.normalizations ?? [])] };
        })
    };
}

function readReport(report: unknown): { results: Map<string, CaseRowValidationResult>; decorated: boolean } {
    if (!isRecord(report) || report.version !== CASE_ROW_VALIDATION_VERSION) {
        throw new Error('case-row-validation-malformed: unexpected report version');
    }
    if (typeof report.error === 'string') { throw new Error(`case-row-validation-failed: ${report.error}`); }
    if (!Array.isArray(report.results)) { throw new Error('case-row-validation-malformed: results must be an array'); }
    if (typeof report.decorated !== 'boolean') { throw new Error('case-row-validation-malformed: decorated must be a boolean'); }
    const results = new Map<string, CaseRowValidationResult>();
    for (const entry of report.results) {
        if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.valid !== 'boolean'
            || (!entry.valid && typeof entry.reason !== 'string')) {
            throw new Error('case-row-validation-malformed: invalid result entry');
        }
        if (results.has(entry.id)) { throw new Error(`case-row-validation-malformed: duplicate verdict for ${entry.id}`); }
        results.set(entry.id, entry.valid ? validResult(entry) : { id: entry.id, valid: false, reason: entry.reason as string });
    }
    return { results, decorated: report.decorated };
}

function validResult(entry: Record<string, unknown>): CaseRowValidationResult {
    const id = entry.id as string;
    if (entry.normalizedArgs === undefined && entry.normalizations === undefined) { return { id, valid: true }; }
    const normalizations = entry.normalizations;
    if (typeof entry.normalizedArgs !== 'string' || !entry.normalizedArgs.trim() || !Array.isArray(normalizations)
        || normalizations.length === 0 || !normalizations.every(code => typeof code === 'string' && code.length > 0)) {
        throw new Error(`case-row-validation-malformed: invalid normalization for ${id}`);
    }
    return { id, valid: true, normalizedArgs: entry.normalizedArgs, normalizations: [...normalizations] as string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
