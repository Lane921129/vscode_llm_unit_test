import { Dispatcher, getGlobalDispatcher } from 'undici';

const MAX_TIMER_MS = 2_147_483_647;

const SAFE_TRANSPORT_FAILURE_CODES = new Set([
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Only fixed technical codes may leave the transport error boundary. */
export function isSafeTransportFailureCode(value: unknown): value is string {
    return typeof value === 'string' && SAFE_TRANSPORT_FAILURE_CODES.has(value);
}

/** Node fetch wraps the actual socket error in cause. Never copy messages,
 * URLs, arbitrary codes, or provider responses into diagnostics. */
export function getSafeTransportFailureCode(error: unknown): string | undefined {
    const visited = new Set<object>();
    let current = error;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
        if (visited.has(current)) { return undefined; }
        visited.add(current);
        try {
            const record = current as { code?: unknown; cause?: unknown };
            if (isSafeTransportFailureCode(record.code)) { return record.code; }
            current = record.cause;
        } catch { return undefined; }
    }
    return undefined;
}

export interface ModelTransportOptions {
    /** The original request deadline, including retries and complete body read. */
    deadlineAt: number;
    /** Explicit injection keeps fixtures and host fetch instrumentation intact. */
    fetcher?: typeof fetch;
    dispatcher?: Pick<Dispatcher, 'dispatch'>;
}

/** The caller owns the AbortController and keeps its absolute-deadline timer
 * active until the entire response is consumed. This wrapper only aligns the
 * HTTP inactivity limits with that allowance; it never starts another request,
 * refreshes the deadline, changes TLS/proxy policy, or owns the shared sockets.
 *
 * Override at dispatch time: some Node fetch versions explicitly supply their
 * own 300-second limits, which would otherwise override Agent defaults. */
export function fetchModelResponse(
    input: string, init: RequestInit, options: ModelTransportOptions
): Promise<Response> {
    if (!init.signal) { throw new TypeError('Model transport requires a cancellation signal.'); }
    if (!Number.isFinite(options.deadlineAt)) { throw new TypeError('Model transport requires a finite deadline.'); }
    if (init.signal.aborted || options.deadlineAt <= Date.now()) {
        return Promise.reject(new DOMException('Model request was cancelled or exceeded its deadline.', 'AbortError'));
    }
    const delegate = options.dispatcher ?? getGlobalDispatcher();
    const dispatcher = {
        dispatch(dispatchOptions: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
            const remaining = Math.max(1, Math.min(MAX_TIMER_MS, Math.ceil(options.deadlineAt - Date.now())));
            return delegate.dispatch({ ...dispatchOptions, headersTimeout: remaining, bodyTimeout: remaining }, handler);
        },
    };
    // Keep the active host/global fetch, including test replacements. The local
    // dispatcher changes no process-wide Undici settings or other HTTP users.
    const fetcher = options.fetcher ?? globalThis.fetch;
    return fetcher(input, { ...init, dispatcher } as RequestInit);
}
