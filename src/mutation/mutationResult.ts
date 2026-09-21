import { createHash } from 'crypto';
import * as path from 'path';
import { ExternalMutationEngine } from './mutationExecution';

export type MutationEngine = ExternalMutationEngine | 'builtin';
export type MutationOutcome = 'KILLED' | 'SURVIVED' | 'TIMEOUT' | 'ERROR' | 'NOT_RUN';
export const BUILTIN_MUTATION_OPERATOR_SET_VERSION = 'builtin-ast-v1';
export const FUNCTION_BODY_MUTATION_SCOPE_VERSION = 'selected-function-body-v1';
export const MODULE_MUTATION_SCOPE_VERSION = 'module-ast-v1';
export interface MutationScope {
    kind: 'function' | 'module';
    qualifiedName: string;
    startLine?: number;
    endLine?: number;
}
export interface MutationContext {
    sourcePath: string;
    sourceHash: string;
    testHash: string;
    targetScope: MutationScope;
    stageTimeoutSeconds?: number;
}
export interface MutationCounts {
    /** Null means the tool has not enumerated the full candidate universe. */
    available: number | null;
    selected: number;
    executed: number;
    notRun: number;
    killed: number;
    survived: number;
    timeout: number;
    error: number;
}
export interface MutationRecord {
    id: string;
    kind: string;
    line: number;
    column: number;
    position: number;
    from: string;
    to: string;
    status: MutationOutcome;
    output?: string;
}
export interface MutationRun extends MutationContext {
    schemaVersion: 1;
    engine: MutationEngine;
    operatorSetVersion: string | null;
    scopeVersion: string;
    /** Full valid candidate universe, independent of this run's test file. */
    candidateSetId: string | null;
    candidateIds: string[];
    status: 'complete' | 'partial' | 'failed' | 'no-candidates';
    baselinePassed: boolean;
    baselineStatus: 'passed' | 'failed' | 'timeout' | 'error' | 'not-run';
    counts: MutationCounts;
    mutants: MutationRecord[];
    /** A sample may have a score without constituting complete measurement. */
    scoreAvailable: boolean;
    diagnostic?: string;
    excluded?: { noop: number; duplicate: number; invalid: number };
}

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const outcomes: MutationOutcome[] = ['KILLED', 'SURVIVED', 'TIMEOUT', 'ERROR', 'NOT_RUN'];
const normalizePath = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const sourceBasename = (value: string) => path.posix.basename(value.replace(/\\/g, '/'));

export function failedMutationRun(engine: MutationEngine, context: MutationContext, diagnostic: string): MutationRun {
    return { ...context, targetScope: { ...context.targetScope }, schemaVersion: 1, engine, status: 'failed',
        operatorSetVersion: engine === 'builtin' ? BUILTIN_MUTATION_OPERATOR_SET_VERSION : null,
        scopeVersion: engine === 'builtin' ? context.targetScope.kind === 'function' ? FUNCTION_BODY_MUTATION_SCOPE_VERSION : MODULE_MUTATION_SCOPE_VERSION
            : 'external-module-report-v1', candidateSetId: null, candidateIds: [],
        baselinePassed: false, baselineStatus: 'not-run', scoreAvailable: false, diagnostic,
        counts: { available: null, selected: 0, executed: 0, notRun: 0, killed: 0, survived: 0, timeout: 0, error: 0 }, mutants: [] };
}

function countStatus(counts: MutationCounts, baselinePassed: boolean): Pick<MutationRun, 'status' | 'scoreAvailable'> {
    const scoreAvailable = baselinePassed && counts.selected > 0 && counts.notRun === 0 && counts.error === 0 && counts.timeout === 0;
    const status = !baselinePassed || counts.error > 0 ? 'failed'
        : counts.available === 0 ? 'no-candidates'
            : scoreAvailable && counts.available === counts.selected ? 'complete' : 'partial';
    return { status, scoreAvailable };
}

