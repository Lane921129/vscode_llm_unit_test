import { REVIEW_CATEGORIES, REVIEW_FINDING_LIMIT } from '../roles/testReviewer';

export type CustomOutputFormat = 'text' | 'json' | 'test-code-json' | 'test-method-json' | 'semantic-json' | 'review-json' | 'quality-json' | 'mutant-triage-json';

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
    const finishReason = (choices[0] as { finish_reason?: unknown }).finish_reason;
    if (finishReason !== undefined && finishReason !== null && finishReason !== 'stop') { return undefined; }
    const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
    if (typeof content === 'string') {
        return content.trim() ? content : undefined;
    }
    // Some OpenAI-compatible gateways return typed message segments instead
    // of one string.  Preserve text segments in order, while ignoring tool,
    // image, reasoning, and malformed parts that are not executable output.
    if (Array.isArray(content)) {
        const text = content
            .map(part => part && typeof part === 'object'
                && (!(part as { type?: unknown }).type || ['text', 'output_text'].includes(String((part as { type?: unknown }).type)))
                && typeof (part as { text?: unknown }).text === 'string'
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
    if (outputFormat === 'test-method-json') {
        return `${systemPrompt}\n\nOUTPUT CONTRACT: Return exactly one JSON object with method, replacement, and imports fields. replacement contains one Python test method; imports is an array of import lines. Do not use Markdown fences or add other fields.`;
    }
    if (outputFormat === 'json' || outputFormat === 'semantic-json' || outputFormat === 'review-json' || outputFormat === 'quality-json' || outputFormat === 'mutant-triage-json') {
        return `${systemPrompt}\n\nOUTPUT CONTRACT: Return exactly one valid JSON object. Do not use Markdown fences or explanatory prose.`;
    }
    return systemPrompt;
}

/**
 * Provider-neutral schemas used only where a provider advertises JSON Schema
 * support. Other providers still receive the same prompt contract and pass
 * the same local parsers; this schema is an additional transport guarantee,
 * never the only validation layer.
 */
export function responseSchemaForOutputFormat(outputFormat: CustomOutputFormat): Record<string, unknown> | undefined {
    if (outputFormat === 'quality-json') {
        return { type: 'object', additionalProperties: false, required: ['tasks'], properties: {
            tasks: { type: 'array', maxItems: 1, items: { type: 'object', additionalProperties: false,
                required: ['evidence_id', 'hypothesis', 'scenario', 'verification'], properties: {
                    evidence_id: { type: 'string', pattern: '^E[0-9a-f]{16}$' },
                    ...Object.fromEntries(['hypothesis', 'scenario', 'verification'].map(key =>
                        [key, { type: 'string', minLength: 1, maxLength: 800 }]))
                } } }
        } };
    }
    if (outputFormat === 'test-code-json') {
        return {
            type: 'object',
            properties: { code: { type: 'string', description: 'Complete runnable Python unittest file.' } },
            required: ['code']
        };
    }
    if (outputFormat === 'semantic-json') {
        return {
            type: 'object',
            properties: {
                dependency_behaviors: { type: 'array' },
                unreachable_paths: { type: 'array' },
                mock_required_for: { type: 'array' },
                test_strategy: { type: 'object' }
            },
            required: [
                'dependency_behaviors', 'unreachable_paths',
                'mock_required_for', 'test_strategy'
            ]
        };
    }
    if (outputFormat === 'test-method-json') {
        return {
            type: 'object',
            properties: {
                method: { type: 'string' },
                replacement: { type: 'string', description: 'One complete Python test method.' },
                imports: { type: 'array', items: { type: 'string' } }
            },
            required: ['method', 'replacement', 'imports']
        };
    }
    if (outputFormat === 'review-json') {
        const finding = {
            type: 'object',
            additionalProperties: false,
            properties: {
                category: { type: 'string', enum: Object.keys(REVIEW_CATEGORIES) },
                test_line: { type: 'string', pattern: '^L[1-9][0-9]*$' },
                reason: { type: 'string', minLength: 1, maxLength: 600 },
                action: { type: 'string', minLength: 1, maxLength: 600 }
            },
            required: ['category', 'test_line', 'reason', 'action']
        };
        return {
            type: 'object',
            additionalProperties: false,
            properties: {
                findings: { type: 'array', items: finding, maxItems: REVIEW_FINDING_LIMIT }
            },
            required: ['findings']
        };
    }
    if (outputFormat === 'mutant-triage-json') {
        return {
            type: 'object',
            properties: {
                verdicts: { type: 'array' },
                has_killable: { type: 'boolean' },
                equivalent_count: { type: 'integer' }
            },
            required: ['verdicts', 'has_killable', 'equivalent_count']
        };
    }
    return undefined;
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
    if (outputFormat === 'test-code-json') {
        const jsonMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
        const candidateJson = jsonMatch ? jsonMatch[1].trim() : trimmed;
        if (candidateJson.startsWith('{')) {
            try {
                const parsed = JSON.parse(candidateJson);
                return Boolean(parsed && typeof parsed === 'object' && typeof (parsed as { code?: unknown }).code === 'string');
            } catch {
                return false;
            }
        }
        return /^(?:import\s+|from\s+|class\s+|def\s+|```(?:python|py)\b)/m.test(trimmed);
    }
    if (outputFormat === 'test-method-json') {
        const jsonMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
        const candidateJson = jsonMatch ? jsonMatch[1].trim() : trimmed;
        try {
            const parsed = JSON.parse(candidateJson) as Record<string, unknown>;
            return typeof parsed.method === 'string' && typeof parsed.replacement === 'string'
                && Array.isArray(parsed.imports);
        } catch {
            return false;
        }
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
            return false;
        }
        return Object.keys(parsed as Record<string, unknown>).length > 0;
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
