/** Stable, provider-neutral categories for report and fixture analysis. */
export type ExecutionFailureCategory =
    | 'cancelled'
    | 'timeout'
    | 'model-api'
    | 'model-format'
    | 'ast-trace'
    | 'validation'
    | 'coverage'
    | 'mutation'
    | 'environment'
    | 'unknown';

/**
 * Classify an already-safe, user-visible error message. This is diagnostic
 * metadata only: it never changes routing, retries, or the quality gates.
 */
export function classifyExecutionFailure(message: string): ExecutionFailureCategory {
    const normalized = message.toLowerCase();
    if (normalized.includes('使用者強制中止') || normalized.includes('cancelled')) {
        return 'cancelled';
    }
    if (normalized.includes('超時') || normalized.includes('timeout') || normalized.includes('abort')) {
        return 'timeout';
    }
    if (normalized.includes('no module named') || normalized.includes('python executable') || normalized.includes('找不到目標檔案')) {
        return 'environment';
    }
    if (normalized.includes('coverage') || normalized.includes('覆蓋率')) {
        return 'coverage';
    }
    if (normalized.includes('mutation') || normalized.includes('突變') || normalized.includes('mutatest') || normalized.includes('mutmut')) {
        return 'mutation';
    }
    if (normalized.includes('dynamic trace') || normalized.includes('動態 trace') || normalized.includes('ast') || normalized.includes('caller literal')) {
        return 'ast-trace';
    }
    if (normalized.includes('模型輸出') || normalized.includes('unittest 格式') || normalized.includes('程式碼內容為空') || normalized.includes('原始碼而非測試碼')) {
        return 'model-format';
    }
    if (normalized.includes('http ') || normalized.includes('api 請求') || normalized.includes('llm') || /\b(?:401|403|404|429|5\d\d)\b/.test(normalized)) {
        return 'model-api';
    }
    if (normalized.includes('驗證') || normalized.includes('預先驗證') || normalized.includes('測試檔')) {
        return 'validation';
    }
    return 'unknown';
}
