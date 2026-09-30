import { localize } from '../i18n/core';
export interface TierTransition { loop: number; from: number; to: number; reason: string }
export interface TierHistory {
    requested: string;
    initial: number;
    rounds: Array<{ loop: number; start: number }>;
    transitions: TierTransition[];
}

/** Initial routing and retained candidate identity describe different moments. */
export function formatTierHistory(state: Record<string, unknown>): string {
    const history = state.tierHistory as TierHistory | undefined;
    if (!history) { return ''; }
    const executable = state.executableBaseline as { tier?: number } | undefined;
    const retained = state.acceptedTest ? state.resolvedTier : executable?.tier;
    return localize("### 策略執行摘要\n\n")
        + localize("- 使用者選擇：{0}；起始策略：Tier {1}。\n", history.requested, history.initial)
        + localize("- 曾自動降級：{0}。", history.transitions.length ? localize("是") : localize("否"))
        + (history.transitions.length ? history.transitions.map(item => localize("第 {0} 輪 Tier {1} → {2}（{3}）", item.loop, item.from, item.to, item.reason)).join('；') : '') + '\n'
        + localize("- 各輪起始策略：{0}。\n", history.rounds.map(item => localize("第 {0} 輪 Tier {1}", item.loop, item.start)).join('；') || localize("尚未開始"))
        + localize("- 目前保留候選：{0}。\n\n", typeof retained === 'number' ? `Tier ${retained}` : localize("尚無已驗證候選"));
}
