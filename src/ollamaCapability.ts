import { unwrapGeneratedCodeEnvelope, validateUnittestStructure } from './generatedTestValidator';

export type StructuredOutputCapability = 'verified' | 'unverified';

export interface StructuredOutputProbeResult {
    capability: StructuredOutputCapability;
    reason: string;
}

export const STRUCTURED_OUTPUT_PROBE_PROMPT =
    'Return exactly one JSON object with a boolean field named "ok" set to true. Do not include any other text.';

export const STRUCTURED_OUTPUT_PROBE_SCHEMA = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok']
};

export const TEST_GENERATION_PROBE_PROMPT =
    'Return exactly one JSON object with a string field named "code". The code field must contain a complete Python unittest file that imports unittest, defines a unittest.TestCase class, and tests this function: def increment(value): return value + 1. Do not include Markdown or explanations.';

export const TEST_GENERATION_PROBE_SCHEMA = {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code']
};

/**
 * A deliberately tiny, domain-neutral probe. It tests the exact JSON mode
 * needed by the semantic-analysis and generated-test envelopes without
 * asking the model to solve a project-specific problem.
 */
export function buildOllamaStructuredProbe(model: string) {
    return {
        model,
        prompt: STRUCTURED_OUTPUT_PROBE_PROMPT,
        stream: false,
        format: 'json',
        options: { temperature: 0 }
    };
}

/** A provider-neutral qualification probe for the minimum Tier 2-4 output shape. */
export function buildOllamaTestGenerationProbe(model: string) {
    return {
        model,
        prompt: TEST_GENERATION_PROBE_PROMPT,
        stream: false,
        format: 'json',
        options: { temperature: 0 }
    };
}

/** Validates the provider-neutral JSON response used by every connection probe. */
export function assessStructuredOutputProbe(payload: unknown): StructuredOutputProbeResult {
    const response = payload && typeof payload === 'object'
        ? (payload as { response?: unknown }).response
        : undefined;

    if (typeof response !== 'string' || !response.trim()) {
        return { capability: 'unverified', reason: '模型沒有回傳 JSON 內容。' };
    }

    try {
        const parsed = JSON.parse(response) as unknown;
        if (
            parsed
            && typeof parsed === 'object'
            && !Array.isArray(parsed)
            && (parsed as { ok?: unknown }).ok === true
        ) {
            return { capability: 'verified', reason: '模型已通過結構化 JSON 輸出驗證。' };
        }
    } catch {
        // The caller only needs the safe fallback state below.
    }

    return { capability: 'unverified', reason: '模型未能依 JSON 格式回傳預期內容。' };
}

export function assessTestGenerationProbe(payload: unknown): StructuredOutputProbeResult {
    const response = payload && typeof payload === 'object'
        ? (payload as { response?: unknown }).response
        : undefined;
    if (typeof response !== 'string' || !response.trim()) {
        return { capability: 'unverified', reason: '模型沒有回傳測試程式碼。' };
    }
    const code = unwrapGeneratedCodeEnvelope(response);
    const validation = validateUnittestStructure(code);
    return validation.valid
        ? { capability: 'verified', reason: '模型已通過 unittest 結構驗證。' }
        : { capability: 'unverified', reason: validation.reason || '模型沒有產生有效的 unittest 結構。' };
}
