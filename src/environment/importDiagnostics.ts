import { localize } from '../i18n/core';
import type { PreflightToolDiagnostic, PreflightToolReason } from '../pipeline/modulePreflight';
export interface ImportIssue {
    kind: 'import-side-effect' | 'missing-dependency' | 'dependency-api' | 'module-resolution' | 'other';
    issue: string;
    advice: string;
    origin?: { file: string; line: number };
}

export interface ImportExceptionSummary {
    exceptionType: string; message: string;
    reasonCode?: PreflightToolReason;
    exitCode?: number | null;
    detailCode?: PreflightToolDiagnostic['detailCode'];
}
const identifier = (text: unknown): text is string => typeof text === 'string' && text.length <= 240 && text.trim() === text
    && /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(text);

// Stable labels emitted by runtime_policy.py; these are not Python identifiers.
const policyOperations = new Set(['network connection', 'file read', 'file write', 'shell / subprocess',
    'replacing SQLite isolation authorizer', 'unmanaged low-level thread startup', 'replacing execution observer',
    'non-isolated SQLite connection', 'unguarded SQLite connection factory', 'SQLite extension loading',
    'custom SQLite connection factory']);

/** Only host-owned codes are retained; stderr, stdout and arbitrary error fields are never copied. */
function toolDiagnostic(diagnostic: unknown): PreflightToolDiagnostic | undefined {
    if (!diagnostic || typeof diagnostic !== 'object') { return undefined; }
    const value = diagnostic as Record<string, unknown>;
    if (value.schemaVersion !== 'module-preflight-tool-diagnostic-v1'
        || typeof value.reasonCode !== 'string' || !['timeout', 'process-failed', 'invalid-result'].includes(value.reasonCode)) { return undefined; }
    return { schemaVersion: 'module-preflight-tool-diagnostic-v1', reasonCode: value.reasonCode as PreflightToolReason,
        ...(value.exitCode === null || Number.isSafeInteger(value.exitCode) ? { exitCode: value.exitCode as number | null } : {}),
        ...(value.detailCode === 'missing-or-invalid-source-versions' ? { detailCode: value.detailCode } : {}) };
}

/** Keep a bounded Python exception, never arbitrary subprocess output or traceback. */
export function summarizeImportException(diagnostic: unknown): ImportExceptionSummary | undefined {
    const tool = toolDiagnostic(diagnostic);
    if (tool) {
        const { schemaVersion: _schemaVersion, ...details } = tool;
        return { exceptionType: 'ModulePreflightToolError', ...details,
            message: localize('模組預檢工具未完成（{0}）；未取得可確認的模組載入診斷。', tool.detailCode || tool.reasonCode) };
    }
    if (!diagnostic || typeof diagnostic !== 'object') { return undefined; }
    const value = diagnostic as Record<string, unknown>;
    if (!identifier(value.exception_type)) { return undefined; }
    let message = typeof value.message === 'string' ? value.message : '';
    // Connection URLs and credential-bearing messages must not enter reports.
    if (/[a-z][a-z\d+.-]*:\/\//i.test(message)
        || /\b(?:authorization|password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|token|secret)\b["']?\s*[:=]/i.test(message)
        || /\bBearer\s+\S+|\bAIza[\w-]{20,}|\bsk-[\w-]{16,}|\bgh[pousr]_[\w]{20,}/i.test(message)) {
        message = localize("例外訊息含可能的憑證或連線網址，已省略；請依例外類型與來源位置檢查。");
    } else {
        message = message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
        if (message.length > 600) { message = message.slice(0, 600) + '…'; }
    }
    return { exceptionType: value.exception_type, message };
}

/** Project-neutral, bounded summaries. Never include raw tracebacks in a batch table. */
export function describeImportIssue(diagnostic: any, stage: string): ImportIssue {
    const tool = toolDiagnostic(diagnostic);
    if (tool) {
        return { kind: 'other', issue: tool.reasonCode,
            advice: localize('本次未取得完整模組診斷；請依原因碼檢查 Python 預檢程序後重新檢查。前次障礙只保留為歷史證據。') };
    }
    const value = diagnostic && typeof diagnostic === 'object' ? diagnostic : {};
    let api = value.dependency_api;
    // A module __getattr__ can raise without Python's name/obj slots. Accept
    // only the exact standard message shape with validated identifier names.
    if (value.exception_type === 'AttributeError' && typeof value.message === 'string' && value.message.length <= 600
        && !(identifier(api?.module) && identifier(api?.attribute))) {
        const missing = /^module '([^']+)' has no attribute '([^']+)'$/.exec(value.message);
        if (missing && missing[0] === value.message && identifier(missing[1]) && identifier(missing[2])) {
            api = { module: missing[1], attribute: missing[2] };
        }
    }
    let result: ImportIssue;
    if (value.exception_type === 'TraceSafetyError' && value.blocked_operation === 'resource-schema-required') {
        result = { kind: 'import-side-effect', issue: 'resource-schema-required',
            advice: localize('隔離 SQLite 缺少資料表或欄位。請在「隔離測試資源」提供原專案明確的 schema 與測試資料，再重新預檢；不會猜表格或把此錯誤當預期答案。') };
    } else if (value.exception_type === 'ModuleNotFoundError' && identifier(value.missing_module)) {
        result = { kind: 'missing-dependency', issue: value.missing_module,
            advice: localize("在同一個 Python 檢查專案相依；依 requirements／明確套件對應預覽並確認安裝。") };
    } else if (value.exception_type === 'AttributeError' && identifier(api?.module)
        && identifier(api?.attribute)) {
        result = { kind: 'dependency-api', issue: `${api.module}.${api.attribute}`,
            advice: localize("已載入的模組缺少此 API。核對套件版本、來源與原專案相依宣告；重按安裝或模擬不存在的 API 不能判定修復。") };
    } else if (value.exception_type === 'TraceSafetyError'
        && (identifier(value.blocked_operation) || policyOperations.has(value.blocked_operation))) {
        result = { kind: 'import-side-effect', issue: value.blocked_operation,
            advice: localize("使用「檢查模組載入／初始化設定」預覽支援的初始化替身；保留受測原檔，設定後必須重新預檢。") };
    } else {
        result = { kind: stage === 'module-resolution' ? 'module-resolution' : 'other',
            issue: identifier(value.exception_type) ? value.exception_type : stage,
            advice: localize("查看預檢報告下方的逐模組診斷，或該目標 final_report.md 的停止原因；核對例外與來源位置。") };
    }
    const origin = value.origin;
    if (origin && typeof origin.file === 'string' && origin.file.length <= 1000 && !/^[\\/]|:|[\r\n|]/.test(origin.file)
        && !origin.file.split(/[\\/]/).some((part: string) => part === '..' || part === '')
        && Number.isSafeInteger(origin.line) && origin.line > 0) { result.origin = { file: origin.file, line: origin.line }; }
    return result;
}
