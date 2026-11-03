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
const milliseconds = (value: unknown): value is number => typeof value === 'number'
    && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function validSummary(value: unknown): value is ModelCapabilitySummary {
    if (!value || typeof value !== 'object') { return false; }
    const summary = value as Partial<ModelCapabilitySummary>;
    return summary.version === 'model-capability-summary-v1' && integer(summary.completedTransports)
        && integer(summary.timedOutTransports) && integer(summary.lengthStoppedTransports)
        && integer(summary.outputTokens) && milliseconds(summary.outputEvalMs)
        && (summary.outputTokens === 0 || summary.outputEvalMs > 0);
}

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
        if (timing.outcome === 'completed' && integer(tokens) && milliseconds(duration) && duration > 0
            && Number.isSafeInteger(summary.outputTokens + tokens)
            && milliseconds(summary.outputEvalMs + duration)) {
            summary.outputTokens += tokens;
            summary.outputEvalMs += duration;
        }
    }
    return summary;
}

/** Integer millitokens/second; null means no measured output. */
export function measuredOutputRateMilli(summary: ModelCapabilitySummary): number | null {
    if (summary.version !== 'model-capability-summary-v1' || !integer(summary.outputTokens)
        || !milliseconds(summary.outputEvalMs) || summary.outputEvalMs <= 0 || summary.outputTokens <= 0) { return null; }
    const rate = Math.floor(summary.outputTokens * 1_000_000 / summary.outputEvalMs);
    return Number.isSafeInteger(rate) && rate > 0 ? rate : null;
}

/** Merge only complete summaries; malformed or overflowing observations are omitted. */
export function mergeModelCapabilitySummaries(summaries: readonly unknown[]): ModelCapabilitySummary {
    const merged = empty();
    for (const value of summaries) {
        if (!validSummary(value)) { continue; }
        const next = {
            completedTransports: merged.completedTransports + value.completedTransports,
            timedOutTransports: merged.timedOutTransports + value.timedOutTransports,
            lengthStoppedTransports: merged.lengthStoppedTransports + value.lengthStoppedTransports,
            outputTokens: merged.outputTokens + value.outputTokens,
            outputEvalMs: merged.outputEvalMs + value.outputEvalMs
        };
        if (Object.entries(next).every(([key, value]) => key === 'outputEvalMs' ? milliseconds(value) : integer(value))) {
            Object.assign(merged, next);
        }
    }
    return merged;
}
