import { localize } from '../i18n/core';
import { isPromptCapacityDiagnostic } from '../prompts/promptCapacity';

/** Estimates explain a single prompt's gate; they never certify later roles or runtime allocation. */
export function formatPromptCapacity(detail: unknown, failure = false): string | undefined {
    if (!isPromptCapacityDiagnostic(detail)) { return undefined; }
    const value = detail;
    const unknown = localize('未知');
    const summary = localize('角色容量估算：{0}；num_ctx {1}，模型上限 {2}（{3}）；完整輸入 {4} + 補正預留 {5}，可用輸入 {6}，輸出預留 {7}；此角色提示至少需要 {8} tokens。',
        value.role, value.contextWindow, value.modelContextLimit ?? unknown, value.modelContextLimitSource,
        value.estimatedInputTokens, value.reservedInputTokens, value.inputBudget, value.reservedOutputTokens,
        value.minimumContextTokens ?? unknown);
    const limit = value.modelContextLimit === null ? '' : ' ' + localize('在模型上限下可用輸入 {0}、輸出預留 {1}，輸入仍差 {2} tokens。',
        value.limitInputBudget ?? unknown, value.limitReservedOutputTokens ?? unknown, value.limitInputShortfallTokens ?? unknown);
    const meaning = localize('這是目前角色完整提示的保守估算，不是實測 token 數、後續角色或品質通過保證。');
    const observed = value.observedInputTokens === null ? '' : ' ' + localize('同一完整請求已觀測輸入 {0}，本次按較大值 {1} 保留。',
        value.observedInputTokens, value.effectiveInputTokens);
    if (!failure || value.state === 'fits-current') { return `${summary}${limit}${observed} ${meaning}`; }
    const action = value.state === 'model-limit-insufficient'
        ? localize('已核實上限仍不足，未送出生成請求；增加等待時間無法增加 Context。請精簡重複指令或使用容量足夠的模型。')
        : value.state === 'model-limit-unknown'
            ? localize('模型上限未知，未送出生成請求；請先重新取得該模型的容量資訊，不能以未知上限授權增容。')
            : localize('目前選用容量不足，未送出生成請求；可在已核實上限內調整容量並重新驗證角色。');
    return `${summary}${limit}${observed} ${action} ${meaning}`;
}
