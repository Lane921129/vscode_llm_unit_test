import { localize } from '../i18n/core';
export interface DependencyInventory {
    schemaVersion: 'dependency-inventory-v1';
    filesScanned: number; excludedDirectories: number; complete: boolean; dynamicImports: number;
    imports: { module: string; kind: 'external' | 'stdlib' | 'local' | 'unresolved-local';
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
        && scan.imports.every(item => item && text(item.module) && ['external', 'stdlib', 'local', 'unresolved-local'].includes(item.kind)
            && ['available', 'missing', 'unknown', 'not-checked'].includes(item.availability)
            && Array.isArray(item.references) && item.references.length <= 10000 && item.references.length > 0
            && item.references.every(ref => ref && text(ref.file) && count(ref.line) && ref.line > 0
                && ['required', 'optional', 'typing', 'conditional'].includes(ref.context)));
}

export function inventorySummary(scan: DependencyInventory): string {
    return localize("已掃描 {0} 個 Python 檔案、{1} 種 import；缺少 {2} 個必要套件，", scan.filesScanned, scan.imports.length, scan.missing.length)
        + localize("{0} 個條件／可選套件；掃描{1}。", scan.optionalMissing.length, scan.complete ? localize("完成") : localize("不完整"));
}

/** Only module identifiers, project-relative references and stable diagnostic codes. */
export function inventoryReport(scan: DependencyInventory, initialMissing: string[] = [], outcome = localize("僅完成靜態相依盤點。")): string {
    const cell = (value: string) => value.replace(/[&<>|`\r\n]/g, char => `&#${char.charCodeAt(0)};`);
    const kinds = { external: localize("外部套件"), stdlib: localize("標準庫"), local: localize("專案模組"), 'unresolved-local': localize("本地匯入待確認") };
    const statuses = { available: localize("可找到頂層套件"), missing: localize("缺少"), unknown: localize("無法判定"), 'not-checked': localize("未驗證載入") };
    const contexts = { required: localize("必要"), optional: localize("可選"), typing: localize("型別檢查"), conditional: localize("條件分支") };
    return [localize("# Python 相依掃描"), '', cell(outcome), '', inventorySummary(scan), '',
        localize("此報告只解析所選範圍的 import 並檢查頂層套件是否存在，不執行專案或外部套件。套件版本、子模組、載入副作用與動態相依仍須由正式測試預檢驗證。"), '',
        localize("首次缺少：{0}。", initialMissing.map(cell).join('、') || localize("無")),
        localize("目前必要套件缺少：{0}。", scan.missing.map(cell).join('、') || localize("無")),
        localize("條件／可選／型別套件缺少：{0}；列入報告，不自動補裝。", scan.optionalMissing.map(cell).join('、') || localize("無")),
        localize("略過 {0} 個環境、建置、輸出或連結目錄；發現 {1} 處常見動態 import 呼叫。計算得出的或別名動態 import 無法完整靜態辨識。", scan.excludedDirectories, scan.dynamicImports), '',
        ...scan.issues.map(issue => `- ${cell(issue.file)}：${issue.reason === 'local-import-root-unresolved'
            ? localize("附近有同名本地模組，但匯入根尚未確認；請選擇對應子專案或修正測試載入路徑，不會補裝同名外部套件。") : cell(issue.reason)}`), '',
        localize("| Import | 分類 | 檢查結果 | 使用位置（所選範圍相對路徑） |"), '| --- | --- | --- | --- |',
        ...scan.imports.map(item => `| ${cell(item.module)} | ${kinds[item.kind]} | ${statuses[item.availability]} | `
            + item.references.map(ref => `${cell(ref.file)}:${ref.line}（${contexts[ref.context]}）`).join('<br>') + ' |'), '',
        localize("缺少必要套件時優先使用所選目錄至專案根目錄間最近的 requirements；沒有清單時採 llmUnitTest.packageMappings，未對應者列為 import 同名候選，確認後嘗試 pip 安裝並重新檢查。語法錯誤、讀取失敗或容量超限均不能算掃描成功。"), ''].join('\n');
}