/** Parse a fresh result; malformed or stale evidence never inherits an old score. */
export function parseBuiltinMutationRun(raw: unknown, context: MutationContext): MutationRun {
    const fail = (message: string) => failedMutationRun('builtin', context, message);
    let value: unknown = raw;
    if (typeof raw === 'string') {
        try { value = JSON.parse(raw); } catch { return fail('Invalid builtin mutation JSON'); }
    }
    if (!record(value) || value.schemaVersion !== 1 || value.engine !== 'builtin') { return fail('Unsupported builtin mutation contract'); }
    const scopeVersion = context.targetScope.kind === 'function' ? FUNCTION_BODY_MUTATION_SCOPE_VERSION : MODULE_MUTATION_SCOPE_VERSION;
    if (value.operatorSetVersion !== BUILTIN_MUTATION_OPERATOR_SET_VERSION
        || value.scopeVersion !== scopeVersion) {
        return fail('Unsupported mutation operator set or scope version');
    }
    if (!digest(value.sourceHash) || !digest(value.testHash) || value.sourceHash !== context.sourceHash || value.testHash !== context.testHash
        || typeof value.sourcePath !== 'string' || normalizePath(value.sourcePath) !== normalizePath(context.sourcePath)) {
        return fail('Mutation source/test identity does not match this candidate');
    }
    if (!record(value.targetScope) || value.targetScope.kind !== context.targetScope.kind
        || value.targetScope.qualifiedName !== context.targetScope.qualifiedName) { return fail('Mutation scope does not match selected target'); }
    for (const field of ['startLine', 'endLine'] as const) {
        const observed = value.targetScope[field];
        if ((observed !== undefined && (!integer(observed) || observed < 1))
            || (context.targetScope[field] !== undefined && observed !== context.targetScope[field])) { return fail('Invalid mutation source range'); }
    }
    if (typeof value.scope_found !== 'boolean' || typeof value.baseline_passed !== 'boolean'
        || !['passed', 'failed', 'timeout', 'error', 'not-run'].includes(String(value.baselineStatus))
        || value.baseline_passed !== (value.baselineStatus === 'passed') || (!value.scope_found && value.baseline_passed)) {
        return fail('Invalid mutation baseline evidence');
    }
    const fields = ['available', 'selected', 'executed', 'notRun', 'killed', 'survived', 'timeout', 'error'] as const;
    if (!record(value.counts) || fields.some(field => field === 'available' && (value.counts as Record<string, unknown>)[field] === null
        ? false : !integer((value.counts as Record<string, unknown>)[field]))) { return fail('Invalid mutation counts'); }
    const counts = Object.fromEntries(fields.map(field => [field, (value.counts as Record<string, unknown>)[field]])) as unknown as MutationCounts;
    if ((counts.available !== null && counts.selected > counts.available) || counts.executed + counts.notRun !== counts.selected
        || counts.killed + counts.survived + counts.timeout + counts.error !== counts.executed
        || (!value.baseline_passed && counts.executed > 0)) { return fail('Inconsistent mutation counts'); }
    if (!Array.isArray(value.candidateIds) || !value.candidateIds.every(digest)
        || new Set(value.candidateIds).size !== value.candidateIds.length) { return fail('Invalid mutation candidate universe'); }
    const candidateIds = value.candidateIds as string[];
    if (counts.available === null || !value.scope_found) {
        if (value.candidateSetId !== null || candidateIds.length || counts.selected || value.baseline_passed) {
            return fail('Incomplete candidate enumeration cannot certify a candidate set');
        }
    } else if (candidateIds.length !== counts.available || !digest(value.candidateSetId)
        || value.candidateSetId !== mutationCandidateSetId(candidateIds)) { return fail('Mutation candidate set identity does not match its universe'); }
    if (!Array.isArray(value.mutants) || (value.baseline_passed ? value.mutants.length !== counts.selected : value.mutants.length !== 0)) {
        return fail('Incomplete mutation records');
    }
    const seen = new Set<string>();
    const observedCounts = { KILLED: 0, SURVIVED: 0, TIMEOUT: 0, ERROR: 0, NOT_RUN: 0 };
    const mutants: MutationRecord[] = [];
    for (const item of value.mutants) {
        if (!record(item) || !digest(item.id) || seen.has(item.id) || typeof item.kind !== 'string' || !item.kind
            || !integer(item.line) || item.line < 1 || !integer(item.column) || !integer(item.position)
            || typeof item.from !== 'string' || typeof item.to !== 'string' || !outcomes.includes(item.status as MutationOutcome)
            || (item.output !== undefined && typeof item.output !== 'string')) { return fail('Invalid or duplicate mutation record'); }
        seen.add(item.id);
        if (item.id !== candidateIds[mutants.length]) { return fail('Selected mutant does not match the enumerated candidate universe'); }
        observedCounts[item.status as MutationOutcome]++;
        mutants.push(item as unknown as MutationRecord);
    }
    if (value.baseline_passed && (observedCounts.KILLED !== counts.killed || observedCounts.SURVIVED !== counts.survived
        || observedCounts.TIMEOUT !== counts.timeout || observedCounts.ERROR !== counts.error || observedCounts.NOT_RUN !== counts.notRun)) {
        return fail('Mutation records disagree with counts');
    }
    const state = countStatus(counts, value.baseline_passed);
    if (value.status !== state.status || value.scoreAvailable !== state.scoreAvailable) { return fail('Mutation completion claim disagrees with evidence'); }
    if (context.stageTimeoutSeconds !== undefined && value.stageTimeoutSeconds !== context.stageTimeoutSeconds) { return fail('Mutation stage budget mismatch'); }
    if (!record(value.excluded) || ['noop', 'duplicate', 'invalid'].some(field => !integer((value.excluded as Record<string, unknown>)[field]))) {
        return fail('Invalid excluded mutation counts');
    }
    return { ...context, targetScope: { ...value.targetScope } as unknown as MutationScope,
        schemaVersion: 1, engine: 'builtin', ...state, baselinePassed: value.baseline_passed,
        operatorSetVersion: BUILTIN_MUTATION_OPERATOR_SET_VERSION, scopeVersion,
        candidateSetId: value.candidateSetId as string | null, candidateIds: [...candidateIds],
        baselineStatus: value.baselineStatus as MutationRun['baselineStatus'], counts, mutants,
        excluded: { ...value.excluded } as MutationRun['excluded'],
        diagnostic: typeof value.baseline_output === 'string' ? value.baseline_output : typeof value.diagnostic === 'string' ? value.diagnostic : undefined };
}

