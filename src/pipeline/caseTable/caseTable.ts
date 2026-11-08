/**
 * case-table-v1: the row-per-scenario record shared by v2 roles.
 *
 * Every model role in the v2 pipeline reads or proposes rows; the host parses,
 * validates, captures and grades each row independently, so one broken row
 * never fails its neighbours. See docs/三週改版架構_2026_11_04.md section 3.
 */

export const CASE_TABLE_VERSION = 'case-table-v1';

/** Scenario text doubles as test method name/comment source, so it stays short. */
export const SCENARIO_MAX_LENGTH = 80;

export const CASE_CATEGORIES = ['normal', 'boundary', 'error', 'dependency-failure', 'state'] as const;
export type CaseCategory = typeof CASE_CATEGORIES[number];

export type CaseOrigin = 'analyst' | 'reviewer' | 'quality-analyst';
export type ExpectedSource = 'spec' | 'observed';
export type OutcomeKind = 'return' | 'raise';
export type MockBehavior = 'return' | 'raise';

export type OracleStatus = 'spec-matched' | 'spec-mismatch' | 'needs-review'
    | 'prediction-unstable' | 'observed-unconfirmed';

export type CaseRowStatus = 'proposed' | 'invalid' | 'captured' | 'capture-failed'
    | 'test-generated' | 'test-passed' | 'test-failed';

/** One patched dependency: `value` is a Python literal (return) or an exception name (raise). */
export interface CaseMock {
    dependency: string;
    behavior: MockBehavior;
    value: string;
}

/** Literal call (Python tuple/dict source text) or a description the Writer turns into setup. */
export type CaseCall = { args: string; kwargs: string } | { needsSetup: string };

export interface CaseOutcome {
    kind: OutcomeKind;
    value: string;
}

export interface CasePrediction extends CaseOutcome {
    basis: string;
    basisVerified: boolean;
}

export interface CaseExpected extends CaseOutcome {
    source: ExpectedSource;
    confirmedBySpec: boolean;
}

export interface CaseRow {
    /** Host-assigned: C1, C2, ... */
    id: string;
    origin: CaseOrigin;
    scenario: string;
    category: CaseCategory;
    call: CaseCall;
    mocks: CaseMock[];
    requirementId?: string;
    predictions?: CasePrediction[];
    actual?: CaseOutcome;
    expected?: CaseExpected;
    oracleStatus?: OracleStatus;
    status: CaseRowStatus;
    /** Reason code when the row is invalid or failed. */
    reason?: string;
    testMethod?: string;
}

export function isCaseCategory(value: unknown): value is CaseCategory {
    return typeof value === 'string' && (CASE_CATEGORIES as readonly string[]).includes(value);
}

export function needsSetup(call: CaseCall): call is { needsSetup: string } {
    return 'needsSetup' in call;
}

export function caseRowId(index: number): string {
    if (!Number.isInteger(index) || index < 1) { throw new Error(`Case row index must be a positive integer: ${index}`); }
    return `C${index}`;
}

/** Next free numeric id so rows from later roles never reuse an existing id. */
export function nextCaseRowIndex(rows: readonly Pick<CaseRow, 'id'>[]): number {
    let highest = 0;
    for (const row of rows) {
        const match = /^C([1-9]\d*)$/.exec(row.id);
        if (match) { highest = Math.max(highest, Number(match[1])); }
    }
    return highest + 1;
}
