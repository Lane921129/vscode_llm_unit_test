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
    return '### 策略執行摘要\n\n'
        + `- 使用者選擇：${history.requested}；起始策略：Tier ${history.initial}。\n`
        + `- 曾自動降級：${history.transitions.length ? '是' : '否'}。`
        + (history.transitions.length ? history.transitions.map(item => `第 ${item.loop} 輪 Tier ${item.from} → ${item.to}（${item.reason}）`).join('；') : '') + '\n'
        + `- 各輪起始策略：${history.rounds.map(item => `第 ${item.loop} 輪 Tier ${item.start}`).join('；') || '尚未開始'}。\n`
        + `- 目前保留候選：${typeof retained === 'number' ? `Tier ${retained}` : '尚無已驗證候選'}。\n\n`;
}
