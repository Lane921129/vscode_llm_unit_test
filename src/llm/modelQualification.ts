import { createHash } from 'node:crypto';
import { RoleQualificationProfile } from './roleQualification';

/** Bump only when the executable probe contract changes, not for unrelated UI releases. */
export const QUALIFICATION_VERSION = 'python-unittest-v4';

export function qualificationEndpointKey(envType: string, endpoint?: string): string {
    const fallback = envType === 'local' ? 'http://127.0.0.1:11434' : envType === 'cloud'
        ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com/v1/chat/completions';
    try {
        const url = new URL(endpoint || fallback);
        // Never persist credentials, query parameters, or API keys with metadata.
        return createHash('sha256').update(url.origin + url.pathname.replace(/\/+$/, '')).digest('hex');
    } catch { return 'invalid-endpoint'; }
}

export interface ModelQualificationProfile {
    envType?: 'local' | 'cloud' | 'custom';
    modelName?: string;
    testGenerationReady?: boolean;
    /** Non-secret explanation captured from the deterministic connection probe. */
    testGenerationReason?: string;
    /** Structured JSON or plain-Python compatibility path that passed the probe. */
    testGenerationMode?: string;
    qualificationVersion?: string;
    endpointKey?: string;
    roleQualification?: RoleQualificationProfile;
}

export interface ModelQualificationRequest {
    envType: 'local' | 'cloud' | 'custom';
    modelName: string;
    endpointKey?: string;
}

export type TestGenerationResponseFormat = 'test-code-json' | 'text';
export type AnalysisResponseFormat = 'json' | 'text';

/**
 * Google exposes identical models both as `models/name` and `name`.
 * Capability identity must use the same provider-neutral spelling wherever a
 * saved probe is looked up or applied; otherwise a successful Cloud probe can
 * be found by the registry but rejected by the final qualification check.
 */
function normalizedModelName(modelName: string): string {
    return modelName.trim().replace(/^models\//i, '').toLowerCase();
}

/**
 * A complete unittest is source code, not a data record. Always request it as
 * ordinary Python so models do not have to escape a whole file inside JSON.
 * The local code extractor and execution gates remain the authority.
 */
export function selectTestGenerationResponseFormat(
    _profile: Pick<ModelQualificationProfile, 'testGenerationReady' | 'testGenerationMode'>
): TestGenerationResponseFormat {
    return 'text';
}

export const TEST_GEN_MODE_PYTHON = '純 Python unittest';
export const TEST_GEN_MODE_JSON = '結構化 JSON unittest';

/**
 * Analyzer and mutant-triage prompts still demand JSON text, but they do not
 * need a provider-level JSON mode.  A model that passed only the plain-Python
 * probe has already shown that its structured request contract is unsuitable,
 * so avoid the guaranteed failed request and let the schema parser validate
 * its ordinary-text reply instead.
 */
export function selectAnalysisResponseFormat(
    profile: Pick<ModelQualificationProfile, 'testGenerationReady' | 'testGenerationMode'>
): AnalysisResponseFormat {
    const isPythonOnly = profile.testGenerationMode === TEST_GEN_MODE_PYTHON
        || profile.testGenerationMode === 'plain-python'
        || profile.testGenerationMode === 'python';
    return profile.testGenerationReady === true && isPythonOnly
        ? 'text'
        : 'json';
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

    if (profile.testGenerationReady !== undefined && profile.qualificationVersion !== QUALIFICATION_VERSION) {
        return `[模型資格] ${provider}／${model}：舊探針結果已過期（原紀錄：${mode}）；請重新執行測試連線。正式測試生成使用純 Python。`;
    }

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
    if (profile.qualificationVersion !== QUALIFICATION_VERSION) { return false; }
    const profileEndpoint = profile.endpointKey || qualificationEndpointKey(profile.envType || request.envType);
    const requestEndpoint = request.endpointKey || qualificationEndpointKey(request.envType);
    if (profileEndpoint !== requestEndpoint) { return false; }
    if (!profile.envType || !profile.modelName) {
        // Preserve compatibility with pre-qualification profiles.
        return profile.testGenerationReady;
    }
    return profile.envType === request.envType
        && normalizedModelName(profile.modelName) === normalizedModelName(request.modelName)
        ? profile.testGenerationReady
        : false;
}
