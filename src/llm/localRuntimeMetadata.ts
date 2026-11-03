import { CONNECTION_DISCOVERY_TIMEOUT_MS, FetchLike } from './connectionTimeout';
import { qualificationEndpointKey } from './modelQualification';
import { findModelProfile, StoredModelProfile } from './modelProfileRegistry';
import { getOllamaModelConnectionMetadata, getOllamaRuntimeContextMetadata } from './ollamaRuntime';

export type RuntimeMetadataReason = 'loaded' | 'http-error' | 'network-error' | 'timeout' | 'cancelled'
    | 'invalid-json' | 'missing-context-limit' | 'allocation-unavailable';
export interface RuntimeMetadataReadDiagnostic {
    reasonCode: RuntimeMetadataReason;
    httpStatus: number | null;
    elapsedMs: number;
}
/** Only fixed status fields, numerical timings and an endpoint digest leave discovery. */
export interface LocalRuntimeMetadataDiagnostic {
    version: 'local-runtime-metadata-v1';
    endpointKey: string;
    status: 'fresh' | 'cached' | 'unavailable';
    source: 'ollama-show' | 'stored-model-profile' | 'unknown';
    show: RuntimeMetadataReadDiagnostic;
    allocation: RuntimeMetadataReadDiagnostic;
}

export async function readLocalRuntimeMetadata(input: {
    baseUrl: string; modelName: string; cachedProfile?: StoredModelProfile;
    fetcher?: FetchLike<Response>; signal?: AbortSignal; timeoutMs?: number;
}) {
    const baseUrl = input.baseUrl.replace(/\/+$/, '');
    const identity = { envType: 'local' as const, modelName: input.modelName,
        endpointKey: qualificationEndpointKey('local', baseUrl) };
    // Registry lookup proves the exact model/endpoint identity before any reuse.
    const cached = input.cachedProfile ? findModelProfile([input.cachedProfile], identity) : undefined;
    const fetcher = input.fetcher ?? ((url: string, init: RequestInit) => fetch(url, init));
    const read = async (suffix: string, init: RequestInit) => {
        const startedAt = Date.now(), controller = new AbortController();
        if (input.signal?.aborted) { return { value: undefined, diagnostic:
            { reasonCode: 'cancelled' as RuntimeMetadataReason, httpStatus: null, elapsedMs: 0 } }; }
        let timedOut = false, parsing = false;
        const cancel = () => controller.abort();
        let rejectAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new Error('metadata-read-aborted')); });
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        input.signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => { timedOut = true; cancel(); }, input.timeoutMs ?? CONNECTION_DISCOVERY_TIMEOUT_MS);
        let httpStatus: number | null = null;
        const result = (reasonCode: RuntimeMetadataReason, value?: unknown) => ({ value,
            diagnostic: { reasonCode, httpStatus, elapsedMs: Math.max(0, Date.now() - startedAt) } });
        try {
            if (controller.signal.aborted) { return result('cancelled'); }
            const response = await Promise.race([fetcher(baseUrl + suffix, { ...init, signal: controller.signal }), aborted]);
            httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
                ? response.status : null;
            if (input.signal?.aborted) { return result('cancelled'); }
            if (!response.ok) { return result('http-error'); }
            parsing = true;
            const value: unknown = await Promise.race([response.json(), aborted]);
            if (input.signal?.aborted) { return result('cancelled'); }
            if (timedOut) { return result('timeout'); }
            return result('loaded', value);
        } catch {
            return result(input.signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : parsing ? 'invalid-json' : 'network-error');
        } finally {
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', rejectAbort);
        }
    };
    const [shown, running] = await Promise.all([
        read('/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: input.modelName }) }), read('/api/ps', {})
    ]);
    const fresh = getOllamaModelConnectionMetadata(shown.value);
    const cachedLimitValid = cached?.contextLengthKnown === true && Number.isSafeInteger(cached.contextLength)
        && cached.contextLength > 0;
    const metadata = fresh.contextLengthKnown ? { ...fresh,
        paramSize: fresh.paramSize === 'unknown' && cached ? cached.paramSize : fresh.paramSize } : cachedLimitValid
        ? { paramSize: fresh.paramSize === 'unknown' ? cached!.paramSize : fresh.paramSize,
            contextLength: cached!.contextLength, contextLengthKnown: true }
        : fresh;
    const allocation = getOllamaRuntimeContextMetadata(shown.value, running.value, input.modelName);
    const diagnostic: LocalRuntimeMetadataDiagnostic = {
        version: 'local-runtime-metadata-v1', endpointKey: identity.endpointKey,
        status: fresh.contextLengthKnown ? 'fresh' : cachedLimitValid ? 'cached' : 'unavailable',
        source: fresh.contextLengthKnown ? 'ollama-show' : cachedLimitValid ? 'stored-model-profile' : 'unknown',
        show: { ...shown.diagnostic, reasonCode: shown.diagnostic.reasonCode === 'loaded' && !fresh.contextLengthKnown
            ? 'missing-context-limit' : shown.diagnostic.reasonCode },
        allocation: { ...running.diagnostic, reasonCode: running.diagnostic.reasonCode === 'loaded'
            && allocation?.runtimeContextSource !== 'ollama-ps' ? 'allocation-unavailable' : running.diagnostic.reasonCode }
    };
    return { identity, metadata, allocation, diagnostic };
}
