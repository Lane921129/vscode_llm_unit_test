import { createHash } from 'node:crypto';
import { localize } from '../i18n/core';
import { AnalysisStageError } from '../utils/executionFailureCategory';

export const AI_WORKFLOW_VERSION = 'ai-reviewed-loop-v1';
export interface ReviewApproval {
    workflowVersion: typeof AI_WORKFLOW_VERSION;
    runId: string; sourceHash: string; target: string; testHash: string;
}

/** Mutation must use the exact candidate independently executed and approved by the Reviewer. */
export function requireReviewApproval(
    code: string, approval: ReviewApproval | undefined,
    expected: { runId: string; sourceHash: string; target: string }
): void {
    if (!approval || approval.workflowVersion !== AI_WORKFLOW_VERSION
        || approval.runId !== expected.runId || approval.sourceHash !== expected.sourceHash
        || approval.target !== expected.target
        || approval.testHash !== createHash('sha256').update(code).digest('hex')) {
        throw new AnalysisStageError('validation', 'reviewer',
            localize('此候選尚未取得有效審查批准；突變測試未執行。'));
    }
}
