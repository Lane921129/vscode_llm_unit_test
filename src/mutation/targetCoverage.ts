import * as path from 'path';
import * as fs from 'fs';

export interface TargetCoverageAssessment {
    available: boolean;
    coverageText: string;
    missingLines: string;
    targetExecuted?: boolean;
    /** Target-body lines that coverage confirms were not exercised. */
    missingTargetLines?: number[];
    /** Undefined means coverage could not safely determine the answer. */
    targetFullyCovered?: boolean;
    /** Missing branch arcs whose source line belongs to the selected target. */
    missingTargetBranches?: string[];
    /** Undefined when the report was not collected with coverage --branch. */
    targetBranchesCovered?: boolean;
    /** Native coverage statements inside the selected body, excluding docstrings/comments. */
    executableTargetLines?: number[];
    evidenceVersion?: 'coverage-evidence-v1';
    scopeStatus?: 'verified' | 'ambiguous' | 'unresolved';
    invocationEvidence?: { observed: boolean; testRunId: string; testHash: string };
    reason?: string;
}

function canonicalFile(file: string): string | undefined {
    if (!path.isAbsolute(file)) { return undefined; }
    let resolved: string;
    try { resolved = fs.realpathSync.native(file); }
    catch { resolved = path.resolve(file); }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function statementSet(value: unknown): Set<number> | undefined {
    if (!Array.isArray(value) || value.some(line => !Number.isSafeInteger(line) || line <= 0)) { return undefined; }
    const lines = new Set<number>(value);
    return lines.size === value.length ? lines : undefined;
}

function branchSet(value: unknown, statements: Set<number>): Map<string, [number, number]> | undefined {
    if (!Array.isArray(value)) { return undefined; }
    const arcs = new Map<string, [number, number]>();
    for (const arc of value) {
        if (!Array.isArray(arc) || arc.length !== 2 || !Number.isSafeInteger(arc[0]) || arc[0] <= 0
            || !Number.isSafeInteger(arc[1]) || arc[1] === 0 || !statements.has(arc[0])) { return undefined; }
        const key = `${arc[0]}->${arc[1]}`;
        if (arcs.has(key)) { return undefined; }
        arcs.set(key, [arc[0], arc[1]]);
    }
    return arcs;
}

/** Current runs consume this tool-owned contract; display-text parsing is historical compatibility only. */
export function assessTargetCoverageEvidence(
    raw: unknown, targetFile: string, qualifiedTarget: string, expectedSourceHash?: string,
    expectedRun?: { testRunId: string; testHash: string }
): TargetCoverageAssessment {
    const unavailable = (reason: string): TargetCoverageAssessment => ({
        available: false, coverageText: 'N/A', missingLines: '未知', reason
    });
    let value: Record<string, unknown>;
    try {
        const decoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) { return unavailable('invalid-coverage-envelope'); }
        value = decoded as Record<string, unknown>;
    } catch { return unavailable('invalid-coverage-json'); }
    if (value.schemaVersion !== 'coverage-evidence-v1' || value.available !== true) {
        if (value.schemaVersion === 'coverage-evidence-v1' && value.scopeStatus === 'ambiguous'
            && value.reason === 'target-scope-ambiguous') {
            return { ...unavailable('target-scope-ambiguous'), scopeStatus: 'ambiguous' };
        }
        return unavailable('coverage-unavailable');
    }
    if (value.scopeStatus !== 'verified') { return unavailable('coverage-scope-unverified'); }
    if (typeof value.invocationRequired !== 'boolean') { return unavailable('invalid-invocation-scope'); }
    const expectedFile = canonicalFile(targetFile);
    if (!expectedFile || typeof value.canonicalFile !== 'string' || canonicalFile(value.canonicalFile) !== expectedFile
        || !qualifiedTarget || value.target !== qualifiedTarget
        || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)
        || (expectedSourceHash !== undefined && value.sourceHash !== expectedSourceHash)) {
        return unavailable('coverage-identity-mismatch');
    }
    const invocation = value.invocation as { observed?: unknown; testRunId?: unknown; testHash?: unknown } | undefined;
    if (expectedRun || value.invocationRequired || invocation !== undefined) {
        if (!expectedRun || !invocation || typeof invocation.observed !== 'boolean'
            || invocation.testRunId !== expectedRun.testRunId || !expectedRun.testRunId
            || invocation.testHash !== expectedRun.testHash || !/^[a-f0-9]{64}$/.test(expectedRun.testHash)) {
            return unavailable('invalid-invocation-evidence');
        }
    }
    const statements = statementSet(value.statements);
    const executed = statementSet(value.executedStatements);
    const missing = statementSet(value.missingStatements);
    const target = statementSet(value.targetStatements);
    if (!statements || !executed || !missing || !target || typeof value.branchCoverageAvailable !== 'boolean'
        || [...executed].some(line => !statements.has(line) || missing.has(line))
        || [...missing].some(line => !statements.has(line)) || executed.size + missing.size !== statements.size
        || [...target].some(line => !statements.has(line))) { return unavailable('invalid-coverage-statements'); }
    const executedBranches = value.branchCoverageAvailable ? branchSet(value.executedBranches, statements) : undefined;
    const missingBranches = value.branchCoverageAvailable ? branchSet(value.missingBranches, statements) : undefined;
    const counts = value.branchCounts as { total?: unknown; executed?: unknown; missing?: unknown } | undefined;
    if (value.branchCoverageAvailable && (!executedBranches || !missingBranches
        || !counts || counts.total !== executedBranches.size + missingBranches.size
        || counts.executed !== executedBranches.size || counts.missing !== missingBranches.size
        || [...executedBranches.keys()].some(arc => missingBranches.has(arc)))) {
        return unavailable('invalid-coverage-branches');
    }
    const orderedTarget = [...target].sort((a, b) => a - b);
    const targetMissing = orderedTarget.length
        ? orderedTarget.filter(line => invocation?.observed === false || missing.has(line)) : undefined;
    const targetMissingBranches = orderedTarget.length && missingBranches
        ? [...missingBranches.values()].filter(([from]) => target.has(from)).map(([from, to]) => `${from}->${to}`) : undefined;
    const total = statements.size + (executedBranches?.size || 0) + (missingBranches?.size || 0);
    const covered = executed.size + (executedBranches?.size || 0);
    return {
        available: true, evidenceVersion: 'coverage-evidence-v1', scopeStatus: 'verified', executableTargetLines: orderedTarget,
        invocationEvidence: invocation ? { observed: invocation.observed as boolean,
            testRunId: invocation.testRunId as string, testHash: invocation.testHash as string } : undefined,
        coverageText: total ? `${Number((100 * covered / total).toFixed(2))}%` : 'N/A',
        missingLines: [...missing].sort((a, b) => a - b).join(', ') || '無',
        targetExecuted: invocation ? invocation.observed as boolean
            : orderedTarget.length ? orderedTarget.some(line => executed.has(line)) : undefined,
        missingTargetLines: targetMissing,
        targetFullyCovered: targetMissing === undefined ? undefined : targetMissing.length === 0,
        missingTargetBranches: targetMissingBranches,
        targetBranchesCovered: targetMissingBranches === undefined ? undefined : targetMissingBranches.length === 0
    };
}

