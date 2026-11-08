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

export const CASE_ORIGINS = ['analyst', 'reviewer', 'quality-analyst'] as const;
export type CaseOrigin = typeof CASE_ORIGINS[number];
export const EXPECTED_SOURCES = ['spec', 'observed'] as const;
export type ExpectedSource = typeof EXPECTED_SOURCES[number];
export const OUTCOME_KINDS = ['return', 'raise'] as const;
export type OutcomeKind = typeof OUTCOME_KINDS[number];
export type MockBehavior = OutcomeKind;

export const ORACLE_STATUSES = ['spec-matched', 'spec-mismatch', 'needs-review',
    'prediction-unstable', 'observed-unconfirmed'] as const;
export type OracleStatus = typeof ORACLE_STATUSES[number];

export const CASE_ROW_STATUSES = ['proposed', 'invalid', 'captured', 'capture-failed',
    'test-generated', 'test-passed', 'test-failed'] as const;
export type CaseRowStatus = typeof CASE_ROW_STATUSES[number];

/** Host-side rewrites applied to a row, e.g. `args-wrapped-single` when `(70)` became `(70,)`. */
export const ARGS_WRAPPED_SINGLE = 'args-wrapped-single';

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
    /** Host normalizations applied to the model's row (kept for reporting). */
    normalizations?: string[];
}

/** Persisted form of case_table.json in each target's result folder. */
export interface CaseTableFile {
    version: typeof CASE_TABLE_VERSION;
    target: string;
    rows: CaseRow[];
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

/** The only status changes section 3.2 allows; every other change is a host bug. */
export const CASE_ROW_TRANSITIONS: Readonly<Record<CaseRowStatus, readonly CaseRowStatus[]>> = {
    'proposed': ['invalid', 'captured', 'capture-failed'],
    'captured': ['test-generated'],
    'test-generated': ['test-passed', 'test-failed'],
    'invalid': [],
    'capture-failed': [],
    'test-passed': [],
    'test-failed': []
};

const FAILURE_STATUSES: ReadonlySet<CaseRowStatus> = new Set<CaseRowStatus>(['invalid', 'capture-failed', 'test-failed']);

/**
 * Return a copy of the row in the next status. Failure statuses require a reason
 * code; other statuses drop any earlier reason. Illegal changes throw.
 */
export function transitionCaseRow(row: CaseRow, next: CaseRowStatus, reason?: string): CaseRow {
    if (!CASE_ROW_TRANSITIONS[row.status].includes(next)) {
        throw new Error(`case-row-transition-invalid: ${row.id} ${row.status} -> ${next}`);
    }
    const { reason: _previous, ...rest } = row;
    if (FAILURE_STATUSES.has(next)) {
        if (!reason || !reason.trim()) { throw new Error(`case-row-transition-reason-required: ${row.id} -> ${next}`); }
        return { ...rest, status: next, reason: reason.trim() };
    }
    return { ...rest, status: next };
}
