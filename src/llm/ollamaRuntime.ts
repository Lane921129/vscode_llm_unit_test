export interface OllamaModelConnectionMetadata {
    paramSize: string;
    contextLength: number;
    contextLengthKnown: boolean;
    /** Exact API metadata key; a fallback context has no source key. */
    contextSource?: string;
}

export interface OllamaRuntimeContextMetadata {
    effectiveRuntimeContextTokens: number;
    runtimeContextSource: 'ollama-ps' | 'ollama-num-ctx';
}

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveContext(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function modelIdentity(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) { return undefined; }
    const name = value.trim();
    return name.slice(name.lastIndexOf('/') + 1).includes(':') || name.includes('@') ? name : `${name}:latest`;
}

/** Read runtime settings for the requested model, never infer allocation from the architecture limit. */
export function getOllamaRuntimeContextMetadata(showPayload: unknown, runningPayload: unknown,
    modelName: string): OllamaRuntimeContextMetadata | undefined {
    const requested = modelIdentity(modelName);
    if (!requested) { return undefined; }
    if (record(runningPayload) && Object.hasOwn(runningPayload, 'models') && Array.isArray(runningPayload.models)) {
        const matches = runningPayload.models.filter(item => record(item)
            && [item.name, item.model].some(value => modelIdentity(value) === requested));
        if (matches.length > 1) { return undefined; }
        if (matches.length === 1) {
            const match = matches[0];
            const identities = [match.name, match.model].filter(value => value !== undefined).map(modelIdentity);
            if (identities.some(identity => identity !== requested)) { return undefined; }
            if (Object.hasOwn(match, 'context_length') && positiveContext(match.context_length)) {
                return { effectiveRuntimeContextTokens: match.context_length, runtimeContextSource: 'ollama-ps' };
            }
        }
    }
    if (!record(showPayload) || !Object.hasOwn(showPayload, 'parameters')) { return undefined; }
    const parameters = showPayload.parameters;
    if (record(parameters) && Object.hasOwn(parameters, 'num_ctx') && positiveContext(parameters.num_ctx)) {
        return { effectiveRuntimeContextTokens: parameters.num_ctx, runtimeContextSource: 'ollama-num-ctx' };
    }
    if (typeof parameters !== 'string') { return undefined; }
    const lines = parameters.split(/\r?\n/).filter(line => /^\s*num_ctx(?:\s|=|$)/.test(line));
    if (lines.length !== 1) { return undefined; }
    const match = lines[0].match(/^\s*num_ctx[ \t]+([1-9]\d*)[ \t]*$/);
    const numCtx = match ? Number(match[1]) : undefined;
    return positiveContext(numCtx) ? { effectiveRuntimeContextTokens: numCtx, runtimeContextSource: 'ollama-num-ctx' } : undefined;
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
