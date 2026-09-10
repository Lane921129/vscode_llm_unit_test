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
    'Return exactly one JSON object with a string field named "code". A safe runtime already provides increment(value), which returns value + 1; do not define or import increment. The code field must contain a complete Python unittest file: import unittest, define a unittest.TestCase class, and include BOTH self.assertEqual(increment(1), 2) and self.assertEqual(increment(-1), 0). Do not include Markdown or explanations.';

/** A compatibility probe for providers that can write tests but reject JSON mode. */
export const PLAIN_TEST_GENERATION_PROBE_PROMPT =
    'Return only one complete runnable Python unittest file. A safe runtime already provides increment(value), which returns value + 1; do not define or import increment. Import unittest, define a unittest.TestCase class, and include BOTH self.assertEqual(increment(1), 2) and self.assertEqual(increment(-1), 0). Do not include explanations.';

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

const PROBE_STRING_LITERAL = String.raw`(?:[rRuU]{0,2})?(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`;

/**
 * Require both known probe cases, while accepting the harmless `actual =
 * increment(...)` / `expected = ...` spelling used by many models. Only
 * exact fixture scalars are recognised; arbitrary expressions never become
 * qualification evidence.
 */
function hasProbeBehaviorAssertions(code: string): boolean {
    const values = new Map<string, number>();
    const matchedCases = new Set<string>();
    const fixtureTerm = '(?:increment\\(\\s*(?:1|-1)\\s*\\)|[A-Za-z_]\\w*|[20])';
    const assertion = new RegExp(
        '^\\s*self\\.assertEqual\\s*\\(\\s*(' + fixtureTerm + ')\\s*,\\s*(' + fixtureTerm
        + ')(?:\\s*,\\s*' + PROBE_STRING_LITERAL + ')?\\s*\\)\\s*$'
    );
    const valueOf = (token: string): number | undefined => {
        const normalized = token.replace(/\s+/g, '');
        if (normalized === 'increment(1)') {
            return 2;
        }
        if (normalized === 'increment(-1)') {
            return 0;
        }
        if (normalized === '2') {
            return 2;
        }
        if (normalized === '0') {
            return 0;
        }
        return values.get(normalized);
    };

    for (const line of code.split(/\r?\n/)) {
        const assignment = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*increment\s*\(\s*(-?1)\s*\)\s*$/);
        if (assignment) {
            values.set(assignment[1], assignment[2] === '1' ? 2 : 0);
            continue;
        }
        const expectedAssignment = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*([20])\s*$/);
        if (expectedAssignment) {
            values.set(expectedAssignment[1], Number(expectedAssignment[2]));
            continue;
        }
        const match = line.match(assertion);
        if (!match) {
            continue;
        }
        const actual = valueOf(match[1]);
        const expected = valueOf(match[2]);
        if (actual === 2 && expected === 2) {
            matchedCases.add('positive');
        }
        if (actual === 0 && expected === 0) {
            matchedCases.add('negative');
        }
    }
    return matchedCases.has('positive') && matchedCases.has('negative');
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

    const invokesFixture = code.split(/\r?\n/).some(line =>
        !/^\s*def\s+increment\s*\(/.test(line) && /\bincrement\s*\(/.test(line)
    );
    if (!invokesFixture) {
        return reject('模型沒有產生可驗證的 increment 目標呼叫。');
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
