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
}

function parseMissingLines(text: string): Set<number> | undefined {
    if (!text.trim()) {
        return new Set();
    }
    const missing = new Set<number>();
    for (const part of text.split(',')) {
        const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!match) {
            return undefined;
        }
        const start = Number(match[1]);
        const end = Number(match[2] || match[1]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
            return undefined;
        }
        for (let line = start; line <= end; line++) {
            missing.add(line);
        }
    }
    return missing;
}

/**
 * Interpret `coverage report -m` for one target.  This is deliberately based
 * on real executed-line data, not a model's claim that it called the target.
 */
export function assessTargetCoverage(
    output: string,
    targetFile: string,
    executableLines: number[]
): TargetCoverageAssessment {
    const targetName = path.basename(targetFile).toLowerCase();
    for (const rawLine of output.split(/\r?\n/)) {
        const match = rawLine.trim().match(/^(.*?)\s+(\d+)\s+(\d+)\s+(\d+%)\s*(.*)$/);
        if (!match) {
            continue;
        }
        const reportName = match[1].replace(/\\/g, '/').toLowerCase();
        if (reportName !== targetName && !reportName.endsWith(`/${targetName}`)) {
            continue;
        }
        const missingLines = match[5].trim();
        const missing = parseMissingLines(missingLines);
        const usableLines = [...new Set(executableLines.filter(Number.isSafeInteger))];
        const missingTargetLines = missing === undefined || usableLines.length === 0
            ? undefined
            : usableLines.filter(line => missing.has(line));
        return {
            available: true,
            coverageText: match[4],
            missingLines: missingLines || '無',
            // If coverage cannot parse its missing-line field, avoid a false
            // rejection and let normal execution/mutation validation decide.
            targetExecuted: missing === undefined || usableLines.length === 0
                ? undefined
                : usableLines.some(line => !missing.has(line)),
            missingTargetLines,
            targetFullyCovered: missingTargetLines === undefined
                ? undefined
                : missingTargetLines.length === 0,
        };
    }
    return { available: false, coverageText: 'N/A', missingLines: '無' };
}
