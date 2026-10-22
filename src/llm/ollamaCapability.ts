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
import { fetchModelResponse } from './modelTransport';
import { QualificationRequestError, CONNECTION_PROBE_OUTPUT_TOKEN_LIMIT } from './connectionQualification';
import { AnalysisStageError } from '../utils/executionFailureCategory';

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
        options: { temperature: 0, num_ctx: numCtx, num_predict: CONNECTION_PROBE_OUTPUT_TOKEN_LIMIT }
    };
}

/** The original probe allowance covers both HTTP headers and the complete body. */
export async function requestOllamaQualification(baseUrl: string,
    body: ReturnType<typeof buildOllamaRoleQualificationProbe>,
    timeoutMs = MODEL_QUALIFICATION_TIMEOUT_MS,
    fetcher: FetchLike<Response> = (url, init) => fetch(url, init),
    signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new TypeError('Qualification timeout must be a bounded positive integer');
    }
    const controller = new AbortController();
    let response: Response | undefined;
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const stop = (reason: 'timeout' | 'cancelled') => {
        if (controller.signal.aborted) { return; }
        controller.abort();
        try { void response?.body?.cancel().catch(() => {}); } catch { /* A locked body must not delay cancellation. */ }
        rejectAbort(new QualificationRequestError(reason));
    };
    const cancel = () => stop('cancelled');
    const deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        if (signal?.aborted) { cancel(); }
        const operation = async () => {
            if (controller.signal.aborted) { return aborted; }
            response = await fetchModelResponse(baseUrl.replace(/\/+$/, '') + '/api/generate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: controller.signal
            }, { deadlineAt, fetcher: (input, init) => fetcher(String(input), init ?? {}) });
            if (controller.signal.aborted) {
                try { void response.body?.cancel().catch(() => {}); } catch { /* Preserve deadline outcome. */ }
                return aborted;
            }
            if (!response.ok) {
                try { void response.body?.cancel().catch(() => {}); } catch { /* The HTTP failure remains authoritative. */ }
                throw new QualificationRequestError('http', response.status);
            }
            const payload = await readOllamaGenerationResponse(response);
            if (controller.signal.aborted) { return aborted; }
            return { ...payload, response: getCompletedOllamaText(payload, body.options.num_predict) };
        };
        return await Promise.race([operation(), aborted]);
    } catch (error) {
        if (error instanceof QualificationRequestError) { throw error; }
        if (error instanceof AnalysisStageError) {
            const reason = (error.diagnostic as { reasonCode?: unknown } | undefined)?.reasonCode === 'output-token-limit'
                ? 'output-limit' : 'response-format';
            throw new QualificationRequestError(reason);
        }
        throw new QualificationRequestError('transport');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
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
