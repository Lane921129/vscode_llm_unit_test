export type CustomOutputFormat = 'text' | 'json' | 'test-code-json';

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
