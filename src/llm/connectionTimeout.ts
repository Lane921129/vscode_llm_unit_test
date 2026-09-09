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
}

export const RETRYABLE_PROVIDER_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
export const GENERATION_RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 750;
const RETRY_MAX_DELAY_MS = 8_000;

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
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await request();
            if (!RETRYABLE_PROVIDER_STATUS_CODES.has(response.status) || attempt === maxAttempts) {
                return response;
            }
            const delayMs = retryDelay(attempt, random);
            options.onRetry?.({
                retryAttempt: attempt + 1,
                maxAttempts,
                delayMs,
                reason: `HTTP ${response.status}`
            });
            await wait(delayMs);
        } catch (error) {
            lastError = error;
            if (options.isCancelled?.() || attempt === maxAttempts) {
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
    }
    throw lastError instanceof Error ? lastError : new Error('Provider request failed without a response');
}

function retryDelay(failedAttempt: number, random: () => number): number {
    const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempt - 1));
    // Full jitter prevents a batch of models from retrying at exactly the same
    // moment. Clamp injectable test doubles to keep the result bounded.
    const jitter = Math.max(0, Math.min(1, random()));
    return Math.round(exponential * (0.5 + jitter * 0.5));
}
