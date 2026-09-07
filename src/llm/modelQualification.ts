export interface ModelQualificationProfile {
    envType?: 'local' | 'cloud' | 'custom';
    modelName?: string;
    testGenerationReady?: boolean;
    /** Non-secret explanation captured from the deterministic connection probe. */
    testGenerationReason?: string;
    /** Structured JSON or plain-Python compatibility path that passed the probe. */
    testGenerationMode?: string;
}

export interface ModelQualificationRequest {
    envType: 'local' | 'cloud' | 'custom';
    modelName: string;
}

/**
 * A probe result only applies to the exact provider/model pair that produced
 * it. A different selected model must be treated as unqualified until it has
 * completed its own probe, rather than inheriting a previous model's result.
 */
export function qualificationForRequest(
    profile: ModelQualificationProfile,
    request: ModelQualificationRequest
): boolean | undefined {
    if (profile.testGenerationReady === undefined) {
        return undefined;
    }
    if (!profile.envType || !profile.modelName) {
        // Preserve compatibility with pre-qualification profiles.
        return profile.testGenerationReady;
    }
    return profile.envType === request.envType && profile.modelName === request.modelName
        ? profile.testGenerationReady
        : false;
}
