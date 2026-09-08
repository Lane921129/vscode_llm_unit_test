export interface GoogleGenerateContentRequest {
    url: string;
    headers: Record<string, string>;
    body: {
        contents: Array<{ parts: Array<{ text: string }> }>;
        generationConfig?: {
            responseMimeType?: 'application/json';
            responseSchema?: Record<string, unknown>;
            temperature?: number;
        };
    };
}

export interface GoogleGenerationOptions {
    responseMimeType?: 'application/json';
    responseSchema?: Record<string, unknown>;
    /** Set only for deterministic, tiny connection probes. */
    temperature?: number;
}

export interface GoogleListModelsRequest {
    url: string;
    headers: Record<string, string>;
}

export interface GoogleModelDescriptor {
    name?: string;
    displayName?: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedGenerationMethods?: string[];
    supportedActions?: string[];
}

export interface GoogleModelConnectionMetadata {
    /** The API does not guarantee a parameter count; a name-derived value is labelled as such. */
    paramSize: string;
    /** Safe input budget used when the API omits its advertised input limit. */
    contextLength: number;
    contextLengthKnown: boolean;
}

/** Extracts the text from a non-streaming GenerateContent response safely. */
export function getGoogleGeneratedText(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    const candidates = (payload as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || !candidates[0] || typeof candidates[0] !== 'object') {
        return undefined;
    }
    const parts = ((candidates[0] as { content?: { parts?: unknown } }).content?.parts);
    if (!Array.isArray(parts)) {
        return undefined;
    }
    const text = parts
        .map(part => part && typeof part === 'object' ? (part as { text?: unknown }).text : undefined)
        .filter((part): part is string => typeof part === 'string')
        .join('');
    return text || undefined;
}

/** Accept both API resource names (models/name) and UI-friendly model names. */
export function normalizeGoogleModelName(modelName: string): string {
    return modelName.trim().replace(/^models\//, '');
}

/**
 * Creates a Gemini API request without putting the API key in the URL.
 * Keeping the key in a header prevents it from appearing in proxy, error, and
 * diagnostic URLs.
 */
export function buildGoogleGenerateContentRequest(
    modelName: string,
    apiKey: string,
    prompt: string,
    options?: GoogleGenerationOptions
): GoogleGenerateContentRequest {
    const normalizedModel = normalizeGoogleModelName(modelName);
    const normalizedKey = apiKey.trim();

    if (!normalizedModel) {
        throw new Error('Cloud model name is required.');
    }
    if (!normalizedKey) {
        throw new Error('Google AI Studio API key is required.');
    }

    return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent`,
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': normalizedKey,
        },
        body: {
            contents: [{ parts: [{ text: prompt }] }],
            ...(options?.responseMimeType || options?.temperature !== undefined ? {
                generationConfig: {
                    ...(options?.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
                    ...(options?.responseSchema ? { responseSchema: options.responseSchema } : {}),
                    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {})
                }
            } : {})
        },
    };
}

/** Builds a key-safe ListModels request used to validate a saved Cloud model. */
export function buildGoogleListModelsRequest(apiKey: string, pageToken?: string): GoogleListModelsRequest {
    const normalizedKey = apiKey.trim();
    if (!normalizedKey) {
        throw new Error('Google AI Studio API key is required.');
    }
    const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
    return {
        url: `https://generativelanguage.googleapis.com/v1beta/models${query}`,
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': normalizedKey,
        },
    };
}

/** Returns only model IDs that the API declares usable with generateContent. */
export function getGenerateContentModelNames(models: GoogleModelDescriptor[]): string[] {
    return models
        .filter(model => {
            const capabilities = model.supportedGenerationMethods || model.supportedActions || [];
            return capabilities.includes('generateContent');
        })
        .map(model => normalizeGoogleModelName(model.name || ''))
        .filter(Boolean);
}

/**
 * Read only metadata that the selected Google model actually advertises.
 * AI Studio's ListModels response normally exposes token limits but not a
 * guaranteed parameter count.  A "31B" value is therefore shown only when it
 * is explicitly present in the API model/display name and marked as inferred.
 */
export function getGoogleModelConnectionMetadata(
    models: GoogleModelDescriptor[],
    modelName: string
): GoogleModelConnectionMetadata {
    const selectedName = normalizeGoogleModelName(modelName).toLowerCase();
    const selected = models.find(model => normalizeGoogleModelName(model.name || '').toLowerCase() === selectedName);
    const advertisedLimit = selected?.inputTokenLimit;
    const contextLengthKnown = typeof advertisedLimit === 'number' && Number.isFinite(advertisedLimit) && advertisedLimit > 0;
    const modelLabel = [selected?.name, selected?.displayName, modelName]
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
    const parameterMatch = modelLabel.match(/(?:^|[\s_-])(\d+(?:\.\d+)?)\s*b(?:\b|[\s_-])/i);

    return {
        paramSize: parameterMatch ? `${parameterMatch[1]}B（依模型名稱推定）` : 'Cloud API 未提供',
        contextLength: contextLengthKnown ? advertisedLimit : 4096,
        contextLengthKnown,
    };
}

/**
 * Uses a key supplied by the extension UI first, then an explicit CI/local
 * environment variable. The key is never read from workspace settings.
 */
export function resolveGoogleApiKey(
    transientKey: string | undefined,
    environment: NodeJS.ProcessEnv = process.env
): string | undefined {
    const fromUi = transientKey?.trim();
    if (fromUi) {
        return fromUi;
    }

    const fromEnvironment = environment.LLM_UNIT_TEST_GOOGLE_API_KEY?.trim();
    return fromEnvironment || undefined;
}
