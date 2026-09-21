export interface DependencyInventory {
    schemaVersion: 'dependency-inventory-v1';
    filesScanned: number; excludedDirectories: number; complete: boolean; dynamicImports: number;
    imports: { module: string; kind: 'external' | 'stdlib' | 'local';
        availability: 'available' | 'missing' | 'unknown' | 'not-checked';
        references: { file: string; line: number; context: 'required' | 'optional' | 'typing' | 'conditional' }[] }[];
    issues: { file: string; reason: string }[];
    missing: string[]; optionalMissing: string[];
}

export function isDependencyInventory(value: unknown): value is DependencyInventory {
    if (!value || typeof value !== 'object') { return false; }
    const scan = value as DependencyInventory;
    const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    const text = (value: unknown) => typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value);
    const names = (value: unknown) => Array.isArray(value) && value.length <= 10000
        && value.every(name => typeof name === 'string' && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name));
    return scan.schemaVersion === 'dependency-inventory-v1' && typeof scan.complete === 'boolean'
        && count(scan.filesScanned) && count(scan.excludedDirectories) && count(scan.dynamicImports)
        && names(scan.missing) && names(scan.optionalMissing)
        && Array.isArray(scan.issues) && scan.issues.length <= 10100
        && scan.issues.every(issue => issue && text(issue.file) && text(issue.reason))
        && Array.isArray(scan.imports) && scan.imports.length <= 10000
        && scan.imports.every(item => item && text(item.module) && ['external', 'stdlib', 'local'].includes(item.kind)
            && ['available', 'missing', 'unknown', 'not-checked'].includes(item.availability)
            && Array.isArray(item.references) && item.references.length <= 10000 && item.references.length > 0
            && item.references.every(ref => ref && text(ref.file) && count(ref.line) && ref.line > 0
                && ['required', 'optional', 'typing', 'conditional'].includes(ref.context)));
}

export function inventorySummary(scan: DependencyInventory): string {
    return `已掃描 ${scan.filesScanned} 個 Python 檔案、${scan.imports.length} 種 import；缺少 ${scan.missing.length} 個必要套件，`
        + `${scan.optionalMissing.length} 個條件／可選套件；掃描${scan.complete ? '完成' : '不完整'}。`;
}

/** Only module identifiers, project-relative references and stable diagnostic codes. */
export function inventoryReport(scan: DependencyInventory, initialMissing: string[] = [], outcome = '僅完成靜態相依盤點。'): string {
    const cell = (value: string) => value.replace(/[&<>|`\r\n]/g, char => `&#${char.charCodeAt(0)};`);
    const kinds = { external: '外部套件', stdlib: '標準庫', local: '專案模組' };
    const statuses = { available: '可找到頂層套件', missing: '缺少', unknown: '無法判定', 'not-checked': '未驗證載入' };
    const contexts = { required: '必要', optional: '可選', typing: '型別檢查', conditional: '條件分支' };
    return ['# Python 相依掃描', '', cell(outcome), '', inventorySummary(scan), '',
        '此報告只解析所選範圍的 import 並檢查頂層套件是否存在，不執行專案或外部套件。套件版本、子模組、載入副作用與動態相依仍須由正式測試預檢驗證。', '',
        `首次缺少：${initialMissing.map(cell).join('、') || '無'}。`,
        `目前必要套件缺少：${scan.missing.map(cell).join('、') || '無'}。`,
        `條件／可選／型別套件缺少：${scan.optionalMissing.map(cell).join('、') || '無'}；列入報告，不自動補裝。`,
        `略過 ${scan.excludedDirectories} 個環境、建置、輸出或連結目錄；發現 ${scan.dynamicImports} 處常見動態 import 呼叫。計算得出的或別名動態 import 無法完整靜態辨識。`, '',
        ...scan.issues.map(issue => `- ${cell(issue.file)}：${cell(issue.reason)}`), '',
        '| Import | 分類 | 檢查結果 | 使用位置（所選範圍相對路徑） |', '| --- | --- | --- | --- |',
        ...scan.imports.map(item => `| ${cell(item.module)} | ${kinds[item.kind]} | ${statuses[item.availability]} | `
            + item.references.map(ref => `${cell(ref.file)}:${ref.line}（${contexts[ref.context]}）`).join('<br>') + ' |'), '',
        '缺少必要套件時優先使用所選目錄至專案根目錄間最近的 requirements；沒有清單時只採 llmUnitTest.packageMappings 的明確對應。語法錯誤、讀取失敗或容量超限均不能算掃描成功。', ''].join('\n');
}
