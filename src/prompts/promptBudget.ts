import { isLocalRuntimeQualification } from '../llm/modelQualification';

/** Capability metadata only; model/provider names are deliberately absent. */
export function parameterBillions(size: string): number | undefined {
    const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*([BM])$/i);
    if (!match) { return undefined; }
    return Number(match[1]) / (match[2].toUpperCase() === 'M' ? 1000 : 1);
}

const UNKNOWN_CONTEXT_WINDOW = 4096;

export function contextInputBudget(size: string, contextLength: number): number {
    return Math.floor(runtimeContextWindow(size, contextLength) * 0.7);
}

/** Budget a selected capacity; local callers resolve allocation separately from the model upper bound. */
export function runtimeContextWindow(_size: string, contextLength: number): number {
    return Number.isSafeInteger(contextLength) && contextLength > 0
        ? contextLength : UNKNOWN_CONTEXT_WINDOW;
}

export type LocalRuntimeContextReasonCode =
    'invalid-runtime-context'
    | 'runtime-context-metadata-required'
    | 'runtime-context-exceeds-model-limit';

export type LocalRuntimeContextResolution = {
    ok: true;
    configuredTokens: number;
    contextWindow: number;
    inputBudget: number;
    mode: 'automatic' | 'explicit';
} | {
    ok: false;
    reasonCode: LocalRuntimeContextReasonCode;
};

/** Resolve one local request configuration without inferring model capabilities. */
export function resolveLocalRuntimeContext(profile: {
    paramSize: string;
    contextLength: number;
    contextLengthKnown?: boolean;
    runtimeContextTokens?: unknown;
    preferredRuntimeContextTokens?: unknown;
    preferredRuntimeContextSource?: 'user-choice' | 'captured-runtime';
    qualificationRuntime?: unknown;
    effectiveRuntimeContextTokens?: unknown;
}): LocalRuntimeContextResolution {
    const configured = profile.runtimeContextTokens === undefined ? 0 : profile.runtimeContextTokens;
    if (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured < 0) {
        return { ok: false, reasonCode: 'invalid-runtime-context' };
    }
    const knownUpperBound = profile.contextLengthKnown === true
        && Number.isSafeInteger(profile.contextLength) && profile.contextLength > 0;
    const preferred = profile.preferredRuntimeContextTokens;
    if (configured === 0 && preferred !== undefined
        && (typeof preferred !== 'number' || !Number.isSafeInteger(preferred) || preferred < 0)) {
        return { ok: false, reasonCode: 'invalid-runtime-context' };
    }
    const hasPreference = configured === 0 && typeof preferred === 'number' && preferred > 0;
    // Origin-less legacy numbers are not a fresh user instruction.
    if (hasPreference && profile.preferredRuntimeContextSource === undefined && !knownUpperBound) {
        return { ok: false, reasonCode: 'runtime-context-metadata-required' };
    }
    if (hasPreference && profile.preferredRuntimeContextSource !== undefined
        && !['user-choice', 'captured-runtime'].includes(profile.preferredRuntimeContextSource)) {
        return { ok: false, reasonCode: 'invalid-runtime-context' };
    }
    const observed = profile.effectiveRuntimeContextTokens;
    // A known model limit drives automatic allocation. Only a real user choice
    // overrides it; old captures and probe capacities must not pin auto mode.
    const userPreference = hasPreference && profile.preferredRuntimeContextSource === 'user-choice';
    const contextWindow = configured > 0 ? configured : userPreference ? preferred
        : knownUpperBound ? Math.max(1, Math.floor(profile.contextLength / 2))
        : hasPreference ? preferred
        : isLocalRuntimeQualification(profile.qualificationRuntime) ? profile.qualificationRuntime.numCtx
        : typeof observed === 'number' && Number.isSafeInteger(observed) && observed > 0 ? observed
        : UNKNOWN_CONTEXT_WINDOW;
    return {
        ok: true, configuredTokens: configured, mode: configured > 0 ? 'explicit' : 'automatic',
        contextWindow, inputBudget: Math.floor(contextWindow * 0.7)
    };
}

/** A user's explicit runtime request is not a verified architecture limit.
 * Keep the original metadata; allow the request but never auto-grow past it. */
export function contextGrowthCeiling(profile: { contextLength: number; contextLengthKnown?: boolean }, requested: number) {
    const verified = profile.contextLengthKnown === true && Number.isSafeInteger(profile.contextLength)
        && profile.contextLength > 0 && profile.contextLength >= requested;
    return { modelContextLimit: verified ? profile.contextLength : undefined, modelContextLimitVerified: verified };
}

/** Conservative estimate, not provider tokenizer usage. */
export function estimatePromptTokens(text: string): number {
    const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
    return Math.ceil((text.length - nonAscii) / 3.5 + nonAscii);
}

export function promptFits(system: string, prompt: string, budget: number, reservedInputTokens = 0): boolean {
    return Number.isSafeInteger(reservedInputTokens) && reservedInputTokens >= 0
        && estimatePromptTokens(system + '\n' + prompt) + reservedInputTokens <= budget;
}
