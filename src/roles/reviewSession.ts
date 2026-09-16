import { TestReview } from './testReviewer';

export type ReviewStatus = 'completed' | 'incomplete' | 'not-required';

/** Scoped to one target analysis; keys include the complete evidence and test prompt. */
export class ReviewSession {
    private readonly cache = new Map<string, TestReview | undefined>();
    private consecutiveFailures = 0;
    constructor(private readonly failureLimit = 2) {}

    async review(key: string, request: () => Promise<TestReview | undefined>,
        event: (status: string, detail: unknown) => void): Promise<TestReview | undefined> {
        if (this.cache.has(key)) {
            const result = this.cache.get(key);
            event('cache-hit', { completed: Boolean(result) });
            return result;
        }
        if (this.consecutiveFailures >= this.failureLimit) {
            event('suspended', { consecutiveFailures: this.consecutiveFailures,
                reason: '本次分析連續審查未完成，停止額外請求；保留工具驗證並明示審查未完成。' });
            return undefined;
        }
        // Cancellation and unexpected thrown errors are not cached as model assessments.
        const result = await request();
        this.cache.set(key, result);
        this.consecutiveFailures = result ? 0 : this.consecutiveFailures + 1;
        return result;
    }
}
