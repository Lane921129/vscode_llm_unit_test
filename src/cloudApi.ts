export interface GoogleGenerateContentRequest {
    url: string;
    headers: Record<string, string>;
    body: {
        contents: Array<{ parts: Array<{ text: string }> }>;
        generationConfig?: {
            responseMimeType: 'application/json';
            responseSchema?: Record<string, unknown>;
        };
    };
}

export interface GoogleGenerationOptions {
    responseMimeType?: 'application/json';
    responseSchema?: Record<string, unknown>;
}

export interface GoogleListModelsRequest {
    url: string;
    headers: Record<string, string>;
}

export interface GoogleModelDescriptor {
    name?: string;
    supportedGenerationMethods?: string[];
    supportedActions?: string[];
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
            ...(options?.responseMimeType ? {
                generationConfig: {
                    responseMimeType: options.responseMimeType,
                    ...(options.responseSchema ? { responseSchema: options.responseSchema } : {})
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
