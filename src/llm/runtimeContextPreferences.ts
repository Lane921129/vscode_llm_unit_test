/** Context choices belong to one non-secret endpoint/model identity. */
export const RUNTIME_CONTEXT_PREFERENCES_KEY = 'llmUnitTest.runtimeContextPreferences.v1';

export interface RuntimeContextPreference {
    endpointKey: string;
    modelName: string;
    tokens: number;
    source: 'user-choice' | 'captured-runtime';
}

const MAX_PREFERENCES = 50;
const normalizedModel = (name: string) => name.trim().replace(/^models\//i, '').toLowerCase();
const identity = (entry: Pick<RuntimeContextPreference, 'endpointKey' | 'modelName'>) =>
    JSON.stringify([entry.endpointKey, normalizedModel(entry.modelName)]);

export function restoreRuntimeContextPreferences(value: unknown): RuntimeContextPreference[] {
    if (!Array.isArray(value)) { return []; }
    return value.filter((item): item is RuntimeContextPreference => Boolean(item) && typeof item === 'object'
        && typeof item.endpointKey === 'string' && item.endpointKey.length > 0 && item.endpointKey.length <= 512
        && typeof item.modelName === 'string' && item.modelName.trim().length > 0 && item.modelName.length <= 256
        && typeof item.tokens === 'number' && Number.isSafeInteger(item.tokens) && item.tokens > 0
        && ['user-choice', 'captured-runtime'].includes(item.source)).slice(-MAX_PREFERENCES);
}

export function getRuntimeContextPreference(value: unknown,
    request: Pick<RuntimeContextPreference, 'endpointKey' | 'modelName'>): RuntimeContextPreference | undefined {
    const key = identity(request);
    return restoreRuntimeContextPreferences(value).reverse().find(item => identity(item) === key);
}

/** 0 clears only this identity; source distinguishes a user choice from a saved
 * observed/default runtime when the model has no verifiable upper-bound metadata. */
export function upsertRuntimeContextPreference(value: unknown,
    request: Pick<RuntimeContextPreference, 'endpointKey' | 'modelName'>,
    tokens: number, source: RuntimeContextPreference['source']): RuntimeContextPreference[] {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !request.endpointKey || request.endpointKey.length > 512
        || !request.modelName.trim() || request.modelName.length > 256
        || !['user-choice', 'captured-runtime'].includes(source)) { throw new Error('Invalid context preference'); }
    const key = identity(request);
    const other = restoreRuntimeContextPreferences(value).filter(item => identity(item) !== key);
    return tokens === 0 ? other : [...other, { ...request, modelName: request.modelName.trim(), tokens, source }].slice(-MAX_PREFERENCES);
}
