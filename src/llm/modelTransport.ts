import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

const MAX_TIMER_MS = 2_147_483_647;
interface TransportScope {
    deadlineAt: number;
    failure?: Error;
    abort: AbortController;
}
const transportScope = new AsyncLocalStorage<TransportScope>();

// Observe requests after the host has selected its proxy/certificate Agent.
// This channel is published synchronously before dispatch. Timeout fields are
// runtime capabilities, not a public Undici API: verify both before changing
// either and reject this request if a future runtime removes them. Never throw
// from a diagnostics subscriber (Node promotes that to uncaughtException).
channel('undici:request:create').subscribe(message => {
    const scope = transportScope.getStore();
    if (!scope || scope.failure) { return; }
    try {
        const request = (message as { request?: object })?.request;
        if (!request) { throw new Error(); }
        for (const name of ['headersTimeout', 'bodyTimeout']) {
            const field = Object.getOwnPropertyDescriptor(request, name);
            if (!field || !('value' in field) || !field.writable
                || field.value !== undefined && (typeof field.value !== 'number' || !Number.isFinite(field.value) || field.value < 0)) {
                throw new Error();
            }
        }
        const remaining = Math.max(1, Math.min(MAX_TIMER_MS, Math.ceil(scope.deadlineAt - Date.now())));
        Object.assign(request, { headersTimeout: remaining, bodyTimeout: remaining });
    } catch {
        scope.failure = Object.assign(new TypeError('Model transport timeout control is unavailable in this runtime.'),
            { code: 'MODEL_TRANSPORT_TIMEOUT_UNSUPPORTED' });
        scope.abort.abort(scope.failure);
    }
});

const SAFE_TRANSPORT_FAILURE_CODES = new Set([
    'MODEL_TRANSPORT_TIMEOUT_UNSUPPORTED',
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
}

/** The caller owns the AbortController and keeps its absolute-deadline timer
 * active until the entire response is consumed. This wrapper only aligns the
 * HTTP inactivity limits with that allowance; it never starts another request,
 * refreshes the deadline, changes TLS/proxy policy, or owns the shared sockets.
 *
 * No caller dispatcher is injected: VS Code must retain its proxy lookup and
 * certificate Agent. The scoped create hook also works when it replaces Agent.
 * Fetch implementations outside Undici retain their own transport policy. */
export function fetchModelResponse(
    input: string, init: RequestInit, options: ModelTransportOptions
): Promise<Response> {
    if (!init.signal) { throw new TypeError('Model transport requires a cancellation signal.'); }
    if (!Number.isFinite(options.deadlineAt)) { throw new TypeError('Model transport requires a finite deadline.'); }
    if (init.signal.aborted || options.deadlineAt <= Date.now()) {
        return Promise.reject(new DOMException('Model request was cancelled or exceeded its deadline.', 'AbortError'));
    }
    const scope: TransportScope = { deadlineAt: options.deadlineAt, abort: new AbortController() };
    const fetcher = options.fetcher ?? globalThis.fetch;
    return transportScope.run(scope, async () => {
        try {
            const response = await fetcher(input, { ...init, signal: AbortSignal.any([init.signal!, scope.abort.signal]) });
            if (scope.failure) {
                void response.body?.cancel().catch(() => undefined);
                throw scope.failure;
            }
            return response;
        } catch (error) { throw scope.failure ?? error; }
    });
}
