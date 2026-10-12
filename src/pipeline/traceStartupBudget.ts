export const TRACE_STARTUP_BUDGET_VERSION = 'trace-startup-budget-v1';
const MAX_OUTER_TIMEOUT_MS = 60_000;
const CLEANUP_ALLOWANCE_MS = 2_000;

export interface TraceStartupBudget {
    version: typeof TRACE_STARTUP_BUDGET_VERSION;
    calibrationReason: 'successful-module-preflight' | 'preflight-unavailable';
    observedPreflightElapsedMs?: number;
    planningTimeoutSeconds: number;
    totalTimeoutSeconds: number;
    caseTimeoutSeconds: number;
    outerTimeoutMs: number;
    requestedTraceTiming?: TraceTimingPreferences;
}

export interface TraceTimingPreferences { totalTimeoutSeconds: number; planningTimeoutSeconds: number; caseTimeoutSeconds: number }
export function traceTimingPreferences(total: unknown, planning: unknown, perCase: unknown): TraceTimingPreferences {
    const seconds = (value: unknown, fallback: number, maximum: number): number => typeof value === 'number'
        && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
    return { totalTimeoutSeconds: seconds(total, 60, 300), planningTimeoutSeconds: seconds(planning, 15, 300),
        caseTimeoutSeconds: seconds(perCase, 5, 30) };
}

/** Preallocate guarded planning, a fresh case import and process cleanup within
 * the caller's existing time remaining. This pure planner never creates a new
 * deadline, launches a worker, reuses resources, or supplies assertion evidence.
 */
export function planTraceStartupBudget(preflightElapsedMs: unknown, remainingMs: number, preferences?: TraceTimingPreferences): TraceStartupBudget {
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
    const configured = preferences ? traceTimingPreferences(preferences.totalTimeoutSeconds,
        preferences.planningTimeoutSeconds, preferences.caseTimeoutSeconds) : undefined;
    const outerTimeoutMs = configured ? Math.min(300_000, remainingMs, configured.totalTimeoutSeconds * 1000)
        : Math.min(MAX_OUTER_TIMEOUT_MS, remainingMs, Math.max(20_000, desiredTotalSeconds * 1000 + CLEANUP_ALLOWANCE_MS));
    const cleanupMs = Math.min(CLEANUP_ALLOWANCE_MS, outerTimeoutMs * 0.1);
    const totalTimeoutSeconds = Math.min(configured?.totalTimeoutSeconds ?? desiredTotalSeconds, (outerTimeoutMs - cleanupMs) / 1000);
    return {
        version: TRACE_STARTUP_BUDGET_VERSION,
        calibrationReason: observed === undefined ? 'preflight-unavailable' : 'successful-module-preflight',
        ...(observed === undefined ? {} : { observedPreflightElapsedMs: observed }),
        planningTimeoutSeconds: Math.min(Math.max(desiredPlanningSeconds, configured?.planningTimeoutSeconds ?? 0), totalTimeoutSeconds),
        totalTimeoutSeconds, caseTimeoutSeconds: configured ? Math.min(configured.caseTimeoutSeconds, totalTimeoutSeconds) : 2, outerTimeoutMs,
        ...(configured ? { requestedTraceTiming: configured } : {})
    };
}
