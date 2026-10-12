export const TRACE_STARTUP_BUDGET_VERSION = 'trace-startup-budget-v1';
const MAX_OUTER_TIMEOUT_MS = 60_000;
const CLEANUP_ALLOWANCE_MS = 2_000;

export interface TraceStartupBudget {
    version: typeof TRACE_STARTUP_BUDGET_VERSION;
    calibrationReason: 'successful-module-preflight' | 'preflight-unavailable';
    observedPreflightElapsedMs?: number;
    planningTimeoutSeconds: number;
    totalTimeoutSeconds: number;
    caseTimeoutSeconds: 2;
    outerTimeoutMs: number;
}

/** Preallocate guarded planning, a fresh case import and process cleanup within
 * the caller's existing time remaining. This pure planner never creates a new
 * deadline, launches a worker, reuses resources, or supplies assertion evidence.
 */
export function planTraceStartupBudget(preflightElapsedMs: unknown, remainingMs: number): TraceStartupBudget {
    if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs <= 0) {
        throw new RangeError('Trace requires time remaining on the original deadline');
    }
    const observed = typeof preflightElapsedMs === 'number' && Number.isFinite(preflightElapsedMs)
        && preflightElapsedMs >= 0 ? preflightElapsedMs : undefined;
    const startupSeconds = observed === undefined ? 0 : Math.min(observed / 1000, MAX_OUTER_TIMEOUT_MS / 1000);
    const desiredPlanningSeconds = Math.max(5, startupSeconds * 2 + 1);
    // Planning may consume its allowance; the first case still repeats cold
    // import. Neither a successful preflight nor planning substitutes that run.
    const desiredTotalSeconds = Math.max(12, desiredPlanningSeconds + startupSeconds + 2);
    const outerTimeoutMs = Math.min(MAX_OUTER_TIMEOUT_MS, remainingMs,
        Math.max(20_000, desiredTotalSeconds * 1000 + CLEANUP_ALLOWANCE_MS));
    const cleanupMs = Math.min(CLEANUP_ALLOWANCE_MS, outerTimeoutMs * 0.1);
    const totalTimeoutSeconds = Math.min(desiredTotalSeconds, (outerTimeoutMs - cleanupMs) / 1000);
    return {
        version: TRACE_STARTUP_BUDGET_VERSION,
        calibrationReason: observed === undefined ? 'preflight-unavailable' : 'successful-module-preflight',
        ...(observed === undefined ? {} : { observedPreflightElapsedMs: observed }),
        planningTimeoutSeconds: Math.min(desiredPlanningSeconds, totalTimeoutSeconds),
        totalTimeoutSeconds, caseTimeoutSeconds: 2, outerTimeoutMs
    };
}
