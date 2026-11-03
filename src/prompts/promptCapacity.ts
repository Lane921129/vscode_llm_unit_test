import { contextInputBudget } from './promptBudget';
import { roleRequestBudget, type BudgetedModelRole, type WriterRevisionWorkload } from './roleRequestBudget';

export type ModelContextLimitSource = 'ollama-show' | 'stored-model-profile' | 'unknown';
export interface PromptCapacityInput {
    envType: 'local' | 'cloud' | 'custom';
    mode: 'full' | 'execution';
    role: BudgetedModelRole;
    seedPending: boolean;
    contextWindow: number;
    estimatedInputTokens: number;
    observedInputTokens?: number;
    reservedInputTokens?: number;
    revisionCurrentCode?: string;
    revisionWorkload?: WriterRevisionWorkload;
    writerOutputScope?: 'single-test-addition';
    minimumOutputTokens?: number;
    modelContextLimit?: number;
    modelContextLimitVerified: boolean;
    modelContextLimitSource?: ModelContextLimitSource;
}

/** Numerical planning evidence for this exact role prompt, never a model or quality qualification. */
export interface PromptCapacityDiagnostic {
    version: 'prompt-capacity-v1';
    scope: 'current-role-prompt';
    estimation: 'conservative-character-estimate';
    role: BudgetedModelRole;
    state: 'fits-current' | 'growth-required' | 'model-limit-insufficient' | 'model-limit-unknown';
    contextWindow: number;
    estimatedInputTokens: number;
    observedInputTokens: number | null;
    effectiveInputTokens: number;
    reservedInputTokens: number;
    requiredInputTokens: number;
    inputBudget: number;
    reservedOutputTokens: number;
    requestOutputTokens: number | null;
    inputShortfallTokens: number;
    modelContextLimit: number | null;
    modelContextLimitSource: ModelContextLimitSource;
    limitInputBudget: number | null;
    limitReservedOutputTokens: number | null;
    limitInputShortfallTokens: number | null;
    minimumContextTokens: number | null;
}

const roles: readonly string[] = ['writer', 'writer-revision', 'reviewer', 'bug-fixer', 'analyst-planning', 'analyst-quality'];
const sources: readonly string[] = ['ollama-show', 'stored-model-profile', 'unknown'];
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown): value is number => nonnegative(value) && value > 0;

/** Keep the existing role output policy at every candidate capacity. A fixed
 * current output reserve would understate the minimum when the cap grows. */
