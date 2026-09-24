export interface OutcomeEvidence {
    terminalStatus?: unknown;
    failureCategory?: unknown;
    evidenceValid?: unknown;
    qualityAssessment?: { fullyPassed?: unknown };
}
export interface OutcomePresentation { state: string; label: string; kind: 'passed' | 'failed' | 'pending' | 'skipped' }

/** Scores and intermediate stage successes never certify the final outcome. */
export function presentOutcome(value: OutcomeEvidence): OutcomePresentation {
    const state = typeof value.terminalStatus === 'string' ? value.terminalStatus : 'incomplete';
    if (value.evidenceValid === false) { return { state, label: '未通過：來源已變更，舊證據失效', kind: 'failed' }; }
    if (value.failureCategory === 'environment') { return { state, label: '未通過：匯入／環境受阻', kind: 'failed' }; }
    if (state === 'passed' && value.qualityAssessment?.fullyPassed === true) {
        return { state, label: '完整通過', kind: 'passed' };
    }
    const labels: Record<string, [string, OutcomePresentation['kind']]> = {
        running: ['執行中，尚未判定', 'pending'],
        failed: ['未通過：執行或驗證失敗', 'failed'],
        'retained-after-failure': ['未通過：後續失敗，已保留先前測試', 'failed'],
        'execution-passed-review-incomplete': ['未完成：執行達標，審查未完成', 'pending'],
        'quality-incomplete': ['未通過：品質要求未完成', 'pending'],
        'round-limit': ['未通過：已達輪次上限', 'pending'],
        stagnated: ['未通過：連續多輪未改善', 'pending'],
        'no-mutation-candidates': ['未評分：沒有突變候選', 'skipped'],
        'dummy-skipped': ['已略過：Dummy，未計入通過', 'skipped'],
        'stub-smoke-generated': ['僅產生 Smoke Test，未計入通過', 'skipped'],
        'stub-skipped': ['已略過：無法建立測試初始化', 'skipped'],
        cancelled: ['已中止，未計入通過', 'pending'],
        'source-changed': ['未通過：來源已變更', 'failed']
    };
    const [label, kind] = labels[state] || ['未完成：缺少完整通過證據', 'pending'];
    return { state, label, kind };
}

export function withOutcomeHeader(body: string, evidence: OutcomeEvidence): string {
    const outcome = presentOutcome(evidence);
    return `## 最終結果：${outcome.label}\n\n`
        + '> 下方 passed／OK 僅描述個別階段或一次測試執行；覆蓋率與突變分數不是整體通過判定。\n\n'
        + body;
}

export function stageLabel(status: string): string {
    return status === 'passed' ? '此階段通過（非最終結果）' : status;
}
