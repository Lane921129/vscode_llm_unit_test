export type SerialRequestQueueExitReason = 'started' | 'timeout' | 'cancelled';

export interface SerialRequestQueueExit {
    reason: SerialRequestQueueExitReason;
    queuedAt: number;
    exitedAt: number;
    queueWaitMs: number;
    deadlineAt: number | null;
}

export interface SerialRequestQueueOptions {
    /** Absolute deadline for waiting to start; does not replace the task's own deadline. */
    deadlineAt?: number;
    /** Cancels waiting only. The caller remains responsible for aborting active work. */
    signal?: AbortSignal;
    onQueueExit?: (event: SerialRequestQueueExit) => void;
}

export class SerialRequestQueueError extends Error {
    readonly name = 'SerialRequestQueueError';
    readonly phase = 'queue';
    readonly started = false;

    constructor(readonly reasonCode: 'timeout' | 'cancelled', readonly queueWaitMs: number,
        readonly deadlineAt: number | null) {
        super(reasonCode === 'timeout' ? 'Model request expired before leaving the queue.'
            : 'Model request was cancelled before leaving the queue.');
    }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Serialize actual task lifetimes, including tasks still draining after cancellation. */
export class SerialRequestQueue {
    private tail: Promise<void> = Promise.resolve();

    run<T>(task: () => Promise<T>, options: SerialRequestQueueOptions = {}): Promise<T> {
        const deadlineAt = options.deadlineAt ?? null;
        if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) {
            return Promise.reject(new TypeError('Queue deadline must be a non-negative safe integer.'));
        }
        const queuedAt = Date.now();
        let waiting = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let resolveResult!: (value: T | PromiseLike<T>) => void;
        let rejectResult!: (error: unknown) => void;
        const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
        const cleanup = () => {
            if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
            options.signal?.removeEventListener('abort', cancelWaiting);
        };
        const queueExit = (reason: SerialRequestQueueExitReason): SerialRequestQueueExit => {
            const exitedAt = Date.now();
            return { reason, queuedAt, exitedAt, queueWaitMs: Math.max(0, exitedAt - queuedAt), deadlineAt };
        };
        const stopWaiting = (reason: 'timeout' | 'cancelled') => {
            if (!waiting) { return; }
            waiting = false;
            cleanup();
            const event = queueExit(reason);
            try { options.onQueueExit?.(event); } catch { /* Preserve the queue failure if diagnostics throw. */ }
            rejectResult(new SerialRequestQueueError(reason, event.queueWaitMs, deadlineAt));
        };
        const cancelWaiting = () => stopWaiting('cancelled');
        const armDeadline = () => {
            if (!waiting || deadlineAt === null) { return; }
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) { stopWaiting('timeout'); return; }
            // Node clamps overflowing delays to 1 ms. Split long waits without expiring early.
            timer = setTimeout(armDeadline, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
        };
        if (options.signal?.aborted) { stopWaiting('cancelled'); }
        else {
            options.signal?.addEventListener('abort', cancelWaiting, { once: true });
            armDeadline();
        }
        const execute = async () => {
            if (!waiting) { return; }
            if (options.signal?.aborted) { stopWaiting('cancelled'); return; }
            if (deadlineAt !== null && Date.now() >= deadlineAt) { stopWaiting('timeout'); return; }
            waiting = false;
            cleanup();
            try {
                options.onQueueExit?.(queueExit('started'));
                resolveResult(await task());
            } catch (error) { rejectResult(error); }
        };
        // A queued caller may already have rejected. Keep the internal chain tied
        // to the actual worker, so cancellation can never release active work early.
        const current = this.tail.then(execute, execute);
        this.tail = current.then(() => undefined, () => undefined);
        return result;
    }
}
