/**
 * Line-by-line parser for Analyst-scenario output (case-table-v1, section 3.1).
 *
 * Each non-blank line must be one flat JSON object. A line that cannot become a
 * row is recorded with a reason code and dropped; it never affects other lines.
 * Python-level checks (literal_eval, signature binding, dependency existence)
 * belong to python_scripts/case_row_validator.py, not to this parser.
 */
import { CaseCall, CaseMock, CaseOrigin, CaseRow, SCENARIO_MAX_LENGTH, caseRowId, isCaseCategory } from './caseTable';

export type CaseLineRejectReason =
    | 'invalid-json'
    | 'not-an-object'
    | 'missing-field'
    | 'field-type'
    | 'scenario-empty'
    | 'scenario-too-long'
    | 'unknown-category'
    | 'invalid-needs-setup'
    | 'invalid-mocks'
    | 'unknown-requirement';

export interface RejectedCaseLine {
    /** 1-based line number in the model response. */
    line: number;
    reason: CaseLineRejectReason;
    field?: string;
}

export interface ParseCaseRowsOptions {
    origin: CaseOrigin;
    /** Requirement ids from the requirements file (e.g. R1, R2); empty when there is none. */
    requirementIds: readonly string[];
    /** Numeric index of the first assigned id; defaults to 1 (C1). */
    firstIndex?: number;
}

export interface CaseRowParseResult {
    rows: CaseRow[];
    rejected: RejectedCaseLine[];
}

const DOTTED_NAME = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*';
const MOCK_SEGMENT = new RegExp(`^(${DOTTED_NAME})\\s*->\\s*(\\S[\\s\\S]*)$`);
const RAISE_VALUE = new RegExp(`^raise\\s+(${DOTTED_NAME})$`);
const RAISE_PREFIX = /^raise(?:\s|$)/;
const NEEDS_SETUP = /^<needs-setup:([\s\S]*)>$/;

class LineRejection extends Error {
    constructor(readonly reason: CaseLineRejectReason, readonly field?: string) { super(reason); }
}

export function parseCaseRows(text: string, options: ParseCaseRowsOptions): CaseRowParseResult {
    const requirementIds = new Set(options.requirementIds.map(id => id.trim()));
    let nextIndex = options.firstIndex ?? 1;
    const rows: CaseRow[] = [];
    const rejected: RejectedCaseLine[] = [];
    text.split(/\r?\n/).forEach((raw, offset) => {
        const line = raw.trim();
        if (!line || line.startsWith('```')) { return; }
        try {
            const fields = parseLineObject(line);
            rows.push({ id: caseRowId(nextIndex), origin: options.origin, ...rowFields(fields, requirementIds), status: 'proposed' });
            nextIndex += 1;
        } catch (failure) {
            if (!(failure instanceof LineRejection)) { throw failure; }
            rejected.push(failure.field === undefined
                ? { line: offset + 1, reason: failure.reason }
                : { line: offset + 1, reason: failure.reason, field: failure.field });
        }
    });
    return { rows, rejected };
}

/** Parse the `mocks` field: `dep -> literal` or `dep -> raise ExceptionName`, separated by `;`. */
export function parseCaseMocks(text: string): CaseMock[] {
    const mocks: CaseMock[] = [];
    for (const segment of text.split(';')) {
        const part = segment.trim();
        if (!part) { continue; }
        const match = MOCK_SEGMENT.exec(part);
        if (!match) { throw new LineRejection('invalid-mocks', 'mocks'); }
        const [, dependency, rawValue] = match;
        const value = rawValue.trim();
        const raised = RAISE_VALUE.exec(value);
        if (raised) {
            mocks.push({ dependency, behavior: 'raise', value: raised[1] });
        } else if (RAISE_PREFIX.test(value)) {
            throw new LineRejection('invalid-mocks', 'mocks');
        } else {
            mocks.push({ dependency, behavior: 'return', value });
        }
    }
    return mocks;
}

function parseLineObject(line: string): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new LineRejection('invalid-json'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new LineRejection('not-an-object'); }
    return value as Record<string, unknown>;
}

function requiredString(fields: Record<string, unknown>, name: string): string {
    const value = fields[name];
    if (value === undefined || value === null) { throw new LineRejection('missing-field', name); }
    if (typeof value !== 'string') { throw new LineRejection('field-type', name); }
    return value;
}

/** Optional fields may be absent, null or empty; any other non-string type is rejected. */
function optionalString(fields: Record<string, unknown>, name: string): string {
    const value = fields[name];
    if (value === undefined || value === null) { return ''; }
    if (typeof value !== 'string') { throw new LineRejection('field-type', name); }
    return value;
}

function rowFields(fields: Record<string, unknown>, requirementIds: ReadonlySet<string>):
    Pick<CaseRow, 'scenario' | 'category' | 'call' | 'mocks' | 'requirementId'> {
    const scenario = requiredString(fields, 'scenario').trim();
    if (!scenario) { throw new LineRejection('scenario-empty', 'scenario'); }
    if (Array.from(scenario).length > SCENARIO_MAX_LENGTH) { throw new LineRejection('scenario-too-long', 'scenario'); }
    const category = requiredString(fields, 'category').trim();
    if (!isCaseCategory(category)) { throw new LineRejection('unknown-category', 'category'); }
    const call = parseCall(requiredString(fields, 'args'), optionalString(fields, 'kwargs'));
    const mocks = parseCaseMocks(optionalString(fields, 'mocks'));
    const requirement = optionalString(fields, 'requirement').trim();
    if (requirement && !requirementIds.has(requirement)) { throw new LineRejection('unknown-requirement', 'requirement'); }
    return requirement ? { scenario, category, call, mocks, requirementId: requirement } : { scenario, category, call, mocks };
}

function parseCall(args: string, kwargs: string): CaseCall {
    const trimmedArgs = args.trim();
    const setup = NEEDS_SETUP.exec(trimmedArgs);
    if (setup) {
        const description = setup[1].trim();
        if (!description) { throw new LineRejection('invalid-needs-setup', 'args'); }
        return { needsSetup: description };
    }
    if (trimmedArgs.startsWith('<needs-setup')) { throw new LineRejection('invalid-needs-setup', 'args'); }
    if (!trimmedArgs) { throw new LineRejection('missing-field', 'args'); }
    return { args: trimmedArgs, kwargs: kwargs.trim() || '{}' };
}