export function assessPromptCapacity(input: PromptCapacityInput): PromptCapacityDiagnostic {
    const reserve = input.reservedInputTokens ?? 0;
    const effectiveInputTokens = Math.max(input.estimatedInputTokens, input.observedInputTokens ?? 0);
    if (!['local', 'cloud', 'custom'].includes(input.envType) || !['full', 'execution'].includes(input.mode)
        || !roles.includes(input.role) || typeof input.seedPending !== 'boolean'
        || !positive(input.contextWindow) || !nonnegative(input.estimatedInputTokens) || !nonnegative(reserve)
        || !nonnegative(effectiveInputTokens + reserve) || typeof input.modelContextLimitVerified !== 'boolean'
        || input.observedInputTokens !== undefined && !nonnegative(input.observedInputTokens)
        || input.minimumOutputTokens !== undefined && !nonnegative(input.minimumOutputTokens)
        || input.writerOutputScope !== undefined && input.writerOutputScope !== 'single-test-addition'
        || input.modelContextLimitVerified && (!positive(input.modelContextLimit) || input.contextWindow > input.modelContextLimit)
        || input.modelContextLimitSource !== undefined && !sources.includes(input.modelContextLimitSource)) {
        throw new TypeError('Invalid prompt capacity inputs.');
    }
    const requiredInputTokens = effectiveInputTokens + reserve;
    const budgetAt = (contextWindow: number) => roleRequestBudget({ envType: input.envType, mode: input.mode,
        role: input.role, seedPending: input.seedPending, contextWindow,
        inputBudget: contextInputBudget('', contextWindow), revisionCurrentCode: input.revisionCurrentCode,
        revisionWorkload: input.revisionWorkload, writerOutputScope: input.writerOutputScope,
        minimumOutputTokens: input.minimumOutputTokens });
    const fitsAt = (capacity: number) => {
        const budget = budgetAt(capacity);
        return budget.reservedOutputTokens <= capacity && budget.inputBudget >= requiredInputTokens;
    };
    let lower = 1, upper = 1;
    while (!fitsAt(upper) && upper < Number.MAX_SAFE_INTEGER) {
        lower = upper + 1;
        upper = upper <= Math.floor(Number.MAX_SAFE_INTEGER / 2) ? upper * 2 : Number.MAX_SAFE_INTEGER;
    }
    let minimumContextTokens: number | null = null;
    if (fitsAt(upper)) {
        while (lower < upper) {
            const middle = lower + Math.floor((upper - lower) / 2);
            if (fitsAt(middle)) { upper = middle; } else { lower = middle + 1; }
        }
        minimumContextTokens = lower;
    }
    const selected = budgetAt(input.contextWindow);
    const limit = input.modelContextLimitVerified ? input.modelContextLimit! : null;
    const maximum = limit === null ? undefined : budgetAt(limit);
    const fits = fitsAt(input.contextWindow);
    const fitsLimit = limit !== null && fitsAt(limit);
    return {
        version: 'prompt-capacity-v1', scope: 'current-role-prompt', estimation: 'conservative-character-estimate',
        role: input.role, state: fits ? 'fits-current' : maximum ? fitsLimit
            ? 'growth-required' : 'model-limit-insufficient' : 'model-limit-unknown',
        contextWindow: input.contextWindow, estimatedInputTokens: input.estimatedInputTokens,
        observedInputTokens: input.observedInputTokens ?? null, effectiveInputTokens,
        reservedInputTokens: reserve, requiredInputTokens, inputBudget: selected.inputBudget,
        reservedOutputTokens: selected.reservedOutputTokens, requestOutputTokens: selected.requestOutputTokens ?? null,
        inputShortfallTokens: Math.max(0, requiredInputTokens - selected.inputBudget),
        modelContextLimit: limit, modelContextLimitSource: input.modelContextLimitVerified
            ? input.modelContextLimitSource ?? 'unknown' : 'unknown',
        limitInputBudget: maximum?.inputBudget ?? null, limitReservedOutputTokens: maximum?.reservedOutputTokens ?? null,
        limitInputShortfallTokens: maximum ? Math.max(0, requiredInputTokens - maximum.inputBudget) : null,
        minimumContextTokens
    };
}

/** A presentation allowlist: arbitrary stored text cannot enter framework messages. */
export function isPromptCapacityDiagnostic(value: unknown): value is PromptCapacityDiagnostic {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const data = value as Record<string, unknown>;
    return data.version === 'prompt-capacity-v1' && data.scope === 'current-role-prompt'
        && data.estimation === 'conservative-character-estimate' && typeof data.role === 'string' && roles.includes(data.role)
        && typeof data.state === 'string'
        && ['fits-current', 'growth-required', 'model-limit-insufficient', 'model-limit-unknown'].includes(data.state)
        && typeof data.modelContextLimitSource === 'string' && sources.includes(data.modelContextLimitSource) && positive(data.contextWindow)
        && ['estimatedInputTokens', 'effectiveInputTokens', 'reservedInputTokens', 'requiredInputTokens', 'inputBudget', 'reservedOutputTokens',
            'inputShortfallTokens'].every(key => nonnegative(data[key]))
        && (data.observedInputTokens === null || nonnegative(data.observedInputTokens))
        && ['requestOutputTokens', 'modelContextLimit', 'minimumContextTokens'].every(key => data[key] === null || positive(data[key]))
        && ['limitInputBudget', 'limitReservedOutputTokens', 'limitInputShortfallTokens'].every(key => data[key] === null || nonnegative(data[key]));
}
