import { localize } from '../i18n/core';

const roles = ['writer', 'writer-revision', 'reviewer', 'bug-fixer', 'analyst-planning', 'analyst-quality'];
const outcomes = ['completed', 'http-error', 'network-error', 'response-error', 'timeout', 'cancelled'];
const progressLabels: Record<string, string> = {
    queued: '等待模型請求佇列', dispatch: '已離開佇列，準備傳輸',
    'queue-timeout': '排隊逾時，尚未開始 HTTP 傳輸', 'queue-cancelled': '排隊取消，尚未開始 HTTP 傳輸',
    'http-request': 'HTTP 請求已交給傳輸層（尚未證明伺服器收到）', 'http-headers': '已收到 HTTP 回應標頭',
    'first-bytes': '已收到第一段回應資料', 'first-text': '已收到第一段模型文字',
    'response-completed': '回應已完整讀取（非測試通過）'
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const duration = (value: unknown): string => numeric(value) ? `${value.toFixed(1)} ms` : localize('未知');
const count = (value: unknown): string => numeric(value) && Number.isSafeInteger(value) ? String(value) : localize('未知');

/** A shared role/target deadline can expire before the configured per-request
 * limit. Describe the allowance this transport actually received, not a new
 * deadline or an inference about server processing. */
export function formatModelRequestTimeout(configuredSeconds: unknown, effectiveAllowanceMs: unknown): string {
    const configured = numeric(configuredSeconds) && configuredSeconds > 0 ? String(configuredSeconds) : localize('未知');
    const effective = numeric(effectiveAllowanceMs) ? (effectiveAllowanceMs / 1000).toFixed(3) : localize('未知');
    return localize('API 請求已達有效期限：本次傳輸可用 {0} 秒；設定的單次上限 {1} 秒，仍受原角色／目標期限限制。',
        effective, configured);
}

/** Only the timing protocol's fixed labels and safe numbers enter UI/reports.
 * Client HTTP wait can include server inference; it is not network latency. */
export function formatModelRequestTiming(detail: unknown): string | undefined {
    const data = object(detail);
    const role = typeof data.role === 'string' && roles.includes(data.role) ? data.role : localize('模型角色');
    if (data.version === 'model-request-progress-v1') {
        if (data.kind !== 'progress' || typeof data.phase !== 'string'
            || !Object.hasOwn(progressLabels, data.phase)) { return undefined; }
        const description = localize('模型請求進度：{0}，{1}；已經過 {2}，收到 {3} bytes、{4} 個回覆字元。',
            role, localize(progressLabels[data.phase]), duration(data.elapsedMs), count(data.receivedBytes), count(data.responseCharacters));
        return data.phase === 'http-request' && typeof data.requestBodyHash === 'string' && /^[0-9a-f]{64}$/.test(data.requestBodyHash)
            ? description + ' ' + localize('請求內容為 {0} bytes，SHA-256 摘要 {1}（未保存原文）。',
                count(data.requestBodyBytes), data.requestBodyHash) : description;
    }
    if (data.version !== 'model-request-timing-v1') { return undefined; }
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
