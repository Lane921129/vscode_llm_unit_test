import { extractPythonTestCode, validateUnittestStructure } from '../validation/generatedTestValidator';

/** Provider-neutral result for the minimum safe unittest-generation contract. */
export type StructuredOutputCapability = 'verified' | 'unverified';

export interface StructuredOutputProbeResult {
    capability: StructuredOutputCapability;
    reason: string;
    /** Transient, capped preview of the fixed-fixture probe reply for UI diagnosis. */
    responsePreview?: string;
}

const MAX_PROBE_RESPONSE_PREVIEW_CHARS = 6_000;

/** The connection probe uses a fixed fixture, so a bounded reply preview is safe to show locally. */
export function formatProbeResponsePreview(response: string): string {
    const cleaned = response.replace(/\u0000/g, '');
    return cleaned.length <= MAX_PROBE_RESPONSE_PREVIEW_CHARS
        ? cleaned
        : `${cleaned.slice(0, MAX_PROBE_RESPONSE_PREVIEW_CHARS)}\n…（探測回應已截斷，共 ${cleaned.length} 字元）`;
}

export const STRUCTURED_OUTPUT_PROBE_PROMPT =
    'Return exactly one JSON object with a boolean field named "ok" set to true. Do not include any other text.';

export const STRUCTURED_OUTPUT_PROBE_SCHEMA = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok']
};

export const TEST_GENERATION_PROBE_PROMPT =
    'Return exactly one JSON object with a string field named "code". The code field must contain a complete Python unittest file: import unittest, include this fixture exactly as the function under test: def increment(value): return value + 1, define a unittest.TestCase class, and include BOTH self.assertEqual(increment(1), 2) and self.assertEqual(increment(-1), 0). Do not include Markdown or explanations.';

/** A compatibility probe for providers that can write tests but reject JSON mode. */
export const PLAIN_TEST_GENERATION_PROBE_PROMPT =
    'Return only one complete runnable Python unittest file. Include this fixture exactly as the function under test: def increment(value): return value + 1. Import unittest, define a unittest.TestCase class, and include BOTH self.assertEqual(increment(1), 2) and self.assertEqual(increment(-1), 0). Do not include explanations.';

export const TEST_GENERATION_PROBE_SCHEMA = {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code']
};

export function extractQualificationProbeCode(response: string): string {
    // Use the same evidence-gated fence extractor as generated test files.
    // Providers often add harmless prose around one otherwise valid Python fence.
    return extractPythonTestCode(response).trim();
}

/** Require both known probe cases, not merely one copied syntactic call. */
function hasProbeBehaviorAssertions(code: string): boolean {
    const hasCase = (input: string, expected: string) => {
        const escapedInput = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedExpected = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const forward = new RegExp('\\bself\\.assertEqual\\s*\\(\\s*increment\\s*\\(\\s*' + escapedInput + '\\s*\\)\\s*,\\s*' + escapedExpected + '\\s*\\)');
        const reverse = new RegExp('\\bself\\.assertEqual\\s*\\(\\s*' + escapedExpected + '\\s*,\\s*increment\\s*\\(\\s*' + escapedInput + '\\s*\\)\\s*\\)');
        return forward.test(code) || reverse.test(code);
    };
    return hasCase('1', '2') && hasCase('-1', '0');
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
    const responsePreview = formatProbeResponsePreview(response);
    const reject = (reason: string): StructuredOutputProbeResult => ({
        capability: 'unverified', reason, responsePreview
    });
    const code = extractQualificationProbeCode(response);
    const validation = validateUnittestStructure(code);
    if (!validation.valid) {
        return reject(validation.reason || '模型沒有產生有效的 unittest 結構。');
    }

    const definesFixture = /^\s*def\s+increment\s*\(\s*value\s*\)\s*:/m.test(code);
    const invokesFixture = code.split(/\r?\n/).some(line =>
        !/^\s*def\s+increment\s*\(/.test(line) && /\bincrement\s*\(/.test(line)
    );
    if (!definesFixture || !invokesFixture) {
        return reject('模型沒有產生可自我驗證的 increment 測試程式。');
    }
    if (!hasProbeBehaviorAssertions(code)) {
        return reject('模型未同時驗證已知行為 increment(1) == 2 與 increment(-1) == 0。');
    }
    return {
        capability: 'verified',
        reason: '模型已通過 unittest 結構、目標呼叫與雙案例行為 assertion 驗證。',
        responsePreview
    };
}
