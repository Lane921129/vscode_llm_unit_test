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
    // An explicit tier is a user choice, not a model-name inference.  The
    // generated file still has to pass the existing structural, execution,
    // coverage, and mutation gates.  Qualification only informs Auto mode;
    // otherwise a newly added or offline model could never use Tier 2–4.
    if (userTier && userTier !== 'auto') {
        const requested = parseInt(userTier.replace('tier', ''));
        if (requested >= 1 && requested <= 4) {
            return requested as 1 | 2 | 3 | 4;
        }
    }
    // Auto must remain conservative until this exact provider/model has
    // completed the harmless executable unittest probe.  It must never
    // borrow an estimate or capability result from a different model.
    if (testGenerationReady !== true) {
        return 1;
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

/** Tier 1 deterministic fallback is safe only when verified trace data exists. */
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
 * A model-authored Tier 1 test is evidence-bound by the source, AST context,
 * dynamic trace, and selected skill cards. Auto enables it only after the
 * exact provider/model has passed the executable unittest probe. A manual
 * Tier choice opts into best-effort generation, still subject to the normal
 * structural, execution, coverage, and mutation gates.
 */
export function canUseTierOneLlmGeneration(testGenerationReady?: boolean, userTier = 'auto'): boolean {
    // A manual tier selection authorizes best-effort model generation. Its
    // output is still rejected unless the normal validation pipeline proves
    // it executable; Auto mode keeps the stricter probe-first behavior.
    return testGenerationReady === true || userTier !== 'auto';
}

export type Tier1GenerationMode = 'llm-evidence-bound' | 'deterministic-fallback';

/**
 * Keep provenance explicit: deterministic output is a safe fallback when
 * Auto cannot yet trust the selected model, never a substitute labelled as
 * an LLM result.
 */
export function resolveTier1GenerationMode(
    testGenerationReady?: boolean,
    userTier = 'auto'
): Tier1GenerationMode {
    return canUseTierOneLlmGeneration(testGenerationReady, userTier)
        ? 'llm-evidence-bound'
        : 'deterministic-fallback';
}

/** @deprecated Use canUseTierOneLlmGeneration for new callers. */
export const canUseTierOneLlmFallback = canUseTierOneLlmGeneration;
