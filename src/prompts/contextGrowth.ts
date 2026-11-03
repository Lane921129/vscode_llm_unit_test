import { contextInputBudget } from './promptBudget';

export const CONTEXT_GROWTH_ROUNDING_TOKENS = 1024;
export const CONTEXT_GROWTH_INPUT_HEADROOM_TOKENS = 128;

export interface ContextGrowthInput {
    /** Effective num_ctx for this run; a saved preference is never changed here. */
    currentContextTokens: number;
    /** A ceiling obtained from verified metadata for this exact endpoint/model. */
    modelContextLimit?: number;
    modelContextLimitVerified: boolean;
    /** Complete transmitted system + prompt estimate, without truncation. */
    estimatedPromptTokens: number;
    /** Input space reserved for a subsequent correction in the same role. */
    reservedInputTokens?: number;
    /** Only set when this exact cap will also be sent on the grown request. */
    requestOutputTokens?: number;
}

export type ContextGrowthReasonCode =
    'invalid-context-growth-input'
    | 'model-context-limit-unverified'
    | 'current-context-exceeds-model-limit'
    | 'model-context-limit-reached'
    | 'prompt-exceeds-model-context';

interface ContextGrowthBudget {
    contextTokens: number;
    inputBudget: number;
    reservedOutputTokens: number;
    requiredInputTokens: number;
}

export type ContextGrowthPlan = (ContextGrowthBudget & {
    status: 'unchanged';
    qualificationRevalidationRequired: false;
}) | (ContextGrowthBudget & {
    status: 'grown';
    minimumContextTokens: number;
    modelContextLimit: number;
    qualificationRevalidationRequired: true;
}) | {
    status: 'blocked';
    reasonCode: ContextGrowthReasonCode;
};

const positiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Pure, grow-only planning. A grown capacity invalidates runtime-bound role
 * qualifications: callers must re-probe at that num_ctx before using them,
 * retain existing deadlines/counters, and keep this change inside the run. */
export function planContextGrowth(input: ContextGrowthInput): ContextGrowthPlan {
    const correctionReserve = input.reservedInputTokens === undefined ? 0 : input.reservedInputTokens;
    const outputCap = input.requestOutputTokens;
    const ceiling = input.modelContextLimit;
    if (!positiveInteger(input.currentContextTokens)
        || !nonnegativeInteger(input.estimatedPromptTokens)
        || !nonnegativeInteger(correctionReserve)
        || typeof input.modelContextLimitVerified !== 'boolean'
        || (outputCap !== undefined && !positiveInteger(outputCap))
        || (ceiling !== undefined && !positiveInteger(ceiling))
        || (input.modelContextLimitVerified && !positiveInteger(ceiling))
        || !Number.isSafeInteger(input.estimatedPromptTokens + correctionReserve)) {
        return { status: 'blocked', reasonCode: 'invalid-context-growth-input' };
    }
    if (input.modelContextLimitVerified && input.currentContextTokens > ceiling!) {
        return { status: 'blocked', reasonCode: 'current-context-exceeds-model-limit' };
    }
    const requiredInputTokens = input.estimatedPromptTokens + correctionReserve;
    const inputBudgetAt = (contextTokens: number) => outputCap === undefined
        ? contextInputBudget('', contextTokens) : contextTokens - outputCap;
    const budgetAt = (contextTokens: number): ContextGrowthBudget => ({
        contextTokens,
        inputBudget: inputBudgetAt(contextTokens),
        reservedOutputTokens: contextTokens - inputBudgetAt(contextTokens),
        requiredInputTokens
    });
    if (inputBudgetAt(input.currentContextTokens) >= requiredInputTokens) {
        return { status: 'unchanged', ...budgetAt(input.currentContextTokens), qualificationRevalidationRequired: false };
    }
    if (!input.modelContextLimitVerified) {
        return { status: 'blocked', reasonCode: 'model-context-limit-unverified' };
    }
    if (input.currentContextTokens === ceiling) {
        return { status: 'blocked', reasonCode: 'model-context-limit-reached' };
    }
    const ceilingInputBudget = inputBudgetAt(ceiling!);
    if (ceilingInputBudget < requiredInputTokens) {
        return { status: 'blocked', reasonCode: 'prompt-exceeds-model-context' };
    }
    // Binary search preserves the exact existing floor(context * .7) gate and
    // avoids multiplication/rounding overflow near the safe integer boundary.
    const smallestContextFor = (required: number): number => {
        let lower = input.currentContextTokens + 1, upper = ceiling!;
        while (lower < upper) {
            const middle = lower + Math.floor((upper - lower) / 2);
            if (inputBudgetAt(middle) >= required) { upper = middle; }
            else { lower = middle + 1; }
        }
        return lower;
    };
    const minimumContextTokens = smallestContextFor(requiredInputTokens);
    const headroom = Math.min(CONTEXT_GROWTH_INPUT_HEADROOM_TOKENS, ceilingInputBudget - requiredInputTokens);
    const withHeadroom = smallestContextFor(requiredInputTokens + headroom);
    const roundUp = (CONTEXT_GROWTH_ROUNDING_TOKENS - withHeadroom % CONTEXT_GROWTH_ROUNDING_TOKENS)
        % CONTEXT_GROWTH_ROUNDING_TOKENS;
    const contextTokens = roundUp <= ceiling! - withHeadroom ? withHeadroom + roundUp : ceiling!;
    return { status: 'grown', ...budgetAt(contextTokens), minimumContextTokens,
        modelContextLimit: ceiling!, qualificationRevalidationRequired: true };
}
