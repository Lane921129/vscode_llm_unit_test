export interface ImportIssue {
    kind: 'import-side-effect' | 'missing-dependency' | 'dependency-api' | 'module-resolution' | 'other';
    issue: string;
    advice: string;
    origin?: { file: string; line: number };
}

/** Project-neutral, bounded summaries. Never include raw tracebacks in a batch table. */
export function describeImportIssue(diagnostic: any, stage: string): ImportIssue {
    const value = diagnostic && typeof diagnostic === 'object' ? diagnostic : {};
    const identifier = (text: unknown): text is string => typeof text === 'string' && text.length <= 240
        && /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(text);
    let result: ImportIssue;
    if (value.exception_type === 'ModuleNotFoundError' && identifier(value.missing_module)) {
        result = { kind: 'missing-dependency', issue: value.missing_module,
            advice: '在同一個 Python 檢查專案相依；依 requirements／明確套件對應預覽並確認安裝。' };
    } else if (value.exception_type === 'AttributeError' && identifier(value.dependency_api?.module)
        && identifier(value.dependency_api?.attribute)) {
        result = { kind: 'dependency-api', issue: `${value.dependency_api.module}.${value.dependency_api.attribute}`,
            advice: '已載入的模組缺少此 API。核對套件版本、來源與原專案相依宣告；重按安裝或模擬不存在的 API 不能判定修復。' };
    } else if (value.exception_type === 'TraceSafetyError' && identifier(value.blocked_operation)) {
        result = { kind: 'import-side-effect', issue: value.blocked_operation,
            advice: '使用「檢查模組載入／初始化設定」預覽支援的初始化替身；保留受測原檔，設定後必須重新預檢。' };
    } else {
        result = { kind: stage === 'module-resolution' ? 'module-resolution' : 'other', issue: stage,
            advice: '查看逐模組診斷，核對受測根目錄、匯入路徑與相依環境。' };
    }
    const origin = value.origin;
    if (origin && typeof origin.file === 'string' && origin.file.length <= 1000 && !/^[\\/]|:|[\r\n|]/.test(origin.file)
        && !origin.file.split(/[\\/]/).some((part: string) => part === '..' || part === '')
        && Number.isSafeInteger(origin.line) && origin.line > 0) { result.origin = { file: origin.file, line: origin.line }; }
    return result;
}
