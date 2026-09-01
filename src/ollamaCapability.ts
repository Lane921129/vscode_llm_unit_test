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
    'Return exactly one JSON object with a string field named "code". The code field must contain a complete Python unittest file: import unittest, include this fixture exactly as the function under test: def increment(value): return value + 1, define a unittest.TestCase class, and include BOTH self.assertEqual(increment(1), 2) and self.assertEqual(increment(-1), 0). Do not include Markdown or explanations.';

/** A compatibility probe for models that can write tests but do not support JSON mode. */
export const PLAIN_TEST_GENERATION_PROBE_PROMPT =
    'Return only one complete runnable Python unittest file. Include this fixture exactly as the function under test: def increment(value): return value + 1. Import unittest, define a unittest.TestCase class, and include BOTH self.assertEqual(increment(1), 2) and self.assertEqual(increment(-1), 0). Do not include explanations.';

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

/** Probe plain Python output without sending an Ollama JSON-format constraint. */
export function buildOllamaPlainTestGenerationProbe(model: string) {
    return {
        model,
        prompt: PLAIN_TEST_GENERATION_PROBE_PROMPT,
        stream: false,
        options: { temperature: 0 }
    };
}

function extractProbeCode(response: string): string {
    const unwrapped = unwrapGeneratedCodeEnvelope(response).trim();
    const fenced = unwrapped.match(/^```(?:python)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i);
    return (fenced ? fenced[1] : unwrapped).trim();
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
    const code = extractProbeCode(response);
    const validation = validateUnittestStructure(code);
    if (!validation.valid) {
        return { capability: 'unverified', reason: validation.reason || '模型沒有產生有效的 unittest 結構。' };
    }

    const definesFixture = /^\s*def\s+increment\s*\(\s*value\s*\)\s*:/m.test(code);
    const invokesFixture = code.split(/\r?\n/).some(line =>
        !/^\s*def\s+increment\s*\(/.test(line) && /\bincrement\s*\(/.test(line)
    );
    if (!definesFixture || !invokesFixture) {
        return {
            capability: 'unverified',
            reason: '模型沒有產生可自我驗證的 increment 測試程式。'
        };
    }
    if (!hasProbeBehaviorAssertions(code)) {
        return {
            capability: 'unverified',
            reason: '模型未同時驗證已知行為 increment(1) == 2 與 increment(-1) == 0。'
        };
    }
    return { capability: 'verified', reason: '模型已通過 unittest 結構、目標呼叫與雙案例行為 assertion 驗證。' };
}
