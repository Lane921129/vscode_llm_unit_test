/** Minimum 30-second allowance for provider discovery and basic probes. */
export const CONNECTION_DISCOVERY_TIMEOUT_MS = 30_000;
export const MODEL_QUALIFICATION_TIMEOUT_MS = 60_000;

export type FetchLike<TResponse> = (
    input: string,
    init: RequestInit
) => Promise<TResponse>;

export interface StatusResponse {
    status: number;
}

export const RETRYABLE_PROVIDER_STATUS_CODES = new Set([500, 502, 503, 504]);

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
    let response: TResponse | undefined;
    const attempts = Math.max(1, maxAttempts);
    for (let attempt = 1; attempt <= attempts; attempt++) {
        response = await fetchWithTimeout(fetcher, input, init, timeoutMs);
        if (!RETRYABLE_PROVIDER_STATUS_CODES.has(response.status) || attempt === attempts) {
            return response;
        }
        await wait(750 * attempt);
    }
    // The loop always returns, but keeps TypeScript's control-flow exhaustive.
    return response as TResponse;
}
