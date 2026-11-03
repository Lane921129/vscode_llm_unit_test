import { AsyncLocalStorage } from 'node:async_hooks';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { currentTargetBudget } from './targetBudget';

export interface StopPolicySettings {
    failureLimit: number;
    qualityNoImprovementLimit: number;
    batchFailureLimit: number;
}
export const DEFAULT_STOP_POLICY: Readonly<StopPolicySettings> = Object.freeze({
    failureLimit: 5, qualityNoImprovementLimit: 3, batchFailureLimit: 0
});
export function normalizeStopPolicy(value: unknown = {}): StopPolicySettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_STOP_POLICY, key))) {
        throw new TypeError('Invalid stop policy');
    }
    const input = value as Partial<StopPolicySettings>;
    const result = { ...DEFAULT_STOP_POLICY };
    for (const key of Object.keys(result) as (keyof StopPolicySettings)[]) {
        const n = input[key];
        if (n !== undefined) {
            if (!Number.isSafeInteger(n) || n < (key === 'failureLimit' ? 1 : 0)) {
                throw new TypeError(`Invalid stop policy: ${key}`);
            }
            result[key] = n;
        }
    }
    return result;
}

/** One attempt may be caught by several layers. Only its first rejection is charged. */
export class TargetStopPolicy {
    private attempt = 0;
    private readonly failedAttempts = new Set<number>();
    private reason: string | null = null;
    private readonly executedCandidates = new Set<string>();
    readonly settings: Readonly<StopPolicySettings>;
    constructor(settings: unknown = {}) { this.settings = Object.freeze(normalizeStopPolicy(settings)); }
    beginAttempt(): void { currentTargetBudget()?.assertRemaining(); this.attempt++; }
    get failureCount(): number { return this.failedAttempts.size; }
    get remainingFailures(): number { return Math.max(0, this.settings.failureLimit - this.failureCount); }
    snapshot() {
        return { failureCount: this.failureCount, failureLimit: this.settings.failureLimit,
            stopReason: this.reason, effectiveSettings: this.settings };
    }
    stop(reason: string): void { this.reason ??= reason; }
    firstExecution(codeHash: string): boolean {
        if (this.executedCandidates.has(codeHash)) { return false; }
        this.executedCandidates.add(codeHash);
        return true;
    }
    reject(reasonCode: string): void {
        currentTargetBudget()?.assertRemaining();
        this.failedAttempts.add(this.attempt);
        if (!this.remainingFailures) {
            this.stop('failure-limit');
            throw new AnalysisStageError('validation', 'target-failure-policy',
                `Target stopped after ${this.failureCount} recoverable failures (limit ${this.settings.failureLimit}).`,
                { ...this.snapshot(), reasonCode });
        }
    }
}
const storage = new AsyncLocalStorage<TargetStopPolicy>();
export const currentStopPolicy = (): TargetStopPolicy | undefined => storage.getStore();
export function runWithStopPolicy<T>(policy: TargetStopPolicy, operation: () => T): T {
    return storage.getStore() ? operation() : storage.run(policy, operation);
}
