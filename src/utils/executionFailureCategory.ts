/** Stable, provider-neutral categories for report and fixture analysis. */
export type ExecutionFailureCategory =
    | 'cancelled'
    | 'timeout'
    | 'budget'
    | 'model-api'
    | 'model-format'
    | 'ast-trace'
    | 'validation'
    | 'coverage'
    | 'mutation'
    | 'environment'
    | 'unknown';

/** A stage-owned diagnostic survives wrapping and must not trigger Tier fallback. */
export class AnalysisStageError extends Error {
    constructor(readonly category: ExecutionFailureCategory, readonly stage: string,
        message: string, readonly diagnostic: unknown = undefined) {
        super(message);
        this.name = 'AnalysisStageError';
    }
}

/**
 * Classify an already-safe, user-visible error message. This is diagnostic
 * metadata only: it never changes routing, retries, or the quality gates.
 */
export function classifyExecutionFailure(message: string): ExecutionFailureCategory {
    if (message.includes('TEST_ISOLATION_BLOCKED')) { return 'validation'; }
    // Paths, Python line numbers and test names are evidence, not error kinds.
    const normalized = message.split(/\r?\n/)
        .filter(line => !/^\s*(?:File ["']|at |test_\w+.*\.\.\.)/.test(line))
        .join('\n').toLowerCase();
    if (normalized.includes('使用者強制中止') || normalized.includes('cancelled')) {
        return 'cancelled';
    }
    if (normalized.includes('目標分析預算已耗盡')) { return 'budget'; }
    if (/超時|逾時|目標分析總時限已耗盡|\btimeout\b|timed out/.test(normalized)) {
        return 'timeout';
    }
    if (/this operation was aborted|^aborterror\b/m.test(normalized)) { return 'unknown'; }
    if (normalized.includes('no module named') || normalized.includes('python executable') || normalized.includes('找不到目標檔案')) {
        return 'environment';
    }
    if (/syntaxerror:|indentationerror:|taberror:|python syntax:/.test(normalized)) { return 'model-format'; }
    if (/assertionerror:|(?:type|name|attribute|value|key|zero.?division)error:|^failed \((?:errors|failures)=/m.test(normalized)) {
        return 'validation';
    }
    if (/coverage (?:is required|品質|failed)|覆蓋率/.test(normalized)) {
        return 'coverage';
    }
    if (normalized.includes('mutation') || normalized.includes('突變') || normalized.includes('mutatest') || normalized.includes('mutmut')) {
        return 'mutation';
    }
    if (normalized.includes('dynamic trace') || normalized.includes('動態 trace') || normalized.includes('行為觀測') || /\bast\b/.test(normalized) || normalized.includes('caller literal')) {
        if (/assertraises\([^)]*\).*例外事實依據/.test(normalized)) { return 'validation'; }
        return 'ast-trace';
    }
    if (normalized.includes('模型輸出') || normalized.includes('unittest 格式') || normalized.includes('程式碼內容為空') || normalized.includes('原始碼而非測試碼')) {
        return 'model-format';
    }
    if (/\bhttp(?: error| status)?\s*[:=]?\s*[45]\d\d\b|api 請求|\b(?:econnrefused|econnreset)\b|fetch failed|socket hang up/.test(normalized)) {
        return 'model-api';
    }
    if (normalized.includes('驗證') || normalized.includes('預先驗證') || normalized.includes('測試檔')) {
        return 'validation';
    }
    return 'unknown';
}
