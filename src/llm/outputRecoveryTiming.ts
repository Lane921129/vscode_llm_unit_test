import { boundedRoleAttemptDeadline, boundedRoleStageDeadline, TransportAttemptTiming } from './requestTiming';

export interface OutputRecoveryStage {
    readonly version: 'output-recovery-timing-v1';
    readonly deadlineAt: number;
    readonly timeoutSeconds: number;
    readonly maximumAttempts: 1 | 2;
}

/** Reserve the complete stage once, before requesting any output. No retry renews it. */
export function createOutputRecoveryStage(input: {
    timeoutSeconds: number; recoveryAllowed: boolean; targetDeadlineAt?: number;
    sharedDeadlineAt?: number; now?: number;
}): OutputRecoveryStage {
    const now = input.now ?? Date.now();
    const maximumAttempts = input.recoveryAllowed ? 2 : 1;
    const reserved = boundedRoleStageDeadline(input.timeoutSeconds, maximumAttempts, input.targetDeadlineAt, now);
    if (input.sharedDeadlineAt !== undefined && !Number.isFinite(input.sharedDeadlineAt)) {
        throw new TypeError('Shared output stage deadline must be finite');
    }
    return Object.freeze({ version: 'output-recovery-timing-v1', timeoutSeconds: input.timeoutSeconds,
        maximumAttempts, deadlineAt: Math.min(reserved, input.sharedDeadlineAt ?? Infinity) });
}

export function outputRecoveryAttemptDeadline(stage: OutputRecoveryStage, attempt: number, now = Date.now()): number {
    if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= stage.maximumAttempts) {
        throw new RangeError('Output recovery attempt is outside its reserved stage');
    }
    return boundedRoleAttemptDeadline(stage.deadlineAt, stage.timeoutSeconds, now);
}

export interface OutputRecoveryDecision {
    allowed: boolean;
    reasonCode: 'measured-output-fits' | 'unmeasured-full-allowance' | 'insufficient-output-retry-time';
    availableMs: number;
    estimatedRetryMs: number | null;
}

/** Estimate only from a completed length-stopped transport of the same full prompt.
 * This predicts request time, never a model's quality, GPU state or expected answer. */
export function planOutputRecoveryRetry(stage: OutputRecoveryStage, nextOutputTokens: number,
    timing?: TransportAttemptTiming, now = Date.now()): OutputRecoveryDecision {
    if (!Number.isSafeInteger(nextOutputTokens) || nextOutputTokens <= 0 || !Number.isFinite(now)) {
        throw new TypeError('Output retry requires a positive token cap and finite clock');
    }
    const availableMs = stage.maximumAttempts === 2
        ? Math.max(0, Math.min(stage.timeoutSeconds * 1000, stage.deadlineAt - now)) : 0;
    const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const stats = timing?.ollama;
    let estimatedRetryMs: number | null = null;
    if (timing?.version === 'model-request-timing-v1' && timing.kind === 'transport'
        && timing.outcome === 'completed' && stats?.done === true && stats.completionReason === 'length'
        && Number.isSafeInteger(stats.evalCount) && positive(stats.evalCount) && positive(stats.evalDurationMs)
        && nonnegative(stats.promptEvalDurationMs) && nonnegative(stats.loadDurationMs)
        && nonnegative(stats.totalDurationMs) && nonnegative(timing.elapsedMs)) {
        const estimated = Math.ceil(stats.promptEvalDurationMs + stats.loadDurationMs
            + stats.evalDurationMs / stats.evalCount * nextOutputTokens
            + Math.max(0, timing.elapsedMs - stats.totalDurationMs) + 1000);
        if (Number.isSafeInteger(estimated)) { estimatedRetryMs = estimated; }
    }
    // Without measurements, reserve a complete request instead of gambling on
    // the final few seconds of an explicit caller/target deadline.
    const requiredMs = estimatedRetryMs ?? stage.timeoutSeconds * 1000;
    const allowed = availableMs > 0 && requiredMs <= availableMs;
    return { allowed, availableMs, estimatedRetryMs, reasonCode: !allowed ? 'insufficient-output-retry-time'
        : estimatedRetryMs === null ? 'unmeasured-full-allowance' : 'measured-output-fits' };
}
