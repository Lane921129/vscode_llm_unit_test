import { DEFAULT_TARGET_BUDGET, planAnalysisTargetBudget, TargetBudgetLimits } from './targetBudget';

/** Bounds both UI inputs below the platform timer limit without silently
 * replacing a user's saved setting. Shared-server waits may be up to one day. */
export const MAX_EXECUTION_TIMEOUT_SECONDS = 86_400;
export const API_TIMEOUT_PREFERENCE_KEY = 'llmUnitTest.executionTiming.v1.apiTimeoutSeconds';

export function parseExecutionTimingSettings(apiSeconds: unknown, targetSeconds: unknown): {
    timeoutSeconds: number; targetTimeoutSeconds: number;
} {
    if (typeof apiSeconds !== 'number' || !Number.isSafeInteger(apiSeconds)
        || apiSeconds < 1 || apiSeconds > MAX_EXECUTION_TIMEOUT_SECONDS) {
        throw new TypeError('API timeout must be an integer from 1 to 86400 seconds');
    }
    const milliseconds = typeof targetSeconds === 'number' ? targetSeconds * 1000 : NaN;
    if (typeof targetSeconds !== 'number' || !Number.isFinite(targetSeconds)
        || targetSeconds <= 0 || targetSeconds > MAX_EXECUTION_TIMEOUT_SECONDS
        || !Number.isSafeInteger(Math.round(milliseconds)) || Math.round(milliseconds) < 1
        || Math.abs(milliseconds - Math.round(milliseconds)) > 0.000001) {
        throw new TypeError('Target timeout must be from 0.001 to 86400 seconds in whole milliseconds');
    }
    return { timeoutSeconds: apiSeconds, targetTimeoutSeconds: targetSeconds };
}

/** Snapshot once at run entry. Counters remain explicit overrides, so maxLoops
 * planning can still fill only unspecified limits. A retry never renews time. */
export function snapshotExecutionTargetBudget(raw: unknown = {}, targetSeconds?: unknown): Readonly<Partial<TargetBudgetLimits>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new TypeError('Target budget must be an object'); }
    const allowed: (keyof TargetBudgetLimits)[] = ['timeoutMs', 'logicalRequests', 'transportAttempts', 'estimatedInputTokens', 'candidateAttempts'];
    if (Object.keys(raw).some(key => !allowed.includes(key as keyof TargetBudgetLimits))) {
        throw new TypeError('Unknown target budget limit');
    }
    const result: Partial<TargetBudgetLimits> = { ...raw };
    if (targetSeconds !== undefined) {
        parseExecutionTimingSettings(1, targetSeconds);
        result.timeoutMs = Math.round((targetSeconds as number) * 1000);
    }
    result.timeoutMs ??= DEFAULT_TARGET_BUDGET.timeoutMs;
    if (result.timeoutMs > MAX_EXECUTION_TIMEOUT_SECONDS * 1000) { throw new TypeError('Target timeout exceeds 86400 seconds'); }
    planAnalysisTargetBudget(1, result);
    return Object.freeze(result);
}
