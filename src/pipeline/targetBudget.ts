import { AsyncLocalStorage } from 'node:async_hooks';
import { currentExecution } from './executionContext';
import { AnalysisStageError } from '../utils/executionFailureCategory';

export interface TargetBudgetLimits {
    timeoutMs: number;
    logicalRequests: number;
    transportAttempts: number;
    estimatedInputTokens: number;
    candidateAttempts: number;
}
export type TargetBudgetCounter = Exclude<keyof TargetBudgetLimits, 'timeoutMs'>;
export type TargetBudgetUsage = Record<TargetBudgetCounter, number>;
export interface TargetBudgetSnapshot {
    startedAt: number;
    deadlineAt: number;
    elapsedMs: number;
    remainingMs: number;
    limits: TargetBudgetLimits;
    used: TargetBudgetUsage;
}
export const DEFAULT_TARGET_BUDGET: Readonly<TargetBudgetLimits> = Object.freeze({
    timeoutMs: 10 * 60 * 1000,
    logicalRequests: 20,
    transportAttempts: 40,
    estimatedInputTokens: 200_000,
    candidateAttempts: 20
});

const counters: TargetBudgetCounter[] = ['logicalRequests', 'transportAttempts', 'estimatedInputTokens', 'candidateAttempts'];

/** One target owns one budget across roles, tiers, format repair and retries.
 * Token counts are estimates supplied by the request builder, never reported
 * as provider-billed usage. Diagnostics contain counters only, not prompts.
 */
export class TargetBudget {
    readonly startedAt: number;
    readonly deadlineAt: number;
    readonly limits: Readonly<TargetBudgetLimits>;
    private readonly now: () => number;
    private readonly used: TargetBudgetUsage = { logicalRequests: 0, transportAttempts: 0, estimatedInputTokens: 0, candidateAttempts: 0 };

    constructor(options: Partial<TargetBudgetLimits> & { deadlineAt?: number; now?: () => number } = {}) {
        this.now = options.now || Date.now;
        this.startedAt = this.now();
        if (!Number.isFinite(this.startedAt)) { throw new TypeError('Target budget clock must be finite'); }
        const limits = { ...DEFAULT_TARGET_BUDGET };
        for (const key of ['timeoutMs', ...counters] as const) {
            const value = options[key];
            if (value !== undefined) {
                if (!Number.isSafeInteger(value) || value < 0 || (key === 'timeoutMs' && value === 0)) {
                    throw new TypeError(`Invalid target budget limit: ${key}`);
                }
                limits[key] = value;
            }
        }
        if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) { throw new TypeError('Target deadline must be finite'); }
        this.limits = Object.freeze(limits);
        this.deadlineAt = Math.min(options.deadlineAt ?? Infinity, this.startedAt + limits.timeoutMs);
    }

    remainingMs(): number { return Math.max(0, this.deadlineAt - this.now()); }

    snapshot(): TargetBudgetSnapshot {
        const time = this.now();
        return { startedAt: this.startedAt, deadlineAt: this.deadlineAt,
            elapsedMs: Math.max(0, time - this.startedAt), remainingMs: Math.max(0, this.deadlineAt - time),
            limits: { ...this.limits }, used: { ...this.used } };
    }

    private exhausted(counter: 'deadline' | TargetBudgetCounter): AnalysisStageError {
        return new AnalysisStageError(counter === 'deadline' ? 'timeout' : 'budget', 'target-budget',
            counter === 'deadline' ? '目標分析總時限已耗盡；保留已有成果並停止。' : `目標分析預算已耗盡（${counter}）；保留已有成果並停止。`,
            { exhausted: counter, metrics: this.snapshot() });
    }

    assertRemaining(): void {
        currentExecution()?.throwIfCancelled();
        if (this.remainingMs() <= 0) { throw this.exhausted('deadline'); }
    }

    /** Timer callbacks use this error even if scheduling/clock precision differs. */
    deadlineError(): AnalysisStageError { return this.exhausted('deadline'); }

    /** Check every counter before committing any part of a logical operation. */
    consume(amounts: Partial<TargetBudgetUsage>): void {
        this.assertRemaining();
        if (Object.keys(amounts).some(key => !counters.includes(key as TargetBudgetCounter))) {
            throw new TypeError('Unknown target budget counter');
        }
        for (const counter of counters) {
            const amount = amounts[counter] ?? 0;
            if (!Number.isSafeInteger(amount) || amount < 0) { throw new TypeError(`Invalid target budget consumption: ${counter}`); }
            if (amount > this.limits[counter] - this.used[counter]) { throw this.exhausted(counter); }
        }
        for (const counter of counters) { this.used[counter] += amounts[counter] ?? 0; }
    }

    consumeModelRequest(): void { this.consume({ logicalRequests: 1 }); }
    consumeTransportAttempt(estimatedInputTokens = 0): void { this.consume({ transportAttempts: 1, estimatedInputTokens }); }
    consumeCandidateAttempt(): void { this.consume({ candidateAttempts: 1 }); }
}

const targetStorage = new AsyncLocalStorage<TargetBudget>();

export function currentTargetBudget(): TargetBudget | undefined { return targetStorage.getStore(); }

/** Nested role/retry helpers must not replace the enclosing target's budget. */
export function runWithTargetBudget<T>(budget: TargetBudget, operation: (active: TargetBudget) => T): T {
    const active = currentTargetBudget();
    if (active) { active.assertRemaining(); return operation(active); }
    budget.assertRemaining();
    return targetStorage.run(budget, () => operation(budget));
}