export interface ExternalMutationContext extends MutationContext {
    baselinePassed: boolean;
    isolationVerified: boolean;
}

/** Only the complete Mutatest RST contract present in the repository is supported.
 * Mutmut console summaries have no verified versioned fixture, so fail closed.
 * Location coverage is not an enumeration of all operator variants: available
 * remains unknown even when the sampled locations report 100% coverage.
 * Status/detail format is also checked against the upstream report writer:
 * https://github.com/EvanKepner/mutatest/blob/master/mutatest/report.py
 * UNKNOWN remains unsupported and cannot acquire a score.
 */
export function parseExternalMutationRun(engine: ExternalMutationEngine, text: string, exitCode: number | null,
    context: ExternalMutationContext): MutationRun {
    const fail = (message: string) => failedMutationRun(engine, context, message);
    if (exitCode !== 0) { return fail(`Mutation engine did not exit successfully (${exitCode ?? 'unknown'})`); }
    if (!context.baselinePassed || !context.isolationVerified) { return fail('External mutation baseline/isolation evidence is incomplete'); }
    if (context.targetScope.kind !== 'module') { return fail('External adapter cannot certify a selected function scope'); }
    if (engine !== 'mutatest') { return fail('No verified result contract for this mutmut version'); }
    const clean = text.replace(/\r\n/g, '\n').replace(/\x1b\[[0-9;]*m/g, '');
    const summary = clean.match(/^Overall mutation trial summary\n=+\n([\s\S]*?)\nMutations by result status\n=+\n([\s\S]*)$/m);
    if (!/^Mutatest diagnostic summary\n=+\n/m.test(clean) || !summary) { return fail('Expected complete Mutatest RST report'); }
    const source = clean.match(/^ - Source location: (.+)$/m)?.[1];
    if (!source || normalizePath(source) !== normalizePath(context.sourcePath)) { return fail('External report source does not match target'); }
    const declared = new Map<string, number>();
    for (const match of summary[1].matchAll(/^ - ([A-Z ]+): (.*)$/gm)) {
        const [, label, raw] = match;
        if (label === 'RUN DATETIME') { continue; }
        if (!['DETECTED', 'SURVIVED', 'TIMEOUT', 'ERROR', 'TOTAL RUNS'].includes(label)
            || !/^\d+$/.test(raw) || !integer(Number(raw)) || declared.has(label)) { return fail('Unknown or duplicate external result field'); }
        declared.set(label, Number(raw));
    }
    if (!declared.has('TOTAL RUNS')) { return fail('Missing external total'); }
    const mutants: MutationRecord[] = [];
    let section: string | undefined;
    const labels: Record<string, MutationOutcome> = { DETECTED: 'KILLED', SURVIVED: 'SURVIVED', TIMEOUT: 'TIMEOUT', ERROR: 'ERROR' };
    const lines = summary[2].split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line) { continue; }
        if (line in labels && /^-+$/.test(lines[index + 1]?.trim() || '')) { section = line; index++; continue; }
        const match = line.match(/^- (.+): \(l: (\d+), c: (\d+)\) - mutation from (.+) to (.+)$/);
        if (!section || !match) { return fail('Unknown or incomplete external mutant detail'); }
        const [, filename, lineNumber, column, from, to] = match;
        if (sourceBasename(filename) !== sourceBasename(context.sourcePath)
            || !integer(Number(lineNumber)) || Number(lineNumber) < 1 || !integer(Number(column))) { return fail('External mutant source mismatch'); }
        const id = createHash('sha256').update(JSON.stringify(['mutatest-rst-v1', context.sourceHash, 'module', filename, lineNumber, column, from, to])).digest('hex');
        mutants.push({ id, kind: 'external', line: Number(lineNumber), column: Number(column), position: 0, from, to, status: labels[section] });
    }
    const total = declared.get('TOTAL RUNS')!;
    if (mutants.length !== total || new Set(mutants.map(item => item.id)).size !== total) { return fail('External mutant details do not match total'); }
    for (const [label, status] of Object.entries(labels)) {
        // The checked-in report omits zero-count statuses. Actual detail records
        // prove zero; absence of a console summary field alone never does.
        if (mutants.filter(item => item.status === status).length !== (declared.get(label) || 0)) { return fail('External status counts do not match details'); }
    }
    const counts: MutationCounts = { available: null, selected: total, executed: total, notRun: 0,
        killed: declared.get('DETECTED') || 0, survived: declared.get('SURVIVED') || 0,
        timeout: declared.get('TIMEOUT') || 0, error: declared.get('ERROR') || 0 };
    return { ...context, targetScope: { ...context.targetScope }, schemaVersion: 1, engine, ...countStatus(counts, true),
        operatorSetVersion: null, scopeVersion: 'external-module-report-v1', candidateSetId: null, candidateIds: [],
        baselinePassed: true, baselineStatus: 'passed', counts, mutants,
        diagnostic: 'External report measures selected trials; the full operator candidate universe is unknown.' };
}

/** Same full candidate universe can be compared after changing only tests. */
export function mutationCandidateSetId(candidateIds: readonly string[]): string {
    return createHash('sha256').update([...candidateIds].sort().join('\n')).digest('hex');
}

/** Exact fraction; round only when formatting the UI. */
export function mutationScore(run: MutationRun): number | null {
    return run.scoreAvailable ? 100 * run.counts.killed / run.counts.selected : null;
}

export function mutationMeetsThreshold(run: MutationRun, threshold = 100): boolean {
    return Number.isFinite(threshold) && threshold >= 0 && threshold <= 100 && run.status === 'complete'
        && run.scoreAvailable && run.counts.killed * 100 >= threshold * run.counts.selected;
}