function parseMissingDetails(text: string): { lines: Set<number>; branches: string[] } | undefined {
    if (!text.trim()) {
        return { lines: new Set(), branches: [] };
    }
    const lines = new Set<number>();
    const branches: string[] = [];
    for (const part of text.split(',')) {
        const token = part.trim();
        const match = token.match(/^(\d+)(?:-(\d+))?$/);
        if (match) {
            const start = Number(match[1]);
            const end = Number(match[2] || match[1]);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
                return undefined;
            }
            for (let line = start; line <= end; line++) {
                lines.add(line);
            }
            continue;
        }
        if (/^\d+->(?:\d+|exit)$/.test(token)) {
            branches.push(token);
            continue;
        }
        return undefined;
    }
    return { lines, branches };
}

function reportRow(rawLine: string): { name: string; coverage: string; missing: string; branchMode: boolean } | undefined {
    const trimmed = rawLine.trim();
    const branch = trimmed.match(/^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+%)\s*(.*)$/);
    if (branch) {
        return { name: branch[1], coverage: branch[6], missing: branch[7].trim(), branchMode: true };
    }
    const statement = trimmed.match(/^(.*?)\s+(\d+)\s+(\d+)\s+(\d+%)\s*(.*)$/);
    if (!statement) {
        return undefined;
    }
    return { name: statement[1], coverage: statement[4], missing: statement[5].trim(), branchMode: false };
}

function branchSourceLine(arc: string): number | undefined {
    const match = arc.match(/^(\d+)->/);
    if (!match) {
        return undefined;
    }
    const line = Number(match[1]);
    return Number.isSafeInteger(line) ? line : undefined;
}

/**
 * Interpret `coverage report -m` for one target. This is deliberately based
 * on real executed-line and (when available) branch data, not a model's claim
 * that it called the target.
 */
export function assessTargetCoverage(
    output: string,
    targetFile: string,
    executableLines: number[]
): TargetCoverageAssessment {
    const targetName = path.basename(targetFile).toLowerCase();
    for (const rawLine of output.split(/\r?\n/)) {
        const row = reportRow(rawLine);
        if (!row) {
            continue;
        }
        const reportName = row.name.replace(/\\/g, '/').toLowerCase();
        if (reportName !== targetName && !reportName.endsWith(`/${targetName}`)) {
            continue;
        }
        const missing = parseMissingDetails(row.missing);
        const usableLines = [...new Set(executableLines.filter(Number.isSafeInteger))];
        const missingTargetLines = missing === undefined || usableLines.length === 0
            ? undefined
            : usableLines.filter(line => missing.lines.has(line));
        const missingTargetBranches = missing === undefined || !row.branchMode
            ? undefined
            : missing.branches.filter(arc => usableLines.includes(branchSourceLine(arc) || -1));
        return {
            available: true,
            coverageText: row.coverage,
            missingLines: row.missing || '無',
            // If coverage cannot parse its missing-line field, avoid a false
            // rejection and let normal execution/mutation validation decide.
            targetExecuted: missing === undefined || usableLines.length === 0
                ? undefined
                : usableLines.some(line => !missing.lines.has(line)),
            missingTargetLines,
            targetFullyCovered: missingTargetLines === undefined
                ? undefined
                : missingTargetLines.length === 0,
            missingTargetBranches,
            targetBranchesCovered: missingTargetBranches === undefined
                ? undefined
                : missingTargetBranches.length === 0,
        };
    }
    return { available: false, coverageText: 'N/A', missingLines: '無' };
}
