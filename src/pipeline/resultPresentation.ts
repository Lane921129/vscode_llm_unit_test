import { localize } from '../i18n/core';
export interface OutcomeEvidence {
    terminalStatus?: unknown;
    failureCategory?: unknown;
    evidenceValid?: unknown;
    qualityAssessment?: { fullyPassed?: unknown; toolsSatisfied?: unknown };
    validationMode?: unknown;
    executionVerified?: unknown;
}
export interface OutcomePresentation { state: string; label: string; kind: 'passed' | 'executed' | 'failed' | 'pending' | 'skipped' }

/** Scores and intermediate stage successes never certify the final outcome. */
export function presentOutcome(value: OutcomeEvidence): OutcomePresentation {
    const state = typeof value.terminalStatus === 'string' ? value.terminalStatus : 'incomplete';
    if (value.evidenceValid === false) { return { state, label: localize("未通過：來源已變更，舊證據失效"), kind: 'failed' }; }
    if (value.failureCategory === 'environment') { return { state, label: localize("未通過：匯入／環境受阻"), kind: 'failed' }; }
    if (state === 'passed' && value.validationMode !== 'execution' && value.qualityAssessment?.fullyPassed === true) {
        return { state, label: localize("完整通過"), kind: 'passed' };
    }
    if (state === 'execution-passed' && value.validationMode === 'execution' && value.executionVerified === true) {
        return { state, label: localize("執行驗證通過；未執行突變，完整品質尚未驗證"), kind: 'executed' };
    }
    const labels: Record<string, [string, OutcomePresentation['kind']]> = {
        running: [localize("執行中，尚未判定"), 'pending'],
        failed: [localize("未通過：執行或驗證失敗"), 'failed'],
        'retained-after-failure': [localize("未通過：後續失敗，已保留先前測試"), 'failed'],
        'execution-passed-review-incomplete': [localize("未完成：執行達標，審查未完成"), 'pending'],
        'quality-incomplete': [localize("未通過：品質要求未完成"), 'pending'],
        'round-limit': [localize("未通過：已達輪次上限"), 'pending'],
        stagnated: [localize("未通過：連續多輪未改善"), 'pending'],
        'no-mutation-candidates': [localize("未評分：沒有突變候選"), 'skipped'],
        'dummy-skipped': [localize("已略過：Dummy，未計入通過"), 'skipped'],
        'stub-smoke-generated': [localize("僅產生 Smoke Test，未計入通過"), 'skipped'],
        'stub-skipped': [localize("已略過：無法建立測試初始化"), 'skipped'],
        cancelled: [localize("已中止，未計入通過"), 'pending'],
        'source-changed': [localize("未通過：來源已變更"), 'failed']
    };
    const [label, kind] = labels[state] || [localize("未完成：缺少完整通過證據"), 'pending'];
    return { state, label, kind };
}

/** Concise demo surface. Audit status and pass accounting remain unchanged. */
export function presentSummaryOutcome(value: OutcomeEvidence): OutcomePresentation {
    const outcome = presentOutcome(value);
    if (outcome.state === 'execution-passed-review-incomplete' && outcome.kind === 'pending') {
        return { ...outcome, label: value.validationMode !== 'execution' && value.qualityAssessment?.toolsSatisfied === true
            ? localize("測試執行與量測達標") : localize("未完成：缺少完整通過證據") };
    }
    return outcome;
}

export function withOutcomeHeader(body: string, evidence: OutcomeEvidence): string {
    const outcome = presentOutcome(evidence);
    return localize("## 最終結果：{0}\n\n", outcome.label)
        + (evidence.validationMode === 'execution'
            ? localize("> **突變測試未執行：本次選擇「僅執行驗證」。** 需要突變測試時，請將「驗證目標」切換成「完整品質驗證（含突變）」並重新執行；不能把本次結果直接改標為完整通過。\n\n") : '')
        + localize("> 下方 passed／OK 僅描述個別階段或一次測試執行；覆蓋率與突變分數不是整體通過判定。\n\n")
        + body;
}

export function stageLabel(status: string): string {
    return status === 'passed' ? localize("此階段通過（非最終結果）") : status;
}

/** Human progress messages never turn intermediate acceptance into certification. */
export function describeStageEvent(stage: string, status: string, detail: unknown, mode: 'full' | 'execution' = 'full'): string {
    const value = detail as { reason?: unknown; diagnostics?: unknown; role?: unknown } | undefined;
    const reason = typeof value?.reason === 'string' ? value.reason.replace(/[\r\n]+/g, ' ').slice(0, 400) : '';
    const diagnostics = Array.isArray(value?.diagnostics)
        ? value.diagnostics.filter(item => typeof item === 'string' && /^[a-z0-9-]+$/.test(item)).join(', ') : '';
    const labels: Record<string, string> = {
        'mutation-engine:selected': localize("已選定突變引擎，等待量測"),
        'mutation-engine:failed': localize("突變引擎預檢失敗：{0}；已停止，未更換引擎", reason || localize("請查看報告中的拒絕原因")),
        'mutation:started': localize("正在隔離執行突變；完成後才能判定分數"),
        'numeric-skill:planned': localize("正在以數值計算技能核對失敗測資"),
        'numeric-skill:verified': localize("計算與同輸入隔離觀測一致；修正候選仍須重新執行、審查與突變驗證"),
        'numeric-skill:unverified': localize("計算缺少一致的同輸入觀測；保留原測資與修復流程"),
        'numeric-skill:unsupported': localize("此案例超出數值技能支援範圍；保留原修復流程"),
        'numeric-skill:unavailable': localize("數值技能未完成；保留原修復流程"),
        'structure:passed': localize("測試結構、目標呼叫與斷言證據檢查通過；尚未判定完整品質"),
        'structure:rejected': localize("測試候選未通過檢查：{0}；交 Writer 修訂，修訂額度用盡則停止本候選", reason || localize("請查看報告中的拒絕原因")),
        'scenarios:observed': localize("已記錄本次實際執行的測試情境"),
        'coverage:measured': localize("已取得覆蓋率量測；是否達標另行判定"),
        'validation:passed': mode === 'execution' ? localize("本次隔離測試執行通過；本模式不執行品質審查與突變")
            : localize("本次隔離測試執行通過；審查與突變品質尚須判定"),
        'validation:accepted': mode === 'execution' ? localize("保留可執行候選；本模式不執行突變，不代表完整品質通過")
            : localize("保留可執行候選，繼續量測突變；不代表完整通過"),
        'executable-baseline:checkpointed': localize("已保存可執行測試及目前審查狀態；突變可能尚未量測"),
        'model-request:requested': localize("已送出模型請求"),
        'model-request:completed': localize("模型已回覆；內容仍須驗證"),
        'reviewer:invalid-response': localize("審查回覆未通過契約檢查{0}；不採用該建議", diagnostics ? `（${diagnostics}）` : ''),
        'reviewer:unavailable': localize("審查未完成；保留已通過執行的測試並繼續工具量測"),
        'reviewer:suspended': localize("連續審查失敗，停止額外請求；審查仍標為未完成")
    };
    return labels[`${stage}:${status}`] || stageLabel(status);
}
