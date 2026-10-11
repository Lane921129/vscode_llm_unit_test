import { estimatePromptTokens } from './promptBudget';

export type BudgetedModelRole = 'writer' | 'writer-revision' | 'reviewer' | 'bug-fixer'
    | 'analyst-planning' | 'analyst-quality';

export const WRITER_SEED_OUTPUT_TOKEN_LIMIT = 1536;
export const ANALYST_PLAN_OUTPUT_TOKEN_LIMIT = 1024;

/** Pair bounded role outputs with their actual local caps. A complete current
 * revision can reclaim output headroom only after its size is known; evidence
 * and the selected context capacity remain unchanged. */
export function roleRequestBudget(input: {
    envType: 'local' | 'cloud' | 'custom';
    mode: 'full' | 'execution';
    role: BudgetedModelRole;
    seedPending: boolean;
    contextWindow: number;
    inputBudget: number;
    /** The exact candidate owned by this revision, never inferred from a prompt or checkpoint. */
    revisionCurrentCode?: string;
}): { inputBudget: number; reservedOutputTokens: number; requestOutputTokens?: number } {
    const defaultReserve = input.contextWindow - input.inputBudget;
    const boundedPlan = input.role === 'analyst-planning';
    const boundedSeed = input.mode === 'full' && input.role === 'writer' && input.seedPending;
    const boundedRevision = input.mode === 'full' && input.role === 'writer-revision'
        && typeof input.revisionCurrentCode === 'string' && input.revisionCurrentCode.trim().length > 0;
    if (input.envType !== 'local' || (!boundedPlan && !boundedSeed && !boundedRevision)
        || !Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0
        || !Number.isSafeInteger(input.inputBudget) || input.inputBudget < 0
        || !Number.isSafeInteger(defaultReserve) || defaultReserve <= 0) {
        return { inputBudget: input.inputBudget, reservedOutputTokens: Math.max(0, defaultReserve) };
    }
    if (boundedRevision) {
        // Preserve room for the whole candidate, modest growth, imports and a
        // closing fence. Large/unknown repairs retain the previous policy.
        const requestOutputTokens = Math.max(WRITER_SEED_OUTPUT_TOKEN_LIMIT,
            Math.ceil(estimatePromptTokens(input.revisionCurrentCode!) * 1.25) + 256);
        if (!Number.isSafeInteger(requestOutputTokens) || requestOutputTokens >= defaultReserve) {
            return { inputBudget: input.inputBudget, reservedOutputTokens: defaultReserve };
        }
        return { inputBudget: input.contextWindow - requestOutputTokens,
            reservedOutputTokens: requestOutputTokens, requestOutputTokens };
    }
    const requestOutputTokens = Math.min(boundedPlan ? ANALYST_PLAN_OUTPUT_TOKEN_LIMIT : WRITER_SEED_OUTPUT_TOKEN_LIMIT, defaultReserve);
    return { inputBudget: input.contextWindow - requestOutputTokens,
        reservedOutputTokens: requestOutputTokens, requestOutputTokens };
}
