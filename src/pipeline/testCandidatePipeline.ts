import { RepairFeedback, repairFailureKey } from '../validation/repairFeedback';
import { TestReview } from '../roles/testReviewer';
import { ReviewStatus } from '../roles/reviewSession';
import { currentTargetBudget } from './targetBudget';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';

export interface CandidateExecution {
    ok: boolean;
    out: string;
    qualityGaps: string[];
    coverage?: TargetCoverageAssessment;
}

export interface CandidatePipelineHooks {
    reviewRequired?: boolean;
    validate(code: string): Promise<string | undefined>;
    review(code: string): Promise<TestReview | undefined>;
    revise(code: string, feedback: string, role: 'writer' | 'bug-fixer'): Promise<string>;
    repairRole?(code: string, failure: string): 'writer' | 'bug-fixer';
    validateRevision?(previousCode: string, candidateCode: string, failure: string,
        role: 'writer' | 'bug-fixer'): Promise<string | undefined>;
    execute(code: string): Promise<CandidateExecution>;
    executable?(code: string, execution: CandidateExecution): void | Promise<void>;
    event(stage: string, status: string, detail: unknown): void;
    checkCancelled(): void;
}

/** Execute valid candidates first; only executable tests consume a Reviewer request. */
export async function validateTestCandidate(
    initialCode: string, hooks: CandidatePipelineHooks, maxRevisions = 2,
    baseline?: { code: string; output: string }
): Promise<{
    code: string;
    execution: CandidateExecution;
    qualityIssues: string[];
    reviewWarnings: string[];
    reviewStatus: ReviewStatus;
}> {
    let code = initialCode;
    const feedback = new RepairFeedback(baseline?.code || initialCode, baseline?.output || '');
    let retainedCode = baseline?.code || initialCode;
    let lastFailure = '';
    let role: 'writer' | 'bug-fixer' = 'writer';
    const attemptedBugFixFailures = new Set<string>();
    for (let attempt = 0; attempt <= maxRevisions; attempt++) {
        hooks.checkCancelled();
        currentTargetBudget()?.consumeCandidateAttempt();
        if (attempt > 0) {
            if (role === 'bug-fixer') { role = hooks.repairRole?.(code, lastFailure) || role; }
            if (role === 'bug-fixer') {
                const failureKey = repairFailureKey(lastFailure);
                if (attemptedBugFixFailures.has(failureKey)) {
                    throw new Error(`Bug Fixer 已處理過相同失敗，停止重複修復：${lastFailure}`);
                }
                attemptedBugFixFailures.add(failureKey);
            }
            const previousCode = code;
            const candidate = await hooks.revise(code, lastFailure, role);
            hooks.checkCancelled();
            hooks.event(role, 'candidate', { attempt, code: candidate });
            if (!feedback.consider(candidate, lastFailure)) {
                lastFailure = feedback.output;
                hooks.event(role, 'repeated', { attempt, reason: lastFailure });
                if (role === 'bug-fixer') {
                    throw new Error(`Bug Fixer 未產生有效變更，停止重複修復：${lastFailure}`);
                }
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
            // A malformed file has no proven failing method to replace.
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
            // Persist independently from review acceptance and later quality measurement.
            await hooks.executable?.(code, execution);
            const review = hooks.reviewRequired === false ? undefined : await hooks.review(code);
            const reviewStatus: ReviewStatus = hooks.reviewRequired === false ? 'not-required' : review ? 'completed' : 'incomplete';
            hooks.checkCancelled();
            // Unavailable/malformed review is explicitly unknown, never a fabricated approval.
            hooks.event('reviewer', reviewStatus === 'not-required' ? 'not-required' : review ? 'assessed' : 'unavailable', { attempt, review });
            const blocking = review?.issues.filter(issue => issue.severity === 'blocking') || [];
            if (blocking.length) {
                lastFailure = JSON.stringify(blocking);
                role = 'writer';
                continue;
            }
            return {
                code,
                execution,
                reviewStatus,
                // 只有可量測的執行缺口可以啟動下一輪品質補測。
                // Only measured execution gaps may trigger another quality loop.
                qualityIssues: [...execution.qualityGaps],
                reviewWarnings: [
                ...(reviewStatus === 'incomplete' ? ['Reviewer 審查未完成；工具執行通過不代表模型審查通過。'] : []),
                ...(review?.issues.filter(issue => issue.severity === 'quality').map(issue =>
                    `${issue.id}: ${issue.action}`) || [])
                ]
            };
        }
        lastFailure = execution.out;
        // A module/fixture failure is not a failed test-method replacement.
        role = /(?:_FailedTest|ImportError:|ModuleNotFoundError:|\bin (?:setUp|tearDown)(?:Class|Module)?\b)/.test(execution.out)
            ? 'writer' : 'bug-fixer';
    }
    throw new Error(`測試候選未通過驗證（修訂上限 ${maxRevisions}）：${lastFailure}`);
}
