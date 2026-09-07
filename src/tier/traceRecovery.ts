export interface TraceRecoveryResult {
    load_error?: unknown;
    examples?: unknown[];
    errors?: Array<{ exception?: unknown }>;
}

/**
 * Caller literals are useful only when they really invoke the selected target.
 * If they produce no usable fact, or only arity TypeErrors, retry the tracer's
 * source-guided inputs instead of letting an unrelated call site block Tier 1.
 */
export function shouldRetryTraceWithoutCallerInputs(
    trace: TraceRecoveryResult | undefined,
    suppliedInputCount: number
): boolean {
    if (!trace || suppliedInputCount <= 0 || trace.load_error) {return false;}
    if ((trace.examples?.length || 0) > 0) {return false;}
    const errors = trace.errors || [];
    if (errors.length === 0) {return true;}
    return errors.every(error => error.exception === 'TypeError');
}
