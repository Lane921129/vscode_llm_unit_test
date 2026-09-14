import { RepairFeedback } from '../validation/repairFeedback';
import { TestReview } from '../roles/testReviewer';

export interface CandidateExecution {
    ok: boolean;
    out: string;
    qualityGaps: string[];
}

export interface CandidatePipelineHooks {
    validate(code: string): Promise<string | undefined>;
    review(code: string): Promise<TestReview | undefined>;
    revise(code: string, feedback: string, role: 'writer' | 'bug-fixer'): Promise<string>;
    validateRevision?(previousCode: string, candidateCode: string, failure: string,
        role: 'writer' | 'bug-fixer'): Promise<string | undefined>;
    execute(code: string): Promise<CandidateExecution>;
    event(stage: string, status: string, detail: unknown): void;
    checkCancelled(): void;
}

/** Bounded state machine: review findings -> Writer; execution failures -> Bug Fixer. */
export async function validateTestCandidate(
    initialCode: string, hooks: CandidatePipelineHooks, maxRevisions = 2,
    baseline?: { code: string; output: string }
): Promise<{ code: string; execution: CandidateExecution; qualityIssues: string[] }> {
    let code = initialCode;
    const feedback = new RepairFeedback(baseline?.code || initialCode, baseline?.output || '');
    let retainedCode = baseline?.code || initialCode;
    let lastFailure = '';
    let role: 'writer' | 'bug-fixer' = 'writer';
    for (let attempt = 0; attempt <= maxRevisions; attempt++) {
        hooks.checkCancelled();
        if (attempt > 0) {
            const previousCode = code;
            const candidate = await hooks.revise(code, lastFailure, role);
            hooks.checkCancelled();
            hooks.event(role, 'candidate', { attempt, code: candidate });
            if (!feedback.consider(candidate)) {
                lastFailure = feedback.output;
                hooks.event(role, 'repeated', { attempt, reason: lastFailure });
                continue;
            }
            const revisionViolation = await hooks.validateRevision?.(previousCode, candidate, lastFailure, role);
            if (revisionViolation) {
                feedback.reject(revisionViolation);
                lastFailure = feedback.output;
                code = retainedCode;
                hooks.event(role, 'scope-rejected', { attempt, reason: revisionViolation });
                role = 'bug-fixer';
                continue;
            }
            code = candidate;
        }
        const invalid = await hooks.validate(code);
        hooks.event('structure', invalid ? 'rejected' : 'passed', { attempt, reason: invalid });
        if (invalid) {
            lastFailure = invalid;
            code = retainedCode;
            // Structural and evidence validation are pre-validation failures,
            // so the focused repair role owns them. Reviewer findings remain
            // Writer work below.
            role = 'bug-fixer';
            continue;
        }
        const review = await hooks.review(code);
        hooks.checkCancelled();
        // Unavailable/malformed review is explicitly unknown, never a fabricated approval.
        hooks.event('reviewer', review ? 'assessed' : 'unavailable', { attempt, review });
        const blocking = review?.issues.filter(issue => issue.severity === 'blocking') || [];
        if (blocking.length) {
            lastFailure = JSON.stringify(blocking);
            role = 'writer';
            continue;
        }
        const execution = await hooks.execute(code);
        hooks.checkCancelled();
        hooks.event('validation', execution.ok ? 'passed' : 'failed', { attempt, code, ...execution });
        const regression = feedback.record(execution.out);
        if (!regression.accepted) {
            lastFailure = feedback.output;
            code = retainedCode;
            role = 'bug-fixer';
            continue;
        }
        retainedCode = code;
        if (execution.ok) {
            return { code, execution, qualityIssues: [
                ...execution.qualityGaps,
                ...(!review ? ['Reviewer 審查未完成；工具執行通過不代表模型審查通過。'] : []),
                ...(review?.issues.filter(issue => issue.severity === 'quality').map(issue =>
                    `${issue.id}: ${issue.action}`) || [])
            ] };
        }
        lastFailure = execution.out;
        role = 'bug-fixer';
    }
    throw new Error(`測試候選未通過驗證（修訂上限 ${maxRevisions}）：${lastFailure}`);
}
