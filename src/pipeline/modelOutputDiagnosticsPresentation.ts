import { localize } from '../i18n/core';
import { readOutputShapeDiagnostic } from '../llm/ollamaResponse';
import { diagnoseModelOutput, readModelOutputPreview } from '../llm/modelOutputDiagnostics';

const roles = ['writer', 'writer-revision', 'reviewer', 'bug-fixer', 'analyst-planning', 'analyst-quality'];
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const display = (value: unknown) => numeric(value) === undefined ? localize('未知') : String(value);
const seconds = (value: unknown) => numeric(value) === undefined ? localize('未知') : (Number(value) / 1000).toFixed(3);

/** The caller has already bound events to one run/source and optional loop.
 * Only known fields are rendered; excerpts remain non-executable diagnostics. */
export function renderModelOutputDiagnostics(events: readonly any[]): string {
    const transport = new Map<string, any>();
    const sections: string[] = [];
    for (const event of events) {
        if (event?.stage !== 'model-request' || !roles.includes(event?.detail?.role)) { continue; }
        const d = event.detail, role: string = d.role;
        if (event.status === 'requested') { transport.delete(role); }
        if (event.status === 'timing' && d.kind === 'transport') { transport.set(role, d); }
        if (event.status !== 'error' || d.reasonCode !== 'output-token-limit') { continue; }
        const shape = readOutputShapeDiagnostic(d.responseShape);
        const timing = transport.get(role);
        const diagnosis = diagnoseModelOutput(shape);
        const explanation = diagnosis === 'repetitive-without-tests'
            ? localize('回覆高度重複，沒有可辨識的測試方法或斷言；提高輸出額度未必能改善。')
            : diagnosis === 'repetitive-test-shells'
                ? localize('回覆高度重複，多次出現測試方法與程式區塊外框，但沒有可辨識的 unittest 斷言；不能將外框數量當成有效生成進度。')
            : diagnosis === 'test-structure-present'
                ? localize('回覆已有可辨識的測試結構，但尚未完整結束，不能採用前綴。')
                : diagnosis === 'no-test-structure'
                    ? localize('回覆未顯示可辨識的測試結構；僅憑紀錄無法判定其具體內容。')
                    : localize('輸出樣本或結構證據不足，無法判定是否重複。');
        const later = events.find(candidate => candidate?.stage === 'model-request'
            && candidate?.detail?.role === role && numeric(candidate.sequence) !== undefined
            && Number(candidate.sequence) > Number(event.sequence)
            && ['output-format-retry', 'output-budget-grown', 'output-recovery-blocked', 'requested', 'error'].includes(candidate.status));
        const recovery = later?.status === 'output-format-retry'
            ? later.detail?.writerPromptMode === 'seed-code-completion-v1'
                ? localize('一次程式碼續寫恢復；工具只提供包裝，測試內容由模型撰寫')
                : localize('一次格式修正；未重用截斷內容')
            : later?.status === 'output-budget-grown' ? localize('提高輸出額度後重送')
                : later?.status === 'output-recovery-blocked' ? localize('剩餘時間或容量不足，未重送')
                    : localize('未安排進一步恢復；本次候選未完成');
        const preview = readModelOutputPreview(d.responsePreview);
        sections.push(localize('#### 輸出失敗事件 {0}：{1}', display(event.sequence), role), '', explanation, '',
            localize('| 項目 | 本次紀錄 |'), '| --- | --- |',
            `| ${localize('完成原因')} | length / output-token-limit |`,
            `| Context | ${display(d.contextWindow)} |`,
            `| ${localize('實測輸入 tokens')} | ${display(timing?.ollama?.promptEvalCount)} |`,
            `| num_predict / ${localize('實際輸出 tokens')} | ${display(d.outputTokenLimit)} / ${display(timing?.ollama?.evalCount)} |`,
            `| HTTP | ${numeric(timing?.httpStatus) !== undefined && timing.httpStatus <= 599 ? timing.httpStatus : localize('未知')} |`,
            `| ${localize('請求／載入／推論耗時（秒）')} | ${seconds(timing?.elapsedMs)} / ${seconds(timing?.ollama?.loadDurationMs)} / ${seconds(timing?.ollama?.evalDurationMs)} |`,
            `| ${localize('輸出字元／非空行／重複行')} | ${display(shape?.responseCharacters)} / ${display(shape?.nonemptyLines)} / ${display(shape?.repeatedLines)} |`,
            `| ${localize('可辨識測試方法／斷言／Python fence')} | ${display(shape?.testMethods)} / ${display(shape?.assertionCalls)} / ${display(shape?.pythonFences)} |`,
            `| ${localize('樣本完整／回覆 SHA-256')} | ${shape ? String(shape.sampleComplete) : localize('未知')} / ${shape?.responseHash || localize('未知')} |`,
            `| ${localize('恢復決策')} | ${recovery} |`, '',
            localize('文字統計不是 AST 驗證；以下節錄僅供診斷，不是完整回覆或可執行測試。'), '');
        if (!preview) {
            sections.push(localize('此紀錄未保存可核對的輸出節錄；無法由雜湊或統計還原原文。'), '');
        } else {
            for (const sample of preview.samples) {
                const fence = '`'.repeat(Math.max(3, ...[...sample.text.matchAll(/`+/g)].map(match => match[0].length + 1)));
                sections.push(localize('第 {0} 行；樣本內出現 {1} 次；原行 {2} 字元。', sample.line, sample.repetitions, sample.characters), '',
                    fence + 'text', sample.text, fence, '');
            }
            sections.push(localize('節錄最多六種非空行；已隱藏疑似憑證、位置及來源重述，固定框架指令可保留。'), '');
        }
    }
    return sections.length ? [localize('### 模型輸出失敗診斷'), '', ...sections].join('\n') : '';
}
