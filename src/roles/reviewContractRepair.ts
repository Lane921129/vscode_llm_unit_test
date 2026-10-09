import { createHash } from 'node:crypto';
import { currentTargetBudget } from '../pipeline/targetBudget';
import { ROLE_CONTRACT_VERSIONS } from './roleContracts';
import { parseTestReviewDetailed, ReviewConstraints, ReviewRejectionCode, TestReview } from './testReviewer';
import { AnalysisStageError } from '../utils/executionFailureCategory';
export type { ReviewConstraints } from './testReviewer';

export interface ReviewContractEvent {
    contractVersion: string;
    attempt: number;
    responseHash?: string;
    responseCharacters?: number;
    diagnostics?: ReviewRejectionCode[];
    result?: TestReview;
    reasonCode?: 'deadline-expired';
}

export interface ReviewContractRepairOptions {
    tests: string;
    prompt: string;
    constraints?: ReviewConstraints;
    /** Absolute deadline shared by the original request and its single correction. */
    deadlineAt: number;
    /** The caller owns request/transport/token accounting; never create a new target budget here. */
    request(prompt: string, deadlineAt: number): Promise<string>;
    checkCancelled(): void;
    event(status: 'parsed' | 'invalid-response' | 'repair-requested' | 'repair-skipped', detail: ReviewContractEvent): void;
    now?: () => number;
}

/** Call inside one ReviewSession cache operation. Only a returned contract error is retryable. */
export async function reviewWithContractRepair(options: ReviewContractRepairOptions): Promise<TestReview | undefined> {
    if (!Number.isFinite(options.deadlineAt)) { throw new TypeError('Review deadline must be finite'); }
    const now = options.now || Date.now;
    const deadlineAt = Math.min(options.deadlineAt, currentTargetBudget()?.deadlineAt ?? Infinity);
    let prompt = options.prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
        options.checkCancelled();
        currentTargetBudget()?.assertRemaining();
        if (now() >= deadlineAt) {
            options.event('repair-skipped', { contractVersion: ROLE_CONTRACT_VERSIONS.reviewer,
                attempt, reasonCode: 'deadline-expired' });
            throw new AnalysisStageError('timeout', 'reviewer', 'Reviewer deadline expired before approval.',
                { reasonCode: 'deadline-expired', attempt });
        }
        // Cancellation, transport, timeout and budget exceptions propagate without a second request.
        const raw = await options.request(prompt, deadlineAt);
        options.checkCancelled();
        currentTargetBudget()?.assertRemaining();
        if (now() >= deadlineAt) {
            options.event('repair-skipped', { contractVersion: ROLE_CONTRACT_VERSIONS.reviewer,
                attempt, reasonCode: 'deadline-expired' });
            throw new AnalysisStageError('timeout', 'reviewer', 'Reviewer deadline expired before approval.',
                { reasonCode: 'deadline-expired', attempt });
        }
        const parsed = parseTestReviewDetailed(raw, options.tests, true, options.constraints);
        options.event(parsed.review ? 'parsed' : 'invalid-response', {
            contractVersion: ROLE_CONTRACT_VERSIONS.reviewer, attempt,
            responseHash: createHash('sha256').update(raw).digest('hex'), responseCharacters: raw.length,
            diagnostics: parsed.diagnostics, ...(parsed.review ? { result: parsed.review } : {})
        });
        if (parsed.review) { return parsed.review; }
        if (attempt === 0) {
            options.event('repair-requested', { contractVersion: ROLE_CONTRACT_VERSIONS.reviewer,
                attempt: 1, diagnostics: parsed.diagnostics });
            prompt = `${options.prompt}\n\nREVIEW_CONTRACT_REPAIR_V1\n`
                + `The previous assessment failed these contract checks: ${parsed.diagnostics.join(', ')}.\n`
                + 'Fact contradictions mean the cited host AST/observation facts already establish that binding, assertion or exact-input outcome. '
                + 'Do not repeat the contradicted claim: a unittest harness is not the target class; an expected exception is not a failing test; '
                + 'verified observed values must not be replaced by guessed calculations; exact string equality must not become string ordering or loose membership. '
                + 'Verified canonical imports are legitimate bindings; dependency mock call assertions must not be replaced solely for checking calls rather than return values. '
                + 'Reassess the same TEST_FILE and evidence. Cite only VALID_TEST_LINE_IDS that demonstrate the claimed defect. '
                + 'Do not invent import/runtime failures after successful isolated execution, request target implementation edits, or mock the selected target. '
                + 'Return the existing findings JSON contract only. Omit unsupported claims; use {"findings":[]} only when no concrete defect is demonstrated. '
                + 'This is the only contract correction attempt.';
        }
    }
    return undefined;
}
