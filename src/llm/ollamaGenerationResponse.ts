import { AnalysisStageError } from '../utils/executionFailureCategory';
import { localize } from '../i18n/core';

export interface OllamaResponseProgress {
    version: 'ollama-response-progress-v1';
    phase: 'first-bytes' | 'first-text' | 'completed';
    receivedChunks: number;
    receivedBytes: number;
    responseCharacters: number;
    elapsedMs: number;
    firstTextMs: number | null;
}

export const OLLAMA_GENERATION_RESPONSE_LIMITS = Object.freeze({
    wireBytes: 16 * 1024 * 1024,
    answerCharacters: 8 * 1024 * 1024,
    lineCharacters: 4 * 1024 * 1024
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(reasonCode: string, category: 'model-format' | 'model-api' = 'model-format'): never {
    throw new AnalysisStageError(category, 'model-response',
        localize('Ollama 回應未完整完成或格式無效，已捨棄部分內容。'),
        { reasonCode });
}

const numericalFields = ['total_duration', 'load_duration', 'prompt_eval_count',
    'prompt_eval_duration', 'eval_count', 'eval_duration'] as const;

/** Keep the legacy JSON adapter's missing-done compatibility, but reject an
 * explicitly incomplete response. Only
 * advertised NDJSON uses the bounded wire/line reader; plain JSON mocks still
 * call json(), with an answer-size check after decoding. No deadline is added. */
export async function readOllamaGenerationResponse(response: Response,
    onProgress?: (progress: OllamaResponseProgress) => void): Promise<Record<string, unknown>> {
    const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/x-ndjson' && contentType !== 'application/ndjson') {
        let payload: unknown;
        try { payload = await response.json(); }
        catch (error) {
            if (error instanceof AnalysisStageError || error instanceof Error && error.name === 'AbortError') { throw error; }
            return invalid('ollama-response-invalid-json');
        }
        if (!isRecord(payload)) { return invalid('ollama-response-invalid-record'); }
        if (Object.hasOwn(payload, 'done') && typeof payload.done !== 'boolean') {
            return invalid('ollama-response-invalid-record');
        }
        if (payload.done === false) { return invalid('ollama-response-incomplete'); }
        if (typeof payload.response === 'string' && payload.response.length > OLLAMA_GENERATION_RESPONSE_LIMITS.answerCharacters) {
            return invalid('ollama-response-answer-limit');
        }
        return payload;
    }

    if (!response.body) { return invalid('ollama-stream-body-unavailable'); }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = response.body.getReader(); }
    catch { return invalid('ollama-stream-body-unavailable'); }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const startedAt = performance.now();
    let receivedChunks = 0, receivedBytes = 0, responseCharacters = 0;
    let firstTextMs: number | null = null;
    let firstBytes = false, complete = false, observerFailed = false;
    let buffer = '';
    const answer: string[] = [];
    let terminal: Record<string, unknown> | undefined;
    const elapsed = () => Math.max(0, performance.now() - startedAt);
    const notify = (phase: OllamaResponseProgress['phase']) => {
        if (!onProgress) { return; }
        try {
            onProgress({ version: 'ollama-response-progress-v1', phase,
                receivedChunks, receivedBytes, responseCharacters, elapsedMs: elapsed(), firstTextMs });
        } catch (error) { observerFailed = true; throw error; }
    };
    const consumeLine = (line: string) => {
        if (line.length > OLLAMA_GENERATION_RESPONSE_LIMITS.lineCharacters) { return invalid('ollama-stream-line-limit'); }
        if (!line.trim()) { return; }
        let record: unknown;
        try { record = JSON.parse(line); }
        catch { return invalid('ollama-stream-invalid-json'); }
        if (!isRecord(record)) { return invalid('ollama-stream-invalid-record'); }
        if (terminal) {
            return invalid(record.done === true ? 'ollama-stream-duplicate-terminal' : 'ollama-stream-trailing-record');
        }
        if (Object.hasOwn(record, 'error')) { return invalid('ollama-stream-provider-error', 'model-api'); }
        if (Object.hasOwn(record, 'done') && typeof record.done !== 'boolean'
            || Object.hasOwn(record, 'response') && typeof record.response !== 'string') {
            return invalid('ollama-stream-invalid-record');
        }
        if (typeof record.response === 'string' && record.response.length) {
            responseCharacters += record.response.length;
            if (responseCharacters > OLLAMA_GENERATION_RESPONSE_LIMITS.answerCharacters) { return invalid('ollama-stream-answer-limit'); }
            answer.push(record.response);
            if (firstTextMs === null) { firstTextMs = elapsed(); notify('first-text'); }
        }
        if (record.done === true) {
            terminal = { done: true };
            if (record.done_reason === 'stop' || record.done_reason === 'length' || record.done_reason === 'unload') {
                terminal.done_reason = record.done_reason;
            }
            for (const field of numericalFields) {
                const value = record[field];
                if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) { terminal[field] = value; }
            }
        }
    };
    const consumeText = (text: string) => {
        buffer += text;
        let start = 0, newline: number;
        while ((newline = buffer.indexOf('\n', start)) !== -1) {
            consumeLine(buffer.slice(start, newline));
            start = newline + 1;
        }
        buffer = buffer.slice(start);
        if (buffer.length > OLLAMA_GENERATION_RESPONSE_LIMITS.lineCharacters) { return invalid('ollama-stream-line-limit'); }
    };
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) { break; }
            if (!(chunk.value instanceof Uint8Array)) { return invalid('ollama-stream-invalid-chunk'); }
            if (!chunk.value.byteLength) { continue; }
            receivedChunks++; receivedBytes += chunk.value.byteLength;
            if (receivedBytes > OLLAMA_GENERATION_RESPONSE_LIMITS.wireBytes) { return invalid('ollama-stream-wire-limit'); }
            if (!firstBytes) { firstBytes = true; notify('first-bytes'); }
            let text: string;
            try { text = decoder.decode(chunk.value, { stream: true }); }
            catch { return invalid('ollama-stream-invalid-utf8'); }
            consumeText(text);
        }
        let remainder: string;
        try { remainder = decoder.decode(); }
        catch { return invalid('ollama-stream-invalid-utf8'); }
        consumeText(remainder);
        consumeLine(buffer);
        if (!terminal) { return invalid('ollama-stream-missing-terminal'); }
        const payload = { ...terminal, response: answer.join('') };
        notify('completed');
        complete = true;
        return payload;
    } catch (error) {
        if (observerFailed || error instanceof AnalysisStageError || error instanceof Error && error.name === 'AbortError') { throw error; }
        return invalid('ollama-stream-read-error');
    } finally {
        if (!complete) {
            // A broken transport may never settle cancel(). Cleanup must not
            // extend the caller's original deadline or conceal this failure.
            try { void reader.cancel().catch(() => undefined); } catch { /* Preserve the original safe diagnostic. */ }
        }
        reader.releaseLock();
    }
}
