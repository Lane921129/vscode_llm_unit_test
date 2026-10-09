import { localize } from '../i18n/core';
import { ExecutionContext } from '../pipeline/executionContext';
import { PythonEnvironmentActivity } from './pythonEnvironmentSetup';

/** Keep the analysis reservation while lending its idle environment to explicit setup. */
export class AnalysisEnvironmentLease {
    private releaseUse?: () => void;
    private suspended = false;
    private constructor(private readonly activity: PythonEnvironmentActivity, release: () => void) {
        this.releaseUse = release;
    }
    static acquire(activity: PythonEnvironmentActivity): AnalysisEnvironmentLease | undefined {
        const release = activity.acquire('use');
        return release ? new AnalysisEnvironmentLease(activity, release) : undefined;
    }
    release(): void { this.releaseUse?.(); this.releaseUse = undefined; }
    async withSetup<T>(execution: ExecutionContext, operation: () => Promise<T>): Promise<T> {
        execution.throwIfCancelled();
        if (!this.releaseUse || this.suspended) { throw new Error('Analysis environment lease is unavailable'); }
        this.suspended = true;
        this.release();
        try {
            const result = await operation();
            execution.throwIfCancelled();
            return result;
        } finally {
            this.suspended = false;
            if (!execution.cancelled) {
                this.releaseUse = this.activity.acquire('use');
                if (!this.releaseUse) { throw new Error(localize('環境設定尚未釋放，批次已停止；請等待完成後重新開始。')); }
            }
        }
    }
}
