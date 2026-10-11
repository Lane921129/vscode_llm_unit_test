import { localize } from '../i18n/core';

const roles = ['writer', 'writer-revision', 'reviewer', 'bug-fixer', 'analyst-planning', 'analyst-quality'];
const outcomes = ['completed', 'http-error', 'network-error', 'response-error', 'timeout', 'cancelled'];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const duration = (value: unknown): string => numeric(value) ? `${value.toFixed(1)} ms` : localize('未知');
const count = (value: unknown): string => numeric(value) && Number.isSafeInteger(value) ? String(value) : localize('未知');

/** Only the timing protocol's fixed labels and safe numbers enter UI/reports.
 * Client HTTP wait can include server inference; it is not network latency. */
export function formatModelRequestTiming(detail: unknown): string | undefined {
    const data = object(detail);
    if (data.version !== 'model-request-timing-v1') { return undefined; }
    const role = typeof data.role === 'string' && roles.includes(data.role) ? data.role : localize('模型角色');
    if (data.kind === 'queue') {
        return localize('模型排隊等待：{0}，{1}。', role, duration(data.queueWaitMs));
    }
    if (data.kind !== 'transport') { return undefined; }
    const outcome = typeof data.outcome === 'string' && outcomes.includes(data.outcome) ? data.outcome : localize('未知');
    const stats = object(data.ollama);
    return localize('模型請求耗時：{0}，HTTP 第 {1} 次，{2}；總耗時 {3}，HTTP 回應等待 {4}，讀取回覆 {5}。',
        role, count(data.transportAttempt), outcome, duration(data.elapsedMs), duration(data.httpWaitMs), duration(data.responseReadMs))
        + ' ' + localize('Ollama 載入 {0}，提示處理 {1}，生成 {2}；輸入 {3}、輸出 {4} tokens。缺值為未知，不能推定 GPU 耗時。',
            duration(stats.loadDurationMs), duration(stats.promptEvalDurationMs), duration(stats.evalDurationMs),
            count(stats.promptEvalCount), count(stats.evalCount));
}
