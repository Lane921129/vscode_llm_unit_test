import {
    PLAIN_TEST_GENERATION_PROBE_PROMPT,
    STRUCTURED_OUTPUT_PROBE_PROMPT,
    TEST_GENERATION_PROBE_PROMPT
} from './testGenerationQualification';
import { buildOllamaPromptEnvelope } from './ollamaPrompt';
import { addOutputContract, responseSchemaForOutputFormat } from './customApi';

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
        stream: false,
        ...(format === 'json' ? { format: 'json' } : format === 'review-json' ? { format: responseSchemaForOutputFormat(format) } : {}),
        options: { temperature: 0, num_ctx: numCtx, ...(format === 'review-json' ? { num_predict: 1024 } : {}) }
    };
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
