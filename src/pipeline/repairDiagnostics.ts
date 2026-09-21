import { createHash } from 'crypto';

export const REPAIR_REASON_LABELS = {
    'unidentified-failure': '無法唯一定位失敗方法',
    'empty-response': '回覆為空',
    'missing-code-fence': '缺少單一 Python 程式區塊',
    'multiple-code-blocks': '回覆包含多個程式區塊',
    'extra-text': '程式區塊前後附帶其他內容',
    'invalid-json-replacement': '歷史 JSON 修復欄位不完整或無法解析',
    'class-wrapper': '回覆包含完整 class，未符合單方法契約',
    'missing-test-method': '回覆缺少 test_ 方法',
    'method-name-mismatch': '方法名稱與唯一失敗方法不符',
    'multiple-test-methods': '回覆包含多個測試方法',
    'import-limit': '新增 import 超過三個',
    'invalid-import': '方法前包含不符合契約的 import 或其他內容',
    'forbidden-entrypoint': '回覆包含 unittest.main()',
    'invalid-method-fragment': '無法合併單方法片段',
    'candidate-syntax': '修復候選無法通過 Python 語法解析',
    'previous-syntax': '原測試語法不合法，應由 Writer 處理',
    'import-removal': '移除既有 import 不符合修復限制',
    'import-star': '新增萬用 import',
    'import-conflict': '新增 import 覆蓋既有名稱綁定',
    'removed-callable': '移除或更名既有方法',
    'added-callable': '新增了不允許的方法或 helper',
    'unrelated-method-change': '修改通過或無關的方法',
    'no-method-change': '沒有修改失敗方法本身',
    'outside-method-change': '修改 fixture、signature、decorator 或方法外程式',
    'scope-tool-error': '修復範圍工具未成功執行',
    'scope-result-invalid': '修復範圍工具回傳無效資料',
    'scope-rejected': '修復範圍不符合契約（無細分原因）',
    'repeated-candidate': '候選與先前嘗試相同',
    'repeated-failure': '同一失敗已交由 Bug Fixer 處理'
} as const;
export type RepairReasonCode = keyof typeof REPAIR_REASON_LABELS;
export const repairHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function repairReasonCode(value: unknown): RepairReasonCode {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REPAIR_REASON_LABELS, value)
        ? value as RepairReasonCode : 'scope-rejected';
}

export function formatRepairRouting(detail: unknown): string {
    const value = detail as { action?: string; fromTier?: number; toTier?: number } | null;
    const labels: Record<string, string> = {
        'continue-repair': '依剩餘修訂額度重新選擇修復角色',
        'stop-revisions': '本候選修訂額度已用完，交上層保留成果或停止',
        'tier-fallback': '依既有策略降階，交 Writer 重新產生候選',
        'stop-tier-fallback': '已無可降階策略，結束本候選並保留既有成果'
    };
    const label = value?.action && Object.prototype.hasOwnProperty.call(labels, value.action) ? labels[value.action] : undefined;
    if (!label) { return ''; }
    const tiers = Number.isInteger(value?.fromTier) && Number.isInteger(value?.toTier)
        ? `（Tier ${value!.fromTier} → ${value!.toTier}）` : '';
    return `- **修復後續處理**：${label}${tiers}。\n`;
}

/** Counts are lexical hints, not a substitute for Python AST validation. No reply text is retained. */
export interface RepairResponseShape {
    characterCount: number; codeFenceCount: number; classCount: number;
    testMethodCount: number; importCount: number; hasOutsideText: boolean;
}
export interface RepairDiagnostic {
    version: 'repair-diagnostics-v1';
    gate: 'response-format' | 'repair-scope' | 'candidate-deduplication';
    reasonCodes: RepairReasonCode[];
    previousTestHash: string;
    candidateTestHash?: string;
    responseHash?: string;
    responseShape?: RepairResponseShape;
    previousTestUnchanged: true;
}

export class RepairResponseError extends Error {
    constructor(readonly diagnostic: RepairDiagnostic) {
        super('Bug Fixer 局部修復被拒絕：' + diagnostic.reasonCodes.map(code => REPAIR_REASON_LABELS[code]).join('；'));
        this.name = 'RepairResponseError';
    }
}

/** Render only allowlisted labels/counts: never interpolate model text or tool stderr. */
export function formatRepairDiagnostic(loop: number, detail: {
    attempt: number; diagnostic: RepairDiagnostic; elapsedMs?: number;
    executableBaselineAvailable?: boolean;
}): string {
    const d = detail.diagnostic;
    const reasons = d.reasonCodes.map(code => `${repairReasonCode(code)}：${REPAIR_REASON_LABELS[repairReasonCode(code)]}`).join('；');
    const shape = d.responseShape;
    return `\n### 修復失敗診斷（第 ${loop} 輪／修訂 ${detail.attempt}）\n\n`
        + `- 階段：${d.gate}；原因：${reasons}。\n`
        + (shape ? `- 回覆結構（詞法統計）：${shape.characterCount} 字元、${shape.codeFenceCount} 個程式區塊、${shape.classCount} 個 class、${shape.testMethodCount} 個測試方法、${shape.importCount} 個 import；區塊外內容：${shape.hasOutsideText ? '有' : '無'}。\n` : '')
        + `- 處理：拒絕本次修復，原測試未修改；已驗證執行基線：${detail.executableBaselineAvailable ? '已另存，繼續保留' : '尚未建立'}。\n`
        + (detail.elapsedMs === undefined ? '' : `- 本階段耗時：${detail.elapsedMs} ms。\n`)
        + '- 後續修訂／降階／停止及候選雜湊見 role_events.jsonl；拒絕原因不代表模型修復後執行結果。\n';
}
