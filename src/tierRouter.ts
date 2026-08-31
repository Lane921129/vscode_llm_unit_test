/**
 * Select a generation strategy from model size, source complexity, user
 * preference, and the provider's measured unittest-generation capability.
 */
export function resolveTier(
    modelParamBillion: number,
    complexity: number,
    userTier: string,
    testGenerationReady?: boolean
): 1 | 2 | 3 | 4 {
    // A probe failure is a quality boundary, not merely an Auto preference.
    // Tier 1 remains usable because it derives assertions from verified trace
    // data instead of asking that model to author test code.
    if (testGenerationReady === false) {
        return 1;
    }
    if (userTier && userTier !== 'auto') {
        const requested = parseInt(userTier.replace('tier', ''));
        if (requested >= 1 && requested <= 4) {
            return requested as 1 | 2 | 3 | 4;
        }
    }
    if (isNaN(modelParamBillion)) {
        return 4;
    }
    if (modelParamBillion <= 4) {
        return 1;
    }
    if (modelParamBillion <= 20) {
        return complexity > 65 ? 1 : 2;
    }
    if (modelParamBillion <= 60) {
        return complexity <= 40 ? 2 : 3;
    }
    return complexity <= 60 ? 3 : 4;
}
