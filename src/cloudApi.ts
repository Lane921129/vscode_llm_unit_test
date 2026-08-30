export interface GoogleGenerateContentRequest {
    url: string;
    headers: Record<string, string>;
    body: {
        contents: Array<{ parts: Array<{ text: string }> }>;
    };
}

/**
 * Creates a Gemini API request without putting the API key in the URL.
 * Keeping the key in a header prevents it from appearing in proxy, error, and
 * diagnostic URLs.
 */
export function buildGoogleGenerateContentRequest(
    modelName: string,
    apiKey: string,
    prompt: string
): GoogleGenerateContentRequest {
    const normalizedModel = modelName.trim();
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
        },
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
