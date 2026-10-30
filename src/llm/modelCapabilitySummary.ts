import { TransportAttemptTiming } from './requestTiming';

/**
 * A provider-neutral, non-secret observation summary.  It is evidence about
 * completed transport only, never a prediction of test quality or an approval
 * to use a model for a role.
 */
export interface ModelCapabilitySummary {
    version: 'model-capability-summary-v1';
    completedTransports: number;
    timedOutTransports: number;
    lengthStoppedTransports: number;
    outputTokens: number;
    outputEvalMs: number;
}

const empty = (): ModelCapabilitySummary => ({ version: 'model-capability-summary-v1', completedTransports: 0,
    timedOutTransports: 0, lengthStoppedTransports: 0, outputTokens: 0, outputEvalMs: 0 });

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Only allowlisted numeric timing fields survive aggregation. */
export function summarizeModelCapability(events: readonly unknown[]): ModelCapabilitySummary {
    const summary = empty();
    for (const value of events) {
        if (!value || typeof value !== 'object') { continue; }
        const timing = value as Partial<TransportAttemptTiming>;
        if (timing.version !== 'model-request-timing-v1' || timing.kind !== 'transport') { continue; }
        if (timing.outcome === 'completed') { summary.completedTransports++; }
        if (timing.outcome === 'timeout') { summary.timedOutTransports++; }
        if (timing.ollama?.completionReason === 'length') { summary.lengthStoppedTransports++; }
        const tokens = timing.ollama?.evalCount, duration = timing.ollama?.evalDurationMs;
        if (integer(tokens)) { summary.outputTokens += tokens; }
        if (integer(duration)) { summary.outputEvalMs += duration; }
    }
    return summary;
}

/** Millitokens/second avoids floating point persistence; null means no measured output. */
export function measuredOutputRateMilli(summary: ModelCapabilitySummary): number | null {
    if (summary.version !== 'model-capability-summary-v1' || !integer(summary.outputTokens)
        || !integer(summary.outputEvalMs) || summary.outputEvalMs <= 0 || summary.outputTokens <= 0) { return null; }
    const rate = Math.floor(summary.outputTokens * 1_000_000 / summary.outputEvalMs);
    return Number.isSafeInteger(rate) && rate > 0 ? rate : null;
}
