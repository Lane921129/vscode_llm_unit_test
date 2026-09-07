/** Minimum 30-second allowance for provider discovery and basic probes. */
export const CONNECTION_DISCOVERY_TIMEOUT_MS = 30_000;
export const MODEL_QUALIFICATION_TIMEOUT_MS = 60_000;

export type FetchLike<TResponse> = (
    input: string,
    init: RequestInit
) => Promise<TResponse>;

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
