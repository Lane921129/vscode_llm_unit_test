import { localize } from '../i18n/core';
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
    'baseline-syntax': '保留基線無法通過 Python 語法解析',
    'invalid-protected-methods': '已通過方法的身分無法對應保留基線',
    'duplicate-binding': '重複名稱綁定使通過案例保護無法確認',
    'removed-passing-method': '移除或更名已通過的方法',
    'passing-signature-changed': '修改已通過方法的簽名、裝飾器或同步形式',
    'assertion-weakened': '移除、替換或放寬已通過的斷言',
    'passing-scenario-changed': '修改已通過案例的輸入、設定或執行步驟',
    'fixture-context-changed': '修改已通過案例共用的 fixture 或 helper',
    'import-binding-changed': '修改或遮蔽已通過案例的 import 綁定',
    'unsupported-preservation': '無法證明修訂保留已通過案例',
    'preservation-tool-error': '已通過案例保護工具未成功執行',
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
        'continue-repair': localize("依剩餘修訂額度重新選擇修復角色"),
        'stop-revisions': localize("本候選修訂額度已用完，交上層保留成果或停止"),
        'writer-recovery': localize("局部修復未產生有效變更，在目標總預算內交 Writer 接手一次；保留已通過案例並重新驗證"),
        'tier-fallback': localize("依既有策略降階，交 Writer 重新產生候選"),
        'stop-tier-fallback': localize("已無可降階策略，結束本候選並保留既有成果")
    };
    const label = value?.action && Object.prototype.hasOwnProperty.call(labels, value.action) ? labels[value.action] : undefined;
    if (!label) { return ''; }
    const tiers = Number.isInteger(value?.fromTier) && Number.isInteger(value?.toTier)
        ? `（Tier ${value!.fromTier} → ${value!.toTier}）` : '';
    return localize("- **修復後續處理**：{0}{1}。\n", label, tiers);
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
        super(localize("Bug Fixer 局部修復被拒絕：") + diagnostic.reasonCodes.map(code => localize(REPAIR_REASON_LABELS[code])).join('; '));
        this.name = 'RepairResponseError';
    }
}

/** Render only allowlisted labels/counts: never interpolate model text or tool stderr. */
export function formatRepairDiagnostic(loop: number, detail: {
    attempt: number; diagnostic: RepairDiagnostic; elapsedMs?: number;
    executableBaselineAvailable?: boolean;
}): string {
    const d = detail.diagnostic;
    const reasons = d.reasonCodes.map(code => `${repairReasonCode(code)}：${localize(REPAIR_REASON_LABELS[repairReasonCode(code)])}`).join('; ');
    const shape = d.responseShape;
    return localize("\n### 修復失敗診斷（第 {0} 輪／修訂 {1}）\n\n", loop, detail.attempt)
        + localize("- 階段：{0}；原因：{1}。\n", d.gate, reasons)
        + (shape ? localize("- 回覆結構（詞法統計）：{0} 字元、{1} 個程式區塊、{2} 個 class、{3} 個測試方法、{4} 個 import；區塊外內容：{5}。\n", shape.characterCount, shape.codeFenceCount, shape.classCount, shape.testMethodCount, shape.importCount, shape.hasOutsideText ? localize("有") : localize("無")) : '')
        + localize("- 處理：拒絕本次修復，原測試未修改；已驗證執行基線：{0}。\n", detail.executableBaselineAvailable ? localize("已另存，繼續保留") : localize("尚未建立"))
        + (detail.elapsedMs === undefined ? '' : localize("- 本階段耗時：{0} ms。\n", detail.elapsedMs))
        + localize("- 後續修訂／降階／停止及候選雜湊見 role_events.jsonl；拒絕原因不代表模型修復後執行結果。\n");
}
