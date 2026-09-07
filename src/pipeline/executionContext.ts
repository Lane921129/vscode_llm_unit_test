import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** One top-level analysis owns all workers, cancellation and capability facts. */
export class ExecutionContext<Snapshot = unknown> {
    readonly id = randomUUID();
    readonly snapshot: Snapshot;
    private stopped = false;
    private readonly cancellations = new Set<() => void>();

    constructor(snapshot: Snapshot) {
        this.snapshot = structuredClone(snapshot);
    }

    get cancelled(): boolean { return this.stopped; }

    throwIfCancelled(): void {
        if (this.stopped) { throw new Error('使用者強制中止'); }
    }

    onCancel(cancel: () => void): () => void {
        if (this.stopped) { cancel(); }
        else { this.cancellations.add(cancel); }
        return () => { this.cancellations.delete(cancel); };
    }

    cancel(): void {
        if (this.stopped) { return; }
        this.stopped = true;
        for (const cancel of this.cancellations) {
            try { cancel(); } catch { /* Finish cancelling the other resources. */ }
        }
        this.cancellations.clear();
    }
}

const executionStorage = new AsyncLocalStorage<ExecutionContext>();

export function currentExecution<Snapshot = unknown>(): ExecutionContext<Snapshot> | undefined {
    return executionStorage.getStore() as ExecutionContext<Snapshot> | undefined;
}

export function runInExecution<T>(context: ExecutionContext, operation: () => T): T {
    return executionStorage.run(context, operation);
}

export function isExecutionCancelled(): boolean {
    return currentExecution()?.cancelled ?? false;
}

export function throwIfExecutionCancelled(): void {
    currentExecution()?.throwIfCancelled();
}

/** Cancelled runs may drain in the background while a new run starts. */
export class ExecutionManager<Snapshot> {
    private active?: ExecutionContext<Snapshot>;

    begin(snapshot: Snapshot): ExecutionContext<Snapshot> | undefined {
        if (this.active && !this.active.cancelled) { return undefined; }
        return this.active = new ExecutionContext(snapshot);
    }

    canPublish(context: ExecutionContext<Snapshot>): boolean {
        return this.active === context && !context.cancelled;
    }

    cancel(): boolean {
        if (!this.active || this.active.cancelled) { return false; }
        this.active.cancel();
        return true;
    }

    finish(context: ExecutionContext<Snapshot>): boolean {
        if (this.active !== context) { return false; }
        this.active = undefined;
        return !context.cancelled;
    }
}
