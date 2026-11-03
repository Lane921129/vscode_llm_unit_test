/** Provider reasoning shares num_predict with the final code/JSON response. */
export type LocalThinkingMode = 'provider-default' | 'disabled';

export function localThinkingMode(value: unknown): LocalThinkingMode {
    return value === 'disabled' ? 'disabled' : 'provider-default';
}

export function localThinkingOptions(mode: LocalThinkingMode | undefined): { think?: false } {
    return mode === 'disabled' ? { think: false } : {};
}
