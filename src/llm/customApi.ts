export type CustomOutputFormat = 'text' | 'json' | 'test-code-json';

// These client-error statuses are commonly used by compatible providers when
// a response-format / JSON-schema option is unsupported.  Authentication,
// model-not-found, rate-limit, and server failures deliberately stay errors.
const STRUCTURED_OUTPUT_REJECTION_STATUSES = new Set([400, 415, 422, 501]);

/** Safely obtains the assistant text from a standard Chat Completions response. */
export function getCustomChatCompletionText(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
        return undefined;
    }
    const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
    if (typeof content === 'string') {
        return content.trim() ? content : undefined;
    }
    // Some OpenAI-compatible gateways return typed message segments instead
    // of one string.  Preserve text segments in order, while ignoring tool,
    // image, reasoning, and malformed parts that are not executable output.
    if (Array.isArray(content)) {
        const text = content
            .map(part => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : undefined)
            .filter((part): part is string => typeof part === 'string')
            .join('');
        return text.trim() ? text : undefined;
    }
    return undefined;
}

/**
 * Builds an OpenAI-compatible chat-completions request body.  JSON mode is
 * requested only for analysis/code contracts and the caller can retry as text
 * when a provider does not implement response_format.
 */
export function buildCustomChatCompletionBody(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    outputFormat: CustomOutputFormat
): Record<string, unknown> {
    return {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        ...(outputFormat !== 'text' ? { response_format: { type: 'json_object' } } : {})
    };
}

/** Adds a provider-neutral contract without naming any application behaviour. */
export function addOutputContract(systemPrompt: string, outputFormat: CustomOutputFormat): string {
    if (outputFormat === 'test-code-json') {
        return `${systemPrompt}\n\nOUTPUT CONTRACT: Return exactly one JSON object with one string field named "code". The code value must contain the complete runnable Python unittest file. Do not use Markdown fences or add other fields.`;
    }
    if (outputFormat === 'json') {
        return `${systemPrompt}\n\nOUTPUT CONTRACT: Return exactly one valid JSON object. Do not use Markdown fences or explanatory prose.`;
    }
    return systemPrompt;
}

/**
 * Distinguishes usable structured output from HTTP-successful but malformed
 * output. Plain Python remains valid compatibility output for test generation.
 */
export function isStructuredResponseUsable(response: string, outputFormat: CustomOutputFormat): boolean {
    if (outputFormat === 'text') {
        return true;
    }
    const trimmed = response.trim();
    if (!trimmed) {
        return false;
    }
    if (outputFormat === 'test-code-json' && !trimmed.startsWith('{')) {
        return true;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
            return false;
        }
        return outputFormat === 'json'
            ? Object.keys(parsed as Record<string, unknown>).length > 0
            : typeof (parsed as { code?: unknown }).code === 'string';
    } catch {
        return false;
    }
}

/**
 * Retry only known structured-output rejection statuses as ordinary text.
 * This keeps providers that can write Python but cannot enforce JSON usable,
 * without hiding credential, selected-model, or quota problems.
 */
export function shouldRetryStructuredOutputAsText(status: number, outputFormat: CustomOutputFormat): boolean {
    return outputFormat !== 'text' && STRUCTURED_OUTPUT_REJECTION_STATUSES.has(status);
}
