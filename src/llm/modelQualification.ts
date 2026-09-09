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

export type TestGenerationResponseFormat = 'test-code-json' | 'text';

/**
 * Use the exact response style that the selected model proved it can produce.
 * Semantic analysis still uses JSON independently; this applies only to
 * complete unittest/scaffold/repair code requests.
 */
export function selectTestGenerationResponseFormat(
    profile: Pick<ModelQualificationProfile, 'testGenerationReady' | 'testGenerationMode'>
): TestGenerationResponseFormat {
    return profile.testGenerationReady === true && profile.testGenerationMode === '純 Python unittest'
        ? 'text'
        : 'test-code-json';
}

function compactLogValue(value: string | undefined, fallback: string): string {
    const compact = value?.replace(/[\r\n]+/g, ' ').trim();
    return compact || fallback;
}

/**
 * Formats non-secret probe metadata for the user-visible system log. A bounded
 * reply preview is allowed only for the fixed, source-free connection fixture.
 */
export function formatModelQualificationLog(profile: ModelQualificationProfile, responsePreview?: string): string {
    const provider = profile.envType === 'cloud'
        ? 'Cloud Gemini'
        : profile.envType === 'custom'
            ? 'Custom API'
            : 'Local Ollama';
    const model = compactLogValue(profile.modelName, '未指定模型');
    const mode = compactLogValue(profile.testGenerationMode, 'unittest 生成探測');
    const reason = compactLogValue(profile.testGenerationReason, '未提供原因');

    const summary = profile.testGenerationReady === true
        ? `[模型資格] ${provider}／${model}：連線成功，已通過 ${mode}。`
        : `[模型資格] ${provider}／${model}：連線成功，但未通過 ${mode}（${reason}）。Auto 將保守使用 Tier 1。`;
    return profile.testGenerationReady !== true && responsePreview
        ? `${summary}\n[模型探測回應]\n${responsePreview}`
        : summary;
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
