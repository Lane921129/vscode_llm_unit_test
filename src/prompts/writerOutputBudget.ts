import { CONTEXT_GROWTH_INPUT_HEADROOM_TOKENS } from './contextGrowth';

export type WriterOutputGrowthPlan = {
    status: 'grown'; outputTokens: number; requiredInputTokens: number;
    capacityCeiling: number; boundedBy: 'preferred-growth' | 'capacity' | 'time';
} | { status: 'blocked'; reasonCode: 'invalid-output-growth-input' | 'no-output-headroom' | 'insufficient-output-retry-time' };

/** Only token counts are learned. The same complete prompt stays intact. */
export function planWriterOutputGrowth(input: {
    exhaustedCap: unknown; currentContextTokens: number; modelContextLimit?: number;
    modelContextLimitVerified: boolean; estimatedPromptTokens: number;
    observedPromptTokens?: number; reservedInputTokens: number; timedOutputLimit?: number;
}): WriterOutputGrowthPlan {
    const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (!integer(input.exhaustedCap) || input.exhaustedCap <= 0 || !integer(input.currentContextTokens)
        || input.currentContextTokens <= 0 || !integer(input.estimatedPromptTokens) || !integer(input.reservedInputTokens)
        || typeof input.modelContextLimitVerified !== 'boolean'
        || input.observedPromptTokens !== undefined && (!integer(input.observedPromptTokens) || input.observedPromptTokens <= 0)
        || input.timedOutputLimit !== undefined && !integer(input.timedOutputLimit)
        || input.modelContextLimitVerified && (!integer(input.modelContextLimit) || input.modelContextLimit < input.currentContextTokens)) {
        return { status: 'blocked', reasonCode: 'invalid-output-growth-input' };
    }
    const capacityCeiling = input.modelContextLimitVerified ? input.modelContextLimit! : input.currentContextTokens;
    const requiredInputTokens = Math.max(input.estimatedPromptTokens, input.observedPromptTokens ?? 0)
        + input.reservedInputTokens + CONTEXT_GROWTH_INPUT_HEADROOM_TOKENS;
    const preferred = Math.max(input.exhaustedCap + 1024, Math.ceil(input.exhaustedCap * 1.5));
    if (!integer(requiredInputTokens) || !integer(preferred)) {
        return { status: 'blocked', reasonCode: 'invalid-output-growth-input' };
    }
    const capacityOutput = capacityCeiling - requiredInputTokens;
    if (capacityOutput < input.exhaustedCap + 128) { return { status: 'blocked', reasonCode: 'no-output-headroom' }; }
    const outputTokens = Math.min(preferred, capacityOutput, input.timedOutputLimit ?? Infinity);
    if (outputTokens < input.exhaustedCap + 128) { return { status: 'blocked', reasonCode: 'insufficient-output-retry-time' }; }
    return { status: 'grown', outputTokens, requiredInputTokens, capacityCeiling,
        boundedBy: input.timedOutputLimit !== undefined && outputTokens === input.timedOutputLimit ? 'time'
            : outputTokens === capacityOutput ? 'capacity' : 'preferred-growth' };
}

/** Learned output needs live only inside one target. Truncated responses are
 * never reused as code; only the exact cap reported by the transport is used. */
export class WriterOutputBudget {
    private floor = 0;
    get minimumTokens(): number { return this.floor; }

    learn(tokens: number): boolean {
        if (!Number.isSafeInteger(tokens) || tokens <= this.floor || tokens <= 0) { return false; }
        this.floor = tokens;
        return true;
    }

    grow(exhaustedCap: unknown, modelLimit: unknown): number | undefined {
        if (!Number.isSafeInteger(exhaustedCap) || (exhaustedCap as number) <= 0
            || !Number.isSafeInteger(modelLimit) || (modelLimit as number) <= 128) { return undefined; }
        const needed = Math.max((exhaustedCap as number) + 1024, Math.ceil((exhaustedCap as number) * 1.5));
        const next = Math.min(needed, (modelLimit as number) - 128);
        if (!Number.isSafeInteger(next) || next <= (exhaustedCap as number) || next <= this.floor) { return undefined; }
        return this.learn(next) ? next : undefined;
    }
}
