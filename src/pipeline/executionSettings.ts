export const DEFAULT_MAX_LOOPS = 5;
export const DEFAULT_MUTATION_TIMEOUT_SECONDS = 20;

function positiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Defaults also apply to commands invoked outside the Webview. Explicit values remain configurable. */
export function normalizeExecutionSettings(input: { maxLoops?: unknown; mutpyTimeout?: unknown }): {
    maxLoops: number; mutpyTimeout: number;
} {
    return {
        maxLoops: positiveInteger(input.maxLoops, DEFAULT_MAX_LOOPS),
        mutpyTimeout: positiveInteger(input.mutpyTimeout, DEFAULT_MUTATION_TIMEOUT_SECONDS)
    };
}
