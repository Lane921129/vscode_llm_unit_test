import { AnalysisStageError } from '../utils/executionFailureCategory';
import { localize } from '../i18n/core';
import { createHash } from 'node:crypto';

const shapeCounts = ['responseCharacters', 'sampledCharacters', 'sampledLines', 'nonemptyLines',
    'pythonFences', 'testMethods', 'assertionCalls', 'repeatedLines'] as const;

/** Lexical diagnostics only: never candidate validity, Python AST or an oracle.
 * Inspect a bounded sample; keep only counts and a hash, never sampled text. */
function outputShape(text: string) {
    const sample = text.slice(0, 65536).split('\n').slice(0, 2048);
    const nonempty = sample.map(line => line.trim()).filter(Boolean);
    const code = sample.join('\n');
    return { version: 'output-shape-v1', responseHash: createHash('sha256').update(text).digest('hex'),
        responseCharacters: text.length, sampledCharacters: code.length, sampledLines: sample.length,
        sampleComplete: code.length === text.length, nonemptyLines: nonempty.length,
        pythonFences: (code.match(/^\s*```(?:python|py)?\s*$/gm) || []).length,
        testMethods: (code.match(/^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm) || []).length,
        assertionCalls: (code.match(/\bself\.assert\w+\s*\(/g) || []).length,
        repeatedLines: nonempty.length - new Set(nonempty).size };
}

export function readOutputShapeDiagnostic(value: unknown): ReturnType<typeof outputShape> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
    const data = value as Record<string, unknown>;
    if (data.version !== 'output-shape-v1' || typeof data.responseHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(data.responseHash) || typeof data.sampleComplete !== 'boolean'
        || shapeCounts.some(key => !Number.isSafeInteger(data[key]) || (data[key] as number) < 0)
        || (data.sampledCharacters as number) > 65536 || (data.sampledLines as number) > 2048) { return undefined; }
    return { version: data.version, responseHash: data.responseHash, sampleComplete: data.sampleComplete,
        ...Object.fromEntries(shapeCounts.map(key => [key, data[key]])) } as ReturnType<typeof outputShape>;
}

/** Never treat a syntactically valid prefix as a completed candidate. The
 * diagnostic deliberately excludes the provider response and arbitrary reason. */
export function getCompletedOllamaText(payload: Record<string, unknown>, outputTokenLimit?: number): string {
    if (payload.done_reason === 'length') {
        const knownLimit = Number.isSafeInteger(outputTokenLimit) && (outputTokenLimit as number) > 0;
        throw new AnalysisStageError('model-format', 'model-request',
            knownLimit
                ? localize('模型回覆因長度限制未完成（本次 num_predict={0} tokens）；輸出額度與 Context 容量分開設定。未保存或執行截斷內容。', outputTokenLimit)
                : localize('模型回覆達到輸出上限而未完成；未保存或執行截斷內容。'),
            { reasonCode: 'output-token-limit',
                ...(typeof payload.response === 'string' ? { responseShape: outputShape(payload.response) } : {}),
                ...(knownLimit ? { outputTokenLimit } : {}) });
    }
    return typeof payload.response === 'string' ? payload.response : '';
}
