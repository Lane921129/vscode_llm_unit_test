import { CandidateValidationError } from '../pipeline/testCandidatePipeline';
import { RepairResponseError } from '../pipeline/repairDiagnostics';

/** A different generation strategy cannot repair an environment, tool or review failure. */
export function mayFallbackTier(error: unknown, tier: number): boolean {
    return Number.isInteger(tier) && tier > 1 && tier <= 4
        && (error instanceof CandidateValidationError || error instanceof RepairResponseError
            && error.diagnostic.reasonCodes.length > 0
            && !error.diagnostic.reasonCodes.some(code => ['scope-tool-error', 'scope-result-invalid', 'preservation-tool-error'].includes(code)));
}

/** An unavailable method-repair role must not prevent the qualified Writer from revising the file. */
export function selectCandidateRepairRole(methodRepairAvailable: boolean, uniqueMethodFailure: boolean): 'writer' | 'bug-fixer' {
    return methodRepairAvailable && uniqueMethodFailure ? 'bug-fixer' : 'writer';
}
