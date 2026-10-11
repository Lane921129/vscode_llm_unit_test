export type BudgetedModelRole = 'writer' | 'writer-revision' | 'reviewer' | 'bug-fixer'
    | 'analyst-planning' | 'analyst-quality';

export const WRITER_SEED_OUTPUT_TOKEN_LIMIT = 1536;

/** Pair the initial one-case seed's input allowance with its actual output cap.
 * Capacity and all other role policies remain owned by the run snapshot. */
export function roleRequestBudget(input: {
    envType: 'local' | 'cloud' | 'custom';
    mode: 'full' | 'execution';
    role: BudgetedModelRole;
    seedPending: boolean;
    contextWindow: number;
    inputBudget: number;
}): { inputBudget: number; reservedOutputTokens: number; requestOutputTokens?: number } {
    const defaultReserve = input.contextWindow - input.inputBudget;
    if (input.envType !== 'local' || input.mode !== 'full' || input.role !== 'writer' || !input.seedPending
        || !Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0
        || !Number.isSafeInteger(input.inputBudget) || input.inputBudget < 0
        || !Number.isSafeInteger(defaultReserve) || defaultReserve <= 0) {
        return { inputBudget: input.inputBudget, reservedOutputTokens: Math.max(0, defaultReserve) };
    }
    const requestOutputTokens = Math.min(WRITER_SEED_OUTPUT_TOKEN_LIMIT, defaultReserve);
    return { inputBudget: input.contextWindow - requestOutputTokens,
        reservedOutputTokens: requestOutputTokens, requestOutputTokens };
}
