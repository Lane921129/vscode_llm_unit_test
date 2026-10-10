export interface OllamaModelConnectionMetadata {
    paramSize: string;
    contextLength: number;
    contextLengthKnown: boolean;
    /** Exact API metadata key; a fallback context has no source key. */
    contextSource?: string;
}

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Model metadata is an upper bound, distinct from Modelfile defaults and /api/ps allocation. */
export function getOllamaModelConnectionMetadata(payload: unknown): OllamaModelConnectionMetadata {
    const data = record(payload) ? payload : {};
    const details = record(data.details) ? data.details : {};
    const paramSize = typeof details.parameter_size === 'string' && details.parameter_size.trim()
        ? details.parameter_size.trim() : 'unknown';
    const fallback: OllamaModelConnectionMetadata = { paramSize, contextLength: 4096, contextLengthKnown: false };
    if (!record(data.model_info)) { return fallback; }
    const info = data.model_info;
    let key: string | undefined;
    if (Object.hasOwn(info, 'general.architecture')) {
        const architecture = info['general.architecture'];
        if (typeof architecture !== 'string' || !architecture.trim()) { return fallback; }
        key = `${architecture}.context_length`;
    } else {
        // Older metadata may omit architecture. Never pick an arbitrary first
        // field or a vision/audio submodel's nested context length.
        const keys = Object.keys(info).filter(candidate => /^[^.]+\.context_length$/.test(candidate));
        if (keys.length !== 1) { return fallback; }
        key = keys[0];
    }
    if (!Object.hasOwn(info, key)) { return fallback; }
    const contextLength = info[key];
    if (typeof contextLength !== 'number' || !Number.isSafeInteger(contextLength) || contextLength <= 0) { return fallback; }
    return { paramSize, contextLength, contextLengthKnown: true, contextSource: key };
}
