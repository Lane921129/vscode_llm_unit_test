export type PromptDetail = 'small' | 'large';

/**
 * Choose prompt detail only from measured capability metadata and resolved
 * work tier. Provider/model names are intentionally not inputs: an unknown
 * future model must not receive a weaker prompt merely because its name does
 * not match a historical vendor list.
 */
export function selectPromptDetail(
    paramSize: string,
    contextLength: number,
    resolvedTier: 1 | 2 | 3 | 4
): PromptDetail {
    if (resolvedTier >= 3) {
        return 'large';
    }
    const parameters = Number.parseFloat(paramSize);
    if (Number.isFinite(parameters) && parameters >= 20) {
        return 'large';
    }
    return contextLength >= 16_000 ? 'large' : 'small';
}
