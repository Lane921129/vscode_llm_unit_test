import { AnalysisStageError } from '../utils/executionFailureCategory';

/** Minimum 30-second allowance for provider discovery and basic probes. */
export const CONNECTION_DISCOVERY_TIMEOUT_MS = 30_000;
export const MODEL_QUALIFICATION_TIMEOUT_MS = 60_000;
/** Generated probe code gets the same minimum execution allowance as normal tests. */
export const MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS = 30_000;

export type FetchLike<TResponse> = (
    input: string,
    init: RequestInit
) => Promise<TResponse>;

export interface StatusResponse {
    status: number;
    /** A discarded retry must release its connection without awaiting cleanup. */
    body?: { cancel(): Promise<unknown> } | null;
}

export interface JsonResponse extends StatusResponse {
    ok: boolean;
    json(): Promise<unknown>;
}

/** Never let a broken or locked response body extend the caller's deadline. */
export function discardProviderResponse(response: StatusResponse): void {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* Preserve the original result. */ }
}

/** One allowance covers dispatch, any retries/fallbacks, and the complete JSON
 * body. The race also bounds transports which ignore AbortSignal. Only successful
 * responses are decoded; rejected provider bodies never become diagnostics. */
export async function requestJsonWithTimeout<TResponse extends JsonResponse>(
    request: (signal: AbortSignal) => Promise<TResponse>, timeoutMs: number,
    signal?: AbortSignal | null
): Promise<{ response: TResponse; payload?: unknown }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new TypeError('Provider response timeout must be a bounded positive integer.');
    }
    const controller = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    let response: TResponse | undefined;
    let discarded: TResponse | undefined;
    const discard = () => {
        if (response && discarded !== response) { discarded = response; discardProviderResponse(response); }
    };
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const cancel = () => {
        if (controller.signal.aborted) { return; }
        controller.abort();
        discard();
        rejectAbort(new DOMException('Provider response was cancelled or exceeded its deadline.', 'AbortError'));
    };
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    const operation = async () => {
        if (controller.signal.aborted) { return aborted; }
        response = await request(controller.signal);
        if (Date.now() >= deadlineAt) { cancel(); }
        if (controller.signal.aborted) { discard(); return aborted; }
        if (!response.ok) { discard(); return { response }; }
        let payload: unknown;
        try { payload = await response.json(); }
        catch {
            if (Date.now() >= deadlineAt) { cancel(); }
            if (controller.signal.aborted) { return aborted; }
            // Native JSON parser errors may contain the provider's private text.
            throw new Error('Provider returned an invalid JSON response.');
        }
        if (Date.now() >= deadlineAt) { cancel(); }
        if (controller.signal.aborted) { return aborted; }
        return { response, payload };
    };
    try {
        if (signal?.aborted) { cancel(); }
        return await Promise.race([operation(), aborted]);
    } catch (error) {
        if (!controller.signal.aborted) {
            controller.abort();
            discard();
        }
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}

/** JSON counterpart of fetchWithTimeout: the timer outlives HTTP headers. */
export function fetchJsonWithTimeout<TResponse extends JsonResponse>(
    fetcher: FetchLike<TResponse>, input: string, init: RequestInit, timeoutMs: number
): Promise<{ response: TResponse; payload?: unknown }> {
    return requestJsonWithTimeout(signal => fetcher(input, { ...init, signal }), timeoutMs, init.signal);
}

export const RETRYABLE_PROVIDER_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
export const GENERATION_RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 750;
const RETRY_MAX_DELAY_MS = 8_000;

/** Convert the user's per-generation allowance into one absolute deadline. */
export function deadlineAtFromTimeoutSeconds(timeoutSeconds: number, now = Date.now()): number {
    return now + Math.max(0, Math.floor(timeoutSeconds * 1000));
}

/** Remaining allowance for a request that may use retries or output fallbacks. */
export function remainingDeadlineMs(deadlineAt: number, now = Date.now()): number {
    return Math.max(0, deadlineAt - now);
}

/**
 * Run exactly one provider request with its own deadline.
 *
 * Discovery and qualification are separate network phases. Reusing one
 * AbortController would let a slow model-list request consume the model's
 * whole generation budget and incorrectly mark a usable model unqualified.
 */
export async function fetchWithTimeout<TResponse>(
    fetcher: FetchLike<TResponse>,
    input: string,
    init: RequestInit,
    timeoutMs: number
): Promise<TResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetcher(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Retry only transient provider-side failures for an idempotent probe request.
 * Authentication, quota and malformed-request errors deliberately remain a
 * single attempt so the user receives their actionable error without delay.
 */
export async function fetchWithServerRetry<TResponse extends StatusResponse>(
    fetcher: FetchLike<TResponse>,
    input: string,
    init: RequestInit,
    timeoutMs: number,
    maxAttempts = 2,
    wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
): Promise<TResponse> {
    return retryTransientProviderRequest(
        () => fetchWithTimeout(fetcher, input, init, timeoutMs),
        { maxAttempts, wait }
    );
}

export interface ProviderRetryEvent {
    /** 1-based ordinal of the retry which is about to start. */
    retryAttempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
}

export interface ProviderRetryOptions {
    maxAttempts?: number;
    wait?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    onRetry?: (event: ProviderRetryEvent) => void;
    /** Avoid retrying cancellation/timeout errors supplied by the caller. */
    isCancelled?: () => boolean;
}

/**
 * Bounded exponential backoff for model-generation REST requests.
 *
 * Generation has no external side effect in this extension, so replaying a
 * request after a transient transport or provider failure is safe. The caller
 * retains ownership of the total deadline and cancellation signal; this helper
 * only decides which failures merit another attempt.
 */
export async function retryTransientProviderRequest<TResponse extends StatusResponse>(
    request: () => Promise<TResponse>,
    options: ProviderRetryOptions = {}
): Promise<TResponse> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? GENERATION_RETRY_MAX_ATTEMPTS);
    const wait = options.wait ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const random = options.random ?? Math.random;

    let attempt = 1;
    while (true) {
        // A response can arrive just before a deadline and spend the remaining
        // time in backoff. Do not launch one more request after that deadline.
        // Keep the first attempt unchanged so an already-aborted caller retains
        // its original, actionable abort error.
        if (attempt > 1 && options.isCancelled?.()) {
            throw new Error('Provider request was cancelled or exceeded its deadline');
        }
        try {
            const response = await request();
            if (!RETRYABLE_PROVIDER_STATUS_CODES.has(response.status) || attempt >= maxAttempts) {
                return response;
            }
            discardProviderResponse(response);
            const delayMs = retryDelay(attempt, random);
            options.onRetry?.({
                retryAttempt: attempt + 1,
                maxAttempts,
                delayMs,
                reason: `HTTP ${response.status}`
            });
            await wait(delayMs);
        } catch (error) {
            if (error instanceof AnalysisStageError || options.isCancelled?.() || attempt >= maxAttempts) {
                throw error;
            }
            const delayMs = retryDelay(attempt, random);
            options.onRetry?.({
                retryAttempt: attempt + 1,
                maxAttempts,
                delayMs,
                reason: 'network error'
            });
            await wait(delayMs);
        }
        attempt++;
    }
}

function retryDelay(failedAttempt: number, random: () => number): number {
    const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempt - 1));
    // Full jitter prevents a batch of models from retrying at exactly the same
    // moment. Clamp injectable test doubles to keep the result bounded.
    const jitter = Math.max(0, Math.min(1, random()));
    return Math.round(exponential * (0.5 + jitter * 0.5));
}
