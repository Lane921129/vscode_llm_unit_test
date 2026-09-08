import {
    PLAIN_TEST_GENERATION_PROBE_PROMPT,
    STRUCTURED_OUTPUT_PROBE_PROMPT,
    TEST_GENERATION_PROBE_PROMPT
} from './testGenerationQualification';

/** Build Ollama-specific JSON-mode probes from the shared qualification contract. */
export function buildOllamaStructuredProbe(model: string) {
    return {
        model,
        prompt: STRUCTURED_OUTPUT_PROBE_PROMPT,
        stream: false,
        format: 'json',
        options: { temperature: 0 }
    };
}

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
