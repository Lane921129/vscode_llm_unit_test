import { deadlineAtFromTimeoutSeconds } from './connectionTimeout';

function requestAllowanceMs(timeoutSeconds: number): number {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new TypeError('Role request timeout must be positive and finite');
    }
    const allowance = Math.floor(timeoutSeconds * 1000);
    if (!Number.isSafeInteger(allowance) || allowance <= 0) {
        throw new TypeError('Role request allowance must be a positive safe integer');
    }
    return allowance;
}

/** Reserve a bounded role stage up front. Each logical request still respects
 * the user's per-request allowance; transport retry and fallback never renew it. */
export function boundedRoleStageDeadline(timeoutSeconds: number, maximumAttempts = 2,
    targetDeadlineAt?: number, now = Date.now()): number {
    const allowance = requestAllowanceMs(timeoutSeconds);
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts <= 0
        || !Number.isFinite(now) || !Number.isSafeInteger(allowance * maximumAttempts)
        || (targetDeadlineAt !== undefined && !Number.isFinite(targetDeadlineAt))) {
        throw new TypeError('Role stage budget must have finite deadlines and bounded attempts');
    }
    const stageDeadlineAt = now + allowance * maximumAttempts;
    if (!Number.isFinite(stageDeadlineAt)) { throw new TypeError('Role stage deadline must be finite'); }
    return Math.min(stageDeadlineAt, targetDeadlineAt ?? Infinity);
}

/** Called once per initial/format-repair request, never per HTTP retry. */
export function boundedRoleAttemptDeadline(stageDeadlineAt: number, timeoutSeconds: number,
    now = Date.now()): number {
    requestAllowanceMs(timeoutSeconds);
    if (!Number.isFinite(stageDeadlineAt) || !Number.isFinite(now)) {
        throw new TypeError('Role attempt deadlines must be finite');
    }
    return Math.min(stageDeadlineAt, deadlineAtFromTimeoutSeconds(timeoutSeconds, now));
}

export interface OllamaGenerationTiming {
    /** Ollama durations are nanoseconds on the wire; persisted values are milliseconds. */
    loadDurationMs: number | null;
    promptEvalDurationMs: number | null;
    evalDurationMs: number | null;
    totalDurationMs: number | null;
    promptEvalCount: number | null;
    evalCount: number | null;
    done: boolean | null;
    completionReason: 'stop' | 'length' | 'unload' | null;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
    return Object.hasOwn(value, key) ? value[key] : undefined;
}

function nonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nanosecondsToMs(value: unknown): number | null {
    const duration = nonNegativeInteger(value);
    return duration === null ? null : duration / 1_000_000;
}

/** Project only known numerical metadata. Neither text, identifiers, provider
 * envelopes nor arbitrary completion reasons can enter a timing record. */
export function readOllamaGenerationTiming(payload: unknown): OllamaGenerationTiming {
    const data = record(payload);
    const done = ownValue(data, 'done');
    const reason = ownValue(data, 'done_reason');
    return {
        loadDurationMs: nanosecondsToMs(ownValue(data, 'load_duration')),
        promptEvalDurationMs: nanosecondsToMs(ownValue(data, 'prompt_eval_duration')),
        evalDurationMs: nanosecondsToMs(ownValue(data, 'eval_duration')),
        totalDurationMs: nanosecondsToMs(ownValue(data, 'total_duration')),
        promptEvalCount: nonNegativeInteger(ownValue(data, 'prompt_eval_count')),
        evalCount: nonNegativeInteger(ownValue(data, 'eval_count')),
        done: typeof done === 'boolean' ? done : null,
        completionReason: reason === 'stop' || reason === 'length' || reason === 'unload' ? reason : null
    };
}

export interface RequestQueueTiming {
    version: 'model-request-timing-v1';
    kind: 'queue';
    queueWaitMs: number | null;
}

export type TransportAttemptOutcome = 'completed' | 'http-error' | 'network-error' | 'response-error' | 'timeout' | 'cancelled';

export interface TransportAttemptTiming {
    version: 'model-request-timing-v1';
    kind: 'transport';
    transportAttempt: number | null;
    outcome: TransportAttemptOutcome | null;
    queueWaitMs: number | null;
    elapsedMs: number | null;
    /** Client wait until HTTP headers, which may include model processing. */
    httpWaitMs: number | null;
    /** Client body reading/parsing; distinct from provider inference statistics. */
    responseReadMs: number | null;
    httpStatus: number | null;
    ollama: OllamaGenerationTiming;
}

export type RequestTimingEvent = RequestQueueTiming | TransportAttemptTiming;

function elapsed(start: unknown, end: unknown): number | null {
    const validStart = nonNegativeNumber(start);
    const validEnd = nonNegativeNumber(end);
    if (validStart === null || validEnd === null || validEnd < validStart) { return null; }
    return nonNegativeNumber(validEnd - validStart);
}

export function createRequestQueueTiming(queuedAt: number, startedAt: number): RequestQueueTiming {
    return { version: 'model-request-timing-v1', kind: 'queue', queueWaitMs: elapsed(queuedAt, startedAt) };
}

export interface TransportAttemptTimingInput {
    transportAttempt: number;
    outcome: TransportAttemptOutcome;
    startedAt: number;
    finishedAt: number;
    headersAt?: number;
    responseReadStartedAt?: number;
    responseReadFinishedAt?: number;
    queueWaitMs?: number | null;
    httpStatus?: number;
    ollamaPayload?: unknown;
}

/** Keep timeout/cancellation evidence even when no response body was received.
 * Missing provider statistics remain unknown; elapsed time is never attributed
 * to GPU execution, load or evaluation without the provider's own metadata. */
export function createTransportAttemptTiming(input: TransportAttemptTimingInput): TransportAttemptTiming {
    const attempt = nonNegativeInteger(input.transportAttempt);
    const status = nonNegativeInteger(input.httpStatus);
    const outcome = input.outcome;
    return {
        version: 'model-request-timing-v1', kind: 'transport',
        transportAttempt: attempt !== null && attempt > 0 ? attempt : null,
        outcome: outcome === 'completed' || outcome === 'http-error' || outcome === 'network-error' || outcome === 'response-error'
            || outcome === 'timeout' || outcome === 'cancelled' ? outcome : null,
        queueWaitMs: nonNegativeNumber(input.queueWaitMs),
        elapsedMs: elapsed(input.startedAt, input.finishedAt),
        httpWaitMs: elapsed(input.startedAt, input.headersAt),
        responseReadMs: elapsed(input.responseReadStartedAt, input.responseReadFinishedAt),
        httpStatus: status !== null && status >= 100 && status <= 599 ? status : null,
        ollama: readOllamaGenerationTiming(input.ollamaPayload)
    };
}
