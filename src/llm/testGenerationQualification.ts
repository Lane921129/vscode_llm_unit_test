import { localize } from '../i18n/core';
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
        : localize("{0}\n…（探測回應已截斷，共 {1} 字元）", cleaned.slice(0, MAX_PROBE_RESPONSE_PREVIEW_CHARS), cleaned.length);
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
    type ProbeValue = { kind: 'result' | 'expected'; value: 0 | 2 };
    const values = new Map<string, ProbeValue>();
    const matchedCases = new Set<string>();
    let methodIndent: number | undefined;
    const fixtureTerm = '(?:increment\\(\\s*(?:1|-1)\\s*\\)|[A-Za-z_]\\w*|[20])';
    const assertion = new RegExp(
        '^\\s*self\\.assertEqual\\s*\\(\\s*(' + fixtureTerm + ')\\s*,\\s*(' + fixtureTerm
        + ')(?:\\s*,\\s*' + PROBE_STRING_LITERAL + ')?\\s*\\)\\s*$'
    );
    const valueOf = (token: string): ProbeValue | undefined => {
        const normalized = token.replace(/\s+/g, '');
        if (normalized === 'increment(1)') {
            return { kind: 'result', value: 2 };
        }
        if (normalized === 'increment(-1)') {
            return { kind: 'result', value: 0 };
        }
        if (normalized === '2') {
            return { kind: 'expected', value: 2 };
        }
        if (normalized === '0') {
            return { kind: 'expected', value: 0 };
        }
        return values.get(normalized);
    };

    for (const line of code.split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) { continue; }
        const indentation = line.match(/^\s*/)?.[0].replace(/\t/g, '        ').length || 0;
        if (/^\s*(?:def|class)\s/.test(line) || (methodIndent !== undefined && indentation <= methodIndent)) {
            // Local result bindings cannot certify assertions in another method.
            values.clear();
            methodIndent = undefined;
        }
        if (/^\s+def test_[A-Za-z_]\w*\(self\)(?:\s*->\s*None)?:\s*$/.test(line)) {
            methodIndent = indentation;
            continue;
        }
        if (methodIndent === undefined) { continue; }
        const assignment = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*increment\s*\(\s*(-?1)\s*\)\s*$/);
        if (assignment) {
            values.set(assignment[1], { kind: 'result', value: assignment[2] === '1' ? 2 : 0 });
            continue;
        }
        const expectedAssignment = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*([20])\s*$/);
        if (expectedAssignment) {
            values.set(expectedAssignment[1], { kind: 'expected', value: expectedAssignment[2] === '2' ? 2 : 0 });
            continue;
        }
        const unknownAssignment = line.match(/^\s*([A-Za-z_]\w*)\s*=(?!=)/);
        if (unknownAssignment) { values.delete(unknownAssignment[1]); }
        const match = line.match(assertion);
        if (!match) {
            continue;
        }
        const actual = valueOf(match[1]);
        const expected = valueOf(match[2]);
        // Either assertEqual argument may hold the result, but two constants or
        // two target results never prove the required observed behavior.
        if (!actual || !expected || actual.kind === expected.kind || actual.value !== expected.value) { continue; }
        if (actual.value === 2) {
            matchedCases.add('positive');
        }
        if (actual.value === 0) {
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
        return { capability: 'unverified', reason: localize("模型沒有回傳 JSON 內容。") };
    }

    try {
        const parsed = JSON.parse(response) as unknown;
        if (
            parsed
            && typeof parsed === 'object'
            && !Array.isArray(parsed)
            && (parsed as { ok?: unknown }).ok === true
        ) {
            return { capability: 'verified', reason: localize("模型已通過結構化 JSON 輸出驗證。") };
        }
    } catch {
        // The caller only needs the safe fallback state below.
    }

    return { capability: 'unverified', reason: localize("模型未能依 JSON 格式回傳預期內容。") };
}

export function assessTestGenerationProbe(payload: unknown): StructuredOutputProbeResult {
    const response = payload && typeof payload === 'object'
        ? (payload as { response?: unknown }).response
        : undefined;
    if (typeof response !== 'string' || !response.trim()) {
        return { capability: 'unverified', reason: localize("模型沒有回傳測試程式碼。") };
    }
    const responsePreview = formatProbeResponsePreview(response);
    const reject = (reason: string): StructuredOutputProbeResult => ({
        capability: 'unverified', reason, responsePreview
    });
    const code = extractQualificationProbeCode(response);
    const validation = validateUnittestStructure(code);
    if (!validation.valid) {
        return reject(validation.reason || localize("模型沒有產生有效的 unittest 結構。"));
    }

    const invokesFixture = code.split(/\r?\n/).some(line =>
        !/^\s*def\s+increment\s*\(/.test(line) && /\bincrement\s*\(/.test(line)
    );
    if (!invokesFixture) {
        return reject(localize("模型沒有產生可驗證的 increment 目標呼叫。"));
    }
    if (!hasProbeBehaviorAssertions(code)) {
        return reject(localize("模型未同時驗證已知行為 increment(1) == 2 與 increment(-1) == 0。"));
    }
    return {
        capability: 'verified',
        reason: localize("模型已通過 unittest 結構、目標呼叫與雙案例行為 assertion 驗證。"),
        responsePreview
    };
}
