export interface CandidateGateValidation {
    valid: boolean;
    reason?: string;
}

export interface TierTwoSubtaskGateResult {
    accepted: boolean;
    reason?: string;
}

/**
 * A divide-and-conquer subtask is safe to merge only when both independent
 * gates pass. A syntactically valid test can still contradict an observed
 * Trace, while a trace-consistent snippet can still be malformed Python.
 */
export function resolveTierTwoSubtaskGate(
    structuralValidation: CandidateGateValidation,
    traceEvidenceValidation: CandidateGateValidation
): TierTwoSubtaskGateResult {
    if (!traceEvidenceValidation.valid) {
        return { accepted: false, reason: traceEvidenceValidation.reason || 'Trace 證據驗證失敗' };
    }
    if (!structuralValidation.valid) {
        return { accepted: false, reason: structuralValidation.reason || 'Python/unittest 結構驗證失敗' };
    }
    return { accepted: true };
}
