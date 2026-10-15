import {
    PLAIN_TEST_GENERATION_PROBE_PROMPT,
    STRUCTURED_OUTPUT_PROBE_PROMPT,
    TEST_GENERATION_PROBE_PROMPT
} from './testGenerationQualification';
import { buildOllamaPromptEnvelope } from './ollamaPrompt';
import { addOutputContract, responseSchemaForOutputFormat } from './customApi';
import { readOllamaGenerationResponse } from './ollamaGenerationResponse';
import { getCompletedOllamaText } from './ollamaResponse';
import { MODEL_QUALIFICATION_TIMEOUT_MS, type FetchLike } from './connectionTimeout';

/** All connection roles must use the same validated local runtime setting. */
export function buildOllamaRoleQualificationProbe(model: string, prompt: string, format: 'json' | 'review-json' | 'text', numCtx: number): {
    model: string; system: string; prompt: string; stream: boolean;
    format?: string | Record<string, unknown>;
    options: { temperature: number; num_ctx: number; num_predict?: number };
} {
    if (!Number.isSafeInteger(numCtx) || numCtx <= 0) { throw new Error('invalid-runtime-context'); }
    return {
        model,
        ...buildOllamaPromptEnvelope(format === 'review-json' ? addOutputContract('', format) : '', prompt),
        stream: true,
        ...(format === 'json' ? { format: 'json' } : format === 'review-json' ? { format: responseSchemaForOutputFormat(format) } : {}),
        options: { temperature: 0, num_ctx: numCtx, ...(format === 'review-json' ? { num_predict: 1024 } : {}) }
    };
}

/** The original probe allowance covers both HTTP headers and the complete body. */
export async function requestOllamaQualification(baseUrl: string,
    body: ReturnType<typeof buildOllamaRoleQualificationProbe>,
    timeoutMs = MODEL_QUALIFICATION_TIMEOUT_MS,
    fetcher: FetchLike<Response> = (url, init) => fetch(url, init)): Promise<Record<string, unknown> | undefined> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new TypeError('Qualification timeout must be a bounded positive integer');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetcher(baseUrl.replace(/\/+$/, '') + '/api/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal
        });
        if (!response.ok) {
            try { void response.body?.cancel().catch(() => {}); } catch { /* The HTTP failure remains authoritative. */ }
            return undefined;
        }
        const payload = await readOllamaGenerationResponse(response);
        if (controller.signal.aborted) { throw new DOMException('Qualification deadline expired', 'AbortError'); }
        return { ...payload, response: getCompletedOllamaText(payload, body.options.num_predict) };
    } finally { clearTimeout(timer); }
}

/** Build Ollama-specific JSON-mode probes from the shared qualification contract. */
export function buildOllamaStructuredProbe(model: string, numCtx: number) {
    return buildOllamaRoleQualificationProbe(model, STRUCTURED_OUTPUT_PROBE_PROMPT, 'json', numCtx);
}

export function buildOllamaTestGenerationProbe(model: string, numCtx: number) {
    return buildOllamaRoleQualificationProbe(model, TEST_GENERATION_PROBE_PROMPT, 'json', numCtx);
}

/** Probe plain Python output without sending an Ollama JSON-format constraint. */
export function buildOllamaPlainTestGenerationProbe(model: string, numCtx: number) {
    return buildOllamaRoleQualificationProbe(model, PLAIN_TEST_GENERATION_PROBE_PROMPT, 'text', numCtx);
}
