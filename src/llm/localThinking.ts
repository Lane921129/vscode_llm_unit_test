/** Provider reasoning shares num_predict with the final code/JSON response. */
export type LocalThinkingMode = 'provider-default' | 'disabled';

export function localThinkingMode(value: unknown): LocalThinkingMode {
    return value === 'disabled' ? 'disabled' : 'provider-default';
}

/** gpt-oss ignores `think: false` and only accepts reasoning levels, so "disabled" asks for the
 * lowest level instead (2026-11-19 user decision after lab runs spent ~7,500 output tokens reasoning). */
const LEVEL_ONLY_THINKING = /^gpt-oss(?::|$)/i;

export function localThinkingOptions(mode: LocalThinkingMode | undefined, modelName?: string): { think?: false | 'low' } {
    if (mode !== 'disabled') { return {}; }
    return modelName && LEVEL_ONLY_THINKING.test(modelName.trim()) ? { think: 'low' } : { think: false };
}
