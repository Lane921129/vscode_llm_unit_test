import { localize } from '../i18n/core';
export interface OutcomeEvidence {
    terminalStatus?: unknown;
    failureCategory?: unknown;
    evidenceValid?: unknown;
    qualityAssessment?: { fullyPassed?: unknown; toolsSatisfied?: unknown };
    validationMode?: unknown;
    executionVerified?: unknown;
    workflowVersion?: unknown;
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
        'review-blocked': [localize("未通過：最新候選審查未批准"), 'pending'],
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

/** Retain the historical demo display without applying it to the AI review gate. */
export function presentSummaryOutcome(value: OutcomeEvidence): OutcomePresentation {
    const outcome = presentOutcome(value);
    if (value.workflowVersion !== 'ai-reviewed-loop-v1'
        && outcome.state === 'execution-passed-review-incomplete' && outcome.kind === 'pending') {
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
    const value = detail as { reason?: unknown; diagnostics?: unknown; role?: unknown; focus?: unknown; globalProgress?: unknown } | undefined;
    if (stage === 'quality-experiment' && value?.focus) {
        if (status === 'resolved') { return localize('實測確認指定品質缺口已解決；整體品質仍須另外判定'); }
        if (status === 'unavailable') { return localize('指定品質缺口缺少可比較量測，不能判定已解決'); }
        if (status === 'unchanged') {
            return localize('指定補測缺口尚未解決；保留觀測交 AI 修訂')
                + (value.globalProgress === 'improved' ? localize('；其他量測有改善，但未算此缺口已解決') : '');
        }
    }
    const reason = typeof value?.reason === 'string' ? value.reason.replace(/[\r\n]+/g, ' ').slice(0, 400) : '';
    const diagnostics = Array.isArray(value?.diagnostics)
        ? value.diagnostics.filter(item => typeof item === 'string' && /^[a-z0-9-]+$/.test(item)).join(', ') : '';
    const labels: Record<string, string> = {
        'mutation-engine:selected': localize("已選定突變引擎，等待量測"),
        'mutation-engine:failed': localize("突變引擎預檢失敗：{0}；已停止，未更換引擎", reason || localize("請查看報告中的拒絕原因")),
        'mutation:started': localize("正在隔離執行突變；完成後才能判定分數"),
        'numeric-skill:planned': localize("正在以數值計算技能核對失敗測資"),
        'numeric-skill:verified': localize("計算與同輸入隔離觀測一致；證據交 AI 修訂，工具不改寫測試"),
        'numeric-skill:unverified': localize("計算缺少一致的同輸入觀測；保留原測資與修復流程"),
        'numeric-skill:unsupported': localize("此案例超出數值技能支援範圍；保留原修復流程"),
        'numeric-skill:unavailable': localize("數值技能未完成；保留原修復流程"),
        'writer-seed:started': localize("先獨立執行模型的最小測試；工具不附加測試"),
        'writer-seed:accepted': localize("模型測試已獨立通過並保存；等待 Reviewer 審查批准"),
        'quality-experiment:observed': localize("已取得補測觀測；交 AI 撰寫測試，再執行與審查"),
        'quality-experiment-baseline:passed': localize("工具案例已獨立通過；此紀錄不代表 AI 測試已獲批准"),
        'quality-evidence:writer-required': localize("觀測已備妥；由 Writer 補寫測試，工具不合併測試"),
        'quality-experiment:improved': localize("實測確認品質缺口減少"),
        'quality-experiment:unchanged': localize('指定補測缺口尚未解決；保留觀測交 AI 修訂'),
        'quality-experiment:resolved': localize('實測確認指定品質缺口已解決；整體品質仍須另外判定'),
        'quality-experiment:unavailable': localize('指定品質缺口缺少可比較量測，不能判定已解決'),
        'quality-experiment:deferred': localize('指定補測缺口尚未解決；若有其他實測缺口則優先處理，突變分母不變'),
        'passing-tests:preservation-rejected': localize('修訂未通過既有案例保護檢查；已拒絕修訂，保留原測試'),
        'quality-novelty:duplicate': localize("沒有新的測試情境；停止重複量測並保留基線"),
        'reviewer:repair-requested': localize("審查契約無效；在原時限內僅要求一次修正"),
        'reviewer:approved': localize("Reviewer 已批准此版測試；可進入突變量測，尚非完整通過"),
        'reviewer:rejected': localize("Reviewer 提出待處理問題；交 Writer 修訂後重新執行與審查"),
        'candidate-artifact:rejected': localize("已記錄拒絕原因；可保存的測試候選附於失敗報告"),
        'structure:passed': localize("測試結構、目標呼叫與斷言證據檢查通過；尚未判定完整品質"),
        'structure:rejected': localize("測試候選未通過檢查：{0}；交 Writer 修訂，修訂額度用盡則停止本候選", reason || localize("請查看報告中的拒絕原因")),
        'scenarios:observed': localize("已記錄本次實際執行的測試情境"),
        'coverage:measured': localize("已取得覆蓋率量測；是否達標另行判定"),
        'validation:passed': mode === 'execution' ? localize("本次隔離測試執行通過；本模式不執行品質審查與突變")
            : localize("本次隔離測試執行通過；審查與突變品質尚須判定"),
        'validation:accepted': mode === 'execution' ? localize("保留可執行候選；本模式不執行突變，不代表完整品質通過")
            : localize("保留可執行候選；須取得此版審查批准才可量測突變，不代表完整通過"),
        'executable-baseline:checkpointed': localize("已保存可執行測試及目前審查狀態；突變可能尚未量測"),
        'executable-baseline:restored': localize('已恢復保留測資與執行證據；後續修訂沿用此基線，未產生新量測'),
        'model-request:requested': localize("已送出模型請求"),
        'model-request:completed': localize("模型已回覆；內容仍須驗證"),
        'reviewer:invalid-response': localize("審查回覆未通過契約檢查{0}；不採用該建議", diagnostics ? `（${diagnostics}）` : ''),
        'reviewer:unavailable': localize("審查未完成；保留已通過執行的測試，本候選不進入突變"),
        'reviewer:suspended': localize("連續審查失敗，停止額外請求；審查仍標為未完成")
    };
    return labels[`${stage}:${status}`] || stageLabel(status);
}
