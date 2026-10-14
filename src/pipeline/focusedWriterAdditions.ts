import type { QualityTaskEvidence } from './qualityTaskEvidence';
import { validTraceInputSnapshot, validTraceValueSnapshot } from './traceValues';
import type { WriterAdditionMergeResult } from '../validation/testMerger';
import { AnalysisStageError } from '../utils/executionFailureCategory';

export interface FocusedWriterAdditionEvent {
    ordinal: number; total: number; attempt: number; caseId?: string;
    reasonCode?: string; addedMethodsCount?: number;
    executionStatus: 'not-run'; reviewStatus: 'not-run';
}
export interface FocusedWriterAdditionOptions {
    baseline: string;
    evidence: QualityTaskEvidence;
    request(caseEvidence: QualityTaskEvidence, accumulatedCode: string, ordinal: number,
        total: number, correction?: string): Promise<string>;
    merge(baseline: string, addition: string): Promise<WriterAdditionMergeResult>;
    /** Accept only one AST-proven literal call for this exact typed case. Unknown
     * or missing calls must return a rejection, never completion of a microtask. */
    validate(mergedCode: string, caseEvidence: QualityTaskEvidence, previousBaseline: string): Promise<string | undefined>;
    onEvent?(status: 'requested' | 'rejected' | 'composed' | 'completed', detail: FocusedWriterAdditionEvent): void;
}
export type FocusedWriterAdditionResult = { ok: true; code: string }
    | { ok: false; reasonCode: string; addition?: string };

const reasonCode = (reason: unknown): string => typeof reason === 'string' && /^[a-z][a-z0-9-]{0,95}$/.test(reason)
    ? reason : 'focused-writer-contract-rejected';
const toolFailure = (reason: string): boolean => /(?:^|-)(?:tool-error|result-invalid)$/.test(reason);
const failTool = (reason: string): never => {
    throw new AnalysisStageError('validation', 'focused-writer-addition',
        'The focused Writer composition tool could not establish a valid result.', { reasonCode: reason });
};
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) { freeze(item); }
        Object.freeze(value);
    }
    return value;
}
function validEvidence(evidence: QualityTaskEvidence): boolean {
    return !!evidence && evidence.schemaVersion === 'quality-task-evidence-v1'
        && typeof evidence.runId === 'string' && !!evidence.runId && /^[a-f0-9]{64}$/.test(evidence.sourceHash)
        && typeof evidence.target === 'string' && !!evidence.target && /^E[a-f0-9]{16}$/.test(evidence.focusId)
        && evidence.scenarioId === `observations:${evidence.focusId}` && Array.isArray(evidence.cases)
        && evidence.cases.length > 0 && evidence.cases.length <= 12
        && evidence.cases.every(item => !!item && typeof item.caseId === 'string' && !!item.caseId
            && validTraceInputSnapshot(item.input) && item.input.replayable
            && validTraceValueSnapshot(item.result) && item.result.replayable)
        && new Set(evidence.cases.map(item => item.caseId)).size === evidence.cases.length;
}

/** AI authors each addition. AST composition creates an unexecuted draft only;
 * the caller must still validate the complete family, execute, review and measure it.
 * No partial draft is returned on failure, and transport/tool exceptions propagate. */
export async function composeFocusedWriterAdditions(options: FocusedWriterAdditionOptions): Promise<FocusedWriterAdditionResult> {
    if (typeof options.baseline !== 'string' || !options.baseline.trim() || !validEvidence(options.evidence)) {
        return { ok: false, reasonCode: 'focused-writer-evidence-invalid' };
    }
    const evidence = structuredClone(options.evidence);
    const total = evidence.cases.length;
    let accumulated = options.baseline;
    for (let index = 0; index < total; index++) {
        const ordinal = index + 1;
        const single: QualityTaskEvidence = { ...evidence, cases: [evidence.cases[index]] };
        let correction: string | undefined;
        let composed = false;
        for (let attempt = 0; attempt <= 2; attempt++) {
            const event = (status: 'requested' | 'rejected' | 'composed', detail: Partial<FocusedWriterAdditionEvent> = {}) =>
                options.onEvent?.(status, { ordinal, total, attempt, caseId: single.cases[0].caseId,
                    executionStatus: 'not-run', reviewStatus: 'not-run', ...detail });
            event('requested');
            const addition = await options.request(freeze(structuredClone(single)), accumulated, ordinal, total, correction);
            let rejected: string | undefined;
            let merged: WriterAdditionMergeResult | undefined;
            if (typeof addition !== 'string') { failTool('writer-addition-result-invalid'); }
            if (!addition.trim()) { rejected = 'focused-writer-empty-addition'; }
            else {
                merged = await options.merge(accumulated, addition);
                if (!merged || typeof merged.ok !== 'boolean') { failTool('merge-result-invalid'); }
                if (!merged.ok) {
                    rejected = reasonCode(merged.reasonCode);
                    if (toolFailure(rejected)) { failTool(rejected); }
                } else {
                    if (typeof merged.mergedCode !== 'string' || !merged.mergedCode.trim()
                        || !Number.isSafeInteger(merged.totalMethodsCount) || merged.totalMethodsCount < 1
                        || !Number.isSafeInteger(merged.addedMethodsCount) || merged.addedMethodsCount < 0
                        || !Array.isArray(merged.addedMethods) || merged.addedMethods.length !== merged.addedMethodsCount
                        || merged.addedMethodsCount > merged.totalMethodsCount) { failTool('merge-result-invalid'); }
                    if (!merged.addedMethodsCount || merged.mergedCode === accumulated) {
                        rejected = 'focused-writer-no-new-methods';
                    } else if (merged.addedMethodsCount !== 1) {
                        rejected = 'focused-writer-case-method-count';
                    } else {
                        const invalid = await options.validate(merged.mergedCode, freeze(structuredClone(single)), accumulated);
                        if (invalid !== undefined) {
                            rejected = reasonCode(invalid);
                            if (toolFailure(rejected)) { failTool(rejected); }
                        }
                    }
                }
            }
            if (rejected) {
                event('rejected', { reasonCode: rejected });
                if (attempt === 2) { return { ok: false, reasonCode: rejected, addition }; }
                correction = `The previous addition was not accepted (${rejected}). Return a replacement addition for this one exact case. `
                    + 'Keep every existing method and fixture unchanged. The accumulated draft is not yet executed or reviewed.';
                continue;
            }
            accumulated = (merged as Extract<WriterAdditionMergeResult, { ok: true }>).mergedCode;
            event('composed', { addedMethodsCount: (merged as Extract<WriterAdditionMergeResult, { ok: true }>).addedMethodsCount });
            composed = true;
            break;
        }
        if (!composed) { return { ok: false, reasonCode: 'focused-writer-composition-incomplete' }; }
    }
    options.onEvent?.('completed', { ordinal: total, total, attempt: 0, executionStatus: 'not-run', reviewStatus: 'not-run' });
    return { ok: true, code: accumulated };
}
