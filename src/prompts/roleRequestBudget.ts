import { estimatePromptTokens } from './promptBudget';

export type BudgetedModelRole = 'writer' | 'writer-revision' | 'reviewer' | 'bug-fixer'
    | 'analyst-planning' | 'analyst-quality';

export const WRITER_SEED_OUTPUT_TOKEN_LIMIT = 1536;
export const WRITER_ADDITION_OUTPUT_TOKEN_LIMIT = 1536;
export const ANALYST_PLAN_OUTPUT_TOKEN_LIMIT = 1024;

/** Host-owned counts from this exact revision. Findings are not a test-case
 * quota, and this character-based allowance is not a tokenizer guarantee. */
export interface WriterRevisionWorkload {
    findingCount: number;
    missingScenarioCount: number;
}

function knownRevisionWorkload(value: WriterRevisionWorkload | undefined): value is WriterRevisionWorkload {
    return !!value && Number.isSafeInteger(value.findingCount) && value.findingCount > 0 && value.findingCount <= 5
        && Number.isSafeInteger(value.missingScenarioCount) && value.missingScenarioCount >= 0
        && value.missingScenarioCount <= value.findingCount;
}

/** Pair bounded role outputs with their actual local caps. A complete current
 * revision can reclaim output headroom only when its size and work are known;
 * evidence and the selected context capacity remain unchanged. */
export function roleRequestBudget(input: {
    envType: 'local' | 'cloud' | 'custom';
    mode: 'full' | 'execution';
    role: BudgetedModelRole;
    seedPending: boolean;
    contextWindow: number;
    inputBudget: number;
    /** The exact candidate owned by this revision, never inferred from a prompt or checkpoint. */
    revisionCurrentCode?: string;
    revisionWorkload?: WriterRevisionWorkload;
    /** Set only when the host owns an executed baseline and requests one new method.
     * This is output scope, never inferred from prompt words or model identity. */
    writerOutputScope?: 'single-test-addition';
    /** A previous complete transport for this exact role ended at its output cap.
     * The caller owns separate Writer and Analyst floors; never transfer one
     * role's learned minimum to another role or a qualification probe. */
    minimumOutputTokens?: number;
}): { inputBudget: number; reservedOutputTokens: number; requestOutputTokens?: number } {
    const defaultReserve = input.contextWindow - input.inputBudget;
    const learnedMinimum = input.envType === 'local' && ['writer', 'writer-revision', 'analyst-planning'].includes(input.role)
        && Number.isSafeInteger(input.minimumOutputTokens) && (input.minimumOutputTokens as number) > 0
        ? input.minimumOutputTokens as number : 0;
    const boundedPlan = input.role === 'analyst-planning';
    const boundedSeed = input.role === 'writer' && (input.mode === 'execution' || input.seedPending);
    const boundedAddition = input.mode === 'full' && !input.seedPending
        && ['writer', 'writer-revision'].includes(input.role) && input.writerOutputScope === 'single-test-addition';
    const boundedRevision = input.role === 'writer-revision'
        && !boundedAddition && typeof input.revisionCurrentCode === 'string' && input.revisionCurrentCode.trim().length > 0;
    if (input.envType !== 'local' || (!boundedPlan && !boundedSeed && !boundedRevision && !boundedAddition)
        || !Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0
        || !Number.isSafeInteger(input.inputBudget) || input.inputBudget < 0
        || !Number.isSafeInteger(defaultReserve) || defaultReserve <= 0) {
        if (learnedMinimum && Number.isSafeInteger(input.contextWindow) && input.contextWindow > 0
            && Number.isSafeInteger(defaultReserve) && defaultReserve > 0) {
            const requestOutputTokens = Math.max(learnedMinimum, defaultReserve);
            return { inputBudget: Math.max(0, input.contextWindow - requestOutputTokens),
                reservedOutputTokens: requestOutputTokens, requestOutputTokens };
        }
        const validLocalReserve = input.envType === 'local' && Number.isSafeInteger(input.contextWindow)
            && input.contextWindow > 0 && Number.isSafeInteger(input.inputBudget) && input.inputBudget >= 0
            && Number.isSafeInteger(defaultReserve) && defaultReserve > 0;
        return { inputBudget: input.inputBudget, reservedOutputTokens: Math.max(0, defaultReserve),
            ...(validLocalReserve ? { requestOutputTokens: defaultReserve } : {}) };
    }
    if (boundedRevision) {
        // Preserve the complete candidate and modest growth. Unknown work or a
        // large file retains the original reserve instead of assuming one edit.
        const candidateReserve = Math.max(WRITER_SEED_OUTPUT_TOKEN_LIMIT,
            Math.ceil(estimatePromptTokens(input.revisionCurrentCode!) * 1.25) + 256);
        const workload = knownRevisionWorkload(input.revisionWorkload) ? input.revisionWorkload : undefined;
        if (!Number.isSafeInteger(candidateReserve) || !learnedMinimum
            && (!workload || candidateReserve >= defaultReserve)) {
            return { inputBudget: input.inputBudget, reservedOutputTokens: defaultReserve, requestOutputTokens: defaultReserve };
        }
        const workReserve = workload ? candidateReserve + 512
            * Math.max(workload.findingCount - 1, workload.missingScenarioCount) : defaultReserve;
        const requestOutputTokens = Math.max(learnedMinimum,
            candidateReserve >= defaultReserve ? candidateReserve : Math.min(defaultReserve, workReserve));
        return { inputBudget: Math.max(0, input.contextWindow - requestOutputTokens),
            reservedOutputTokens: requestOutputTokens, requestOutputTokens };
    }
    const requestOutputTokens = Math.max(learnedMinimum,
        Math.min(boundedPlan ? ANALYST_PLAN_OUTPUT_TOKEN_LIMIT
            : boundedAddition ? WRITER_ADDITION_OUTPUT_TOKEN_LIMIT : WRITER_SEED_OUTPUT_TOKEN_LIMIT, defaultReserve));
    return { inputBudget: Math.max(0, input.contextWindow - requestOutputTokens),
        reservedOutputTokens: requestOutputTokens, requestOutputTokens };
}
