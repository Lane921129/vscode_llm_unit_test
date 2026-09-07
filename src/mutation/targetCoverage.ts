import * as path from 'path';

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
