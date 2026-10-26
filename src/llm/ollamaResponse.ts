import { AnalysisStageError } from '../utils/executionFailureCategory';
import { localize } from '../i18n/core';
import { createHash } from 'node:crypto';
import { buildModelOutputPreview, diagnoseModelOutput } from './modelOutputDiagnostics';

const shapeCounts = ['responseCharacters', 'sampledCharacters', 'sampledLines', 'nonemptyLines',
    'pythonFences', 'testMethods', 'assertionCalls', 'repeatedLines'] as const;

/** Lexical diagnostics only: never candidate validity, Python AST or an oracle.
 * Inspect a bounded sample; keep only counts and a hash, never sampled text. */
export function outputShape(text: string) {
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
export function getCompletedOllamaText(payload: Record<string, unknown>, outputTokenLimit?: number,
    privacy?: Parameters<typeof buildModelOutputPreview>[1], requireExplicitStop = false): string {
    if (payload.done_reason === 'length') {
        const knownLimit = Number.isSafeInteger(outputTokenLimit) && (outputTokenLimit as number) > 0;
        const shape = typeof payload.response === 'string' ? outputShape(payload.response) : undefined;
        const diagnosis = diagnoseModelOutput(shape);
        throw new AnalysisStageError('model-format', 'model-request',
            knownLimit
                ? diagnosis === 'repetitive-without-tests'
                    ? localize('模型回覆高度重複且沒有可辨識測試結構（本次 num_predict={0} tokens）；未採用或執行截斷測試，詳見失敗報告的輸出診斷。', outputTokenLimit)
                    : diagnosis === 'repetitive-test-shells'
                        ? localize('模型回覆反覆輸出測試外框，沒有可辨識的 unittest 斷言（本次 num_predict={0} tokens）；未採用截斷內容，詳見失敗報告。', outputTokenLimit)
                        : localize('模型回覆因長度限制未完成（本次 num_predict={0} tokens）；未採用或執行截斷測試，失敗報告另列輸出診斷與去密節錄。', outputTokenLimit)
                : localize('模型回覆達到輸出上限而未完成；未保存或執行截斷內容。'),
            { reasonCode: 'output-token-limit',
                ...(shape ? { responseShape: shape,
                    outputDiagnosis: diagnosis,
                    ...(privacy && typeof payload.response === 'string'
                        ? { responsePreview: buildModelOutputPreview(payload.response, privacy) } : {}) } : {}),
                ...(knownLimit ? { outputTokenLimit } : {}) });
    }
    if (requireExplicitStop && (payload.done !== true || payload.done_reason !== 'stop')) {
        throw new AnalysisStageError('model-format', 'model-request',
            localize('種子續寫未取得明確完整 stop 證據；未接合或執行內容。'));
    }
    return typeof payload.response === 'string' ? payload.response : '';
}
