/**
 * Select a generation strategy from model size, source complexity, user
 * preference, and the provider's measured unittest-generation capability.
 */
export function resolveTier(
    modelParamBillion: number,
    complexity: number,
    userTier: string,
    testGenerationReady?: boolean
): 1 | 2 | 3 | 4 {
    // A missing or failed probe is a quality boundary, not merely an Auto
    // preference. Tier 1 remains usable because it derives assertions from
    // verified trace data instead of asking that model to author test code.
    // This prevents a newly selected provider/model from inheriting a Tier
    // decision based only on a possibly unavailable parameter-size estimate.
    if (testGenerationReady !== true) {
        return 1;
    }
    if (userTier && userTier !== 'auto') {
        const requested = parseInt(userTier.replace('tier', ''));
        if (requested >= 1 && requested <= 4) {
            return requested as 1 | 2 | 3 | 4;
        }
    }
    if (isNaN(modelParamBillion)) {
        return 4;
    }
    if (modelParamBillion <= 4) {
        return 1;
    }
    if (modelParamBillion <= 20) {
        return complexity > 65 ? 1 : 2;
    }
    if (modelParamBillion <= 60) {
        return complexity <= 40 ? 2 : 3;
    }
    return complexity <= 60 ? 3 : 4;
}

export interface DeterministicTraceAvailability {
    load_error?: unknown;
    examples?: unknown[];
    errors?: unknown[];
}

function isDeterministicTraceItem(item: unknown, needsResult: boolean): boolean {
    if (!item || typeof item !== 'object') {
        return true;
    }
    const record = item as { call_assertable?: unknown; result_assertable?: unknown };
    return record.call_assertable !== false && (!needsResult || record.result_assertable !== false);
}

/** Tier 1 is safe for an unqualified model only when verified trace data exists. */
export function canUseDeterministicTierOne(trace: DeterministicTraceAvailability | undefined): boolean {
    return Boolean(
        trace
        && !trace.load_error
        && (
            (trace.examples || []).some(example => isDeterministicTraceItem(example, true))
            || (trace.errors || []).some(error => isDeterministicTraceItem(error, false))
        )
    );
}

/**
 * Tier 1 may need a model-written fallback when tracing cannot create a safe
 * deterministic test (for example, an opaque required constructor argument).
 * That fallback is only safe after the exact provider/model has passed the
 * executable unittest probe; "unprobed" is deliberately not treated as true.
 */
export function canUseTierOneLlmFallback(testGenerationReady?: boolean): boolean {
    return testGenerationReady === true;
}
