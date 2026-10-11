/** Display-only /api/ps observations. They never choose or qualify request capacity. */
export const OLLAMA_ALLOCATION_OBSERVATIONS_KEY = 'llmUnitTest.ollamaAllocationObservations.v1';
export interface OllamaAllocationObservation { endpointKey: string; modelName: string; tokens: number }
const key = (entry: Pick<OllamaAllocationObservation, 'endpointKey' | 'modelName'>) =>
    JSON.stringify([entry.endpointKey, entry.modelName.trim().toLowerCase()]);
function restore(value: unknown): OllamaAllocationObservation[] {
    if (!Array.isArray(value)) { return []; }
    return value.filter((entry): entry is OllamaAllocationObservation => Boolean(entry) && typeof entry === 'object'
        && typeof entry.endpointKey === 'string' && entry.endpointKey.length > 0 && entry.endpointKey.length <= 512
        && typeof entry.modelName === 'string' && entry.modelName.trim().length > 0 && entry.modelName.length <= 256
        && Number.isSafeInteger(entry.tokens) && entry.tokens > 0).slice(-50);
}
export function getOllamaAllocationObservation(value: unknown,
    identity: Pick<OllamaAllocationObservation, 'endpointKey' | 'modelName'>): OllamaAllocationObservation | undefined {
    return restore(value).reverse().find(entry => key(entry) === key(identity));
}
export function upsertOllamaAllocationObservation(value: unknown, observation: OllamaAllocationObservation): OllamaAllocationObservation[] {
    const validated = restore([observation]);
    if (!validated.length) { throw new Error('Invalid allocation observation'); }
    return [...restore(value).filter(entry => key(entry) !== key(observation)), validated[0]].slice(-50);
}
