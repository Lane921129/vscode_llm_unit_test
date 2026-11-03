import { TargetCoverageAssessment } from '../mutation/targetCoverage';

/** Compare measured sets, never translated/display strings or model advice. */
export function compareCoverageQuality(previous: TargetCoverageAssessment, current: TargetCoverageAssessment) {
    const addedLines = (current.missingTargetLines || []).filter(line =>
        previous.missingTargetLines !== undefined && !previous.missingTargetLines.includes(line));
    const addedBranches = (current.missingTargetBranches || []).filter(arc =>
        previous.missingTargetBranches !== undefined && !previous.missingTargetBranches.includes(arc));
    const lostEvidence = [
        previous.available && !current.available ? 'coverage-unavailable' : '',
        previous.missingTargetLines !== undefined && current.missingTargetLines === undefined ? 'lines-unknown' : '',
        previous.missingTargetBranches !== undefined && current.missingTargetBranches === undefined ? 'branches-unknown' : '',
        previous.targetExecuted === true && current.targetExecuted !== true ? 'target-no-longer-executed' : ''
    ].filter(Boolean);
    return { regressed: Boolean(addedLines.length || addedBranches.length || lostEvidence.length),
        addedLines, addedBranches, lostEvidence };
}

/** Stable per-gap identities also prevent wording/order changes resetting stagnation. */
export function coverageGapIds(coverage: TargetCoverageAssessment): string[] {
    return [
        ...(!coverage.available ? ['coverage:unavailable'] : []),
        ...(coverage.missingTargetLines === undefined ? ['lines:unknown']
            : coverage.missingTargetLines.map(line => `line:${line}`)),
        ...(coverage.missingTargetBranches === undefined ? ['branches:unknown']
            : coverage.missingTargetBranches.map(arc => `branch:${arc}`)),
        ...(coverage.targetExecuted === false ? ['target:not-executed'] : [])
    ];
}
