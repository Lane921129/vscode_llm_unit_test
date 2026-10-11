import { AnalysisStageError } from '../utils/executionFailureCategory';
import { localize } from '../i18n/core';

/** Never treat a syntactically valid prefix as a completed candidate. The
 * diagnostic deliberately excludes the provider response and arbitrary reason. */
export function getCompletedOllamaText(payload: Record<string, unknown>, outputTokenLimit?: number): string {
    if (payload.done_reason === 'length') {
        throw new AnalysisStageError('model-format', 'model-request',
            localize('模型回覆達到輸出上限而未完成；未保存或執行截斷內容。'),
            { reasonCode: 'output-token-limit',
                ...(Number.isSafeInteger(outputTokenLimit) && (outputTokenLimit as number) > 0 ? { outputTokenLimit } : {}) });
    }
    return typeof payload.response === 'string' ? payload.response : '';
}
