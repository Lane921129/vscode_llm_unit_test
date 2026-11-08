import { currentStopPolicy } from './stopPolicy';
import { localize } from '../i18n/core';
import { RepairFeedback, repairFailureKey } from '../validation/repairFeedback';
import { TestReview } from '../roles/testReviewer';
import { ReviewStatus } from '../roles/reviewSession';
import { currentTargetBudget } from './targetBudget';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';
import { RepairDiagnostic, RepairResponseError, repairHash, repairReasonCode } from './repairDiagnostics';
import { ROLE_CONTRACT_VERSIONS } from '../roles/roleContracts';
import type { CandidateRejectionGate } from './rejectedCandidateStore';
import { AnalysisStageError, classifyExecutionFailure, isModelContentFormatError } from '../utils/executionFailureCategory';
import { wholeCandidateNameException } from '../validation/unittestException';
import { isMockInitializationFailure } from '../roles/bugFixer';
import { writerMethodEditFormatGuidance } from '../validation/writerMethodEdits';

export interface CandidateExecution {
    ok: boolean;
    out: string;
    qualityGaps: string[];
    coverage?: TargetCoverageAssessment;
    /** Generated candidate modules change between attempts; testcase identity must not. */
    testModule?: string;
    /** Host-verified loader failure; it has no replaceable failing test method. */
    repairRole?: 'writer';
}

/** The application preflight already ran; candidate import/setup errors belong to the Writer. */
export class CandidateValidationError extends Error {
    readonly category = 'validation';
    readonly stage = 'candidate-validation';
    constructor(message: string) { super(message); this.name = 'CandidateValidationError'; }
}

export interface CandidatePipelineHooks {
    reviewRequired?: boolean;
    /** Execution-only, before any native attempt: revise the latest unapproved
     * structure draft without promoting it to a retained/executable baseline. */
    continueUnexecutedWriterDraft?: boolean;
    validate(code: string): Promise<string | { reason: string; gate: CandidateRejectionGate; reasonCode: string } | undefined>;
    review(code: string): Promise<TestReview | undefined>;
    revise(code: string, feedback: string, role: 'writer' | 'bug-fixer', attempt: number, repairEvidence?: string): Promise<string>;
    repairRole?(code: string, failure: string): 'writer' | 'bug-fixer';
    /** Bounded observed evidence for an AI revision; this hook cannot replace candidate code. */
    repairEvidence?(code: string, failure: string): Promise<string | undefined>;
    /** Legacy diagnostic-only correction; never used when Reviewer approval is required. */
    repairExpectations?(code: string, failure: string): Promise<{ code: string; evidence: unknown } | undefined>;
    validateRevision?(previousCode: string, candidateCode: string, failure: string,
        role: 'writer' | 'bug-fixer'): Promise<string | { reason: string; reasonCode: string } | undefined>;
    execute(code: string): Promise<CandidateExecution>;
    executable?(code: string, execution: CandidateExecution): void | Promise<void>;
    /** Records the rejected version before restoring a retained baseline. */
    rejectedCandidate?(code: string, attempt: number, gate: CandidateRejectionGate, reasonCode: string): void | Promise<void>;
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
    /** Exact candidate approved by a valid, zero-finding review; absent in diagnostic mode. */
    approvedCodeHash?: string;
}> {
    const policy = currentStopPolicy();
    const reject = async (candidate: string, attempt: number, gate: CandidateRejectionGate, reasonCode: string) => {
        await hooks.rejectedCandidate?.(candidate, attempt, gate, reasonCode);
        if (!/tool|scope-result-invalid|preservation-tool-error|source-changed/.test(reasonCode)) { policy?.reject(reasonCode); }
    };
    let code = initialCode;
    const feedback = new RepairFeedback(baseline?.code || initialCode, baseline?.output || '');
    let retainedCode = baseline?.code || initialCode;
    let lastFailure = '';
    let role: 'writer' | 'bug-fixer' = 'writer';
    let revisionLimit = maxRevisions;
    let writerRecoveryUsed = false;
    let writerRecoveryPending = false;
    let executionFailure = false;
    let executionRepairRole: 'writer' | undefined;
    let toolRepairAttempts = 0;
    let unresolvedReview = false;
    let executionAttempted = Boolean(baseline);
    // One reserved handoff after a no-op or unusable method repair response.
    // It still consumes the enclosing target's candidate/request/time budgets.
    const recoverWithWriter = (attempt: number, reasonCode: 'repeated-candidate' | 'no-method-change' | 'response-format'): boolean => {
        if (!policy && (writerRecoveryUsed || maxRevisions < 1)) { return false; }
        writerRecoveryUsed = true;
        writerRecoveryPending = true;
        revisionLimit = Math.max(revisionLimit, attempt + 1);
        code = retainedCode;
        role = 'writer';
        lastFailure = 'FOCUSED REPAIR MADE NO EFFECTIVE CHANGE. Reassess the failing test using the supplied source and failure. '
            + 'Recalculate source-supported deterministic expectations; actual output alone is not an oracle. '
            + 'Preserve all passing cases and verified assertions. Keep the target real. Return the complete test file.\n'
            + lastFailure;
        hooks.event('repair-routing', 'selected', { attempt, action: 'writer-recovery', reasonCode,
            nextAttempt: attempt + 1, revisionLimit, previousTestUnchanged: true });
        return true;
    };
    const attemptedBugFixFailures = new Set<string>();
    const preferWholeCandidateRepair = (failure: string, attempt: number): boolean => {
        if (isMockInitializationFailure(code, failure)) {
            hooks.event('repair-routing', 'selected', { attempt, action: 'writer-fixture-setup',
                reasonCode: 'mock-initialization-failed', previousTestHash: repairHash(code) });
            return true;
        }
        const exceptionType = wholeCandidateNameException(failure);
        if (!exceptionType) { return false; }
        hooks.event('repair-routing', 'selected', { attempt, action: 'writer-name-binding', reasonCode: 'execution-name-binding',
            exceptionType, previousTestHash: repairHash(code) });
        return true;
    };
    for (let attempt = 0; policy ? (policy.remainingFailures > 0 && attempt <= Math.max(revisionLimit, policy.settings.failureLimit * 3)) : attempt <= revisionLimit; attempt++) {
        hooks.checkCancelled();
        policy?.beginAttempt();
        currentTargetBudget()?.consumeCandidateAttempt();
        const writerRecoveryAttempt = writerRecoveryPending;
        writerRecoveryPending = false;
        if (attempt > 0) {
            let verifiedRepairEvidence: string | undefined;
            if (executionFailure && hooks.repairEvidence) {
                const evidence = await hooks.repairEvidence(code, lastFailure);
                hooks.checkCancelled();
                if (evidence?.trim()) {
                    const bytes = Buffer.byteLength(evidence, 'utf8');
                    // Never truncate a structured observation into misleading partial evidence.
                    if (bytes <= 8192) {
                        verifiedRepairEvidence = evidence;
                        hooks.event('repair-evidence', 'provided', { attempt, bytes });
                    } else {
                        hooks.event('repair-evidence', 'omitted', { attempt, bytes, reasonCode: 'evidence-budget' });
                    }
                }
            }
            const arithmetic = hooks.reviewRequired === false && !hooks.repairEvidence
                && executionRepairRole !== 'writer' && executionFailure && toolRepairAttempts < 2 && hooks.repairExpectations
                ? (toolRepairAttempts++, await hooks.repairExpectations(code, lastFailure)) : undefined;
            executionFailure = false;
            hooks.checkCancelled();
            if (!arithmetic && role === 'bug-fixer') {
                role = executionRepairRole === 'writer' || preferWholeCandidateRepair(lastFailure, attempt)
                    ? 'writer' : hooks.repairRole?.(code, lastFailure) || role;
            }
            if (!arithmetic && role === 'bug-fixer') {
                const failureKey = repairFailureKey(lastFailure);
                if (!policy && attemptedBugFixFailures.has(failureKey)) {
                    hooks.event(role, 'repair-rejected', { attempt, category: 'validation', contractVersion: ROLE_CONTRACT_VERSIONS.bugFix,
                        diagnostic: { version: 'repair-diagnostics-v1', gate: 'candidate-deduplication',
                            reasonCodes: ['repeated-failure'], previousTestHash: repairHash(code), previousTestUnchanged: true } satisfies RepairDiagnostic });
                    throw new CandidateValidationError(localize("Bug Fixer 已處理過相同失敗，停止重複修復：{0}", lastFailure));
                }
                attemptedBugFixFailures.add(failureKey);
            }
            const previousCode = code;
            let candidate: string;
            try {
                candidate = arithmetic?.code ?? await hooks.revise(code, lastFailure, role, attempt, verifiedRepairEvidence);
            } catch (error) {
                hooks.checkCancelled();
                if (policy && (error instanceof RepairResponseError
                    || isModelContentFormatError(error))) {
                    const reasonCode = error instanceof AnalysisStageError && error.stage === 'writer-method-edit-scope'
                        && error.diagnostic && typeof error.diagnostic === 'object'
                        ? (error.diagnostic as { reasonCode?: unknown }).reasonCode : undefined;
                    const guidance = writerMethodEditFormatGuidance(reasonCode);
                    await reject('', attempt, 'response-format', guidance ? String(reasonCode) : 'response-format');
                    lastFailure = 'FORMAT REPAIR: ' + (guidance || 'Return valid Python within the original edit scope.') + ' ' + lastFailure;
                    continue;
                }
                if (role === 'bug-fixer' && error instanceof RepairResponseError) {
                    await reject('', attempt, 'response-format',
                        error.diagnostic.reasonCodes[0] || 'response-format');
                    if (recoverWithWriter(attempt, 'response-format')) { continue; }
                }
                throw error;
            }
            hooks.checkCancelled();
            hooks.event(arithmetic ? 'source-expectation-repair' : role, 'candidate', {
                attempt, code: candidate, ...(arithmetic ? { evidence: arithmetic.evidence } : {}) });
            if (!feedback.consider(candidate, lastFailure)) {
                await reject(candidate, attempt, 'candidate-deduplication', 'repeated-candidate');
                lastFailure = feedback.output;
                hooks.event(role, 'repeated', { attempt, reason: lastFailure, category: 'validation', contractVersion: role === 'bug-fixer'
                    ? ROLE_CONTRACT_VERSIONS.bugFix : ROLE_CONTRACT_VERSIONS.writerRevision,
                    diagnostic: { version: 'repair-diagnostics-v1', gate: 'candidate-deduplication',
                        reasonCodes: ['repeated-candidate'], previousTestHash: repairHash(previousCode),
                        candidateTestHash: repairHash(candidate), previousTestUnchanged: true } satisfies RepairDiagnostic });
                if (role === 'bug-fixer') {
                    if (recoverWithWriter(attempt, 'repeated-candidate')) { continue; }
                    throw new CandidateValidationError(localize("Bug Fixer 未產生有效變更，停止重複修復：{0}", lastFailure));
                }
                if (policy) { code = retainedCode; lastFailure = 'Repeated candidate: change the rejected cause. ' + lastFailure; continue; }
                break;
            }
            if (arithmetic) {
                // Tool work has its own bounded allowance; retain the model's
                // revisions while still charging the target candidate/time budget.
                revisionLimit++;
            }
            const scopeStarted = Date.now();
            const revisionViolation = arithmetic ? undefined : await hooks.validateRevision?.(previousCode, candidate, lastFailure, role);
            if (revisionViolation) {
                const reason = typeof revisionViolation === 'string' ? revisionViolation : revisionViolation.reason;
                const toolReason = typeof revisionViolation !== 'string' ? revisionViolation.reasonCode : undefined;
                if (toolReason && ['scope-tool-error', 'scope-result-invalid', 'preservation-tool-error'].includes(toolReason)) {
                    await reject(candidate, attempt, 'revision-scope', toolReason);
                    hooks.event('revision-validation', 'tool-failed', { attempt, reasonCode: toolReason, category: 'validation' });
                    throw new AnalysisStageError('tool', 'repair-scope', localize('修訂驗證工具無法完成；未繼續模型修復或降級 Tier。'),
                        { reasonCode: toolReason });
                }
                if (policy && !['candidate-syntax', 'no-method-change', 'edit-no-method-change', 'invalid-edit-python'].includes(toolReason || '')) {
                    throw new AnalysisStageError('validation', 'repair-scope', reason,
                        { reasonCode: toolReason || 'scope-rejected', previousTestUnchanged: true });
                }
                await reject(candidate, attempt, 'revision-scope',
                    repairReasonCode(typeof revisionViolation === 'string' ? undefined : revisionViolation.reasonCode));
                feedback.reject(reason);
                lastFailure = feedback.output;
                code = retainedCode;
                hooks.event(role, 'scope-rejected', { attempt, reason, category: 'validation', elapsedMs: Date.now() - scopeStarted,
                    contractVersion: ROLE_CONTRACT_VERSIONS.bugFix,
                    diagnostic: { version: 'repair-diagnostics-v1', gate: 'repair-scope',
                        reasonCodes: [repairReasonCode(typeof revisionViolation === 'string' ? undefined : revisionViolation.reasonCode)],
                        previousTestHash: repairHash(previousCode), candidateTestHash: repairHash(candidate),
                        previousTestUnchanged: true } satisfies RepairDiagnostic });
                if (role === 'bug-fixer' && typeof revisionViolation !== 'string'
                    && revisionViolation.reasonCode === 'no-method-change'
                    && recoverWithWriter(attempt, 'no-method-change')) { continue; }
                hooks.event('repair-routing', 'selected', { attempt, action: attempt < maxRevisions ? 'continue-repair' : 'stop-revisions',
                    previousTestUnchanged: true });
                role = unresolvedReview ? 'writer' : 'bug-fixer';
                continue;
            }
            code = candidate;
        }
        const invalid = await hooks.validate(code);
        const invalidReason = typeof invalid === 'string' ? invalid : invalid?.reason;
        hooks.event('structure', invalid ? 'rejected' : 'passed', { attempt, reason: invalidReason });
        if (invalid) {
            executionRepairRole = undefined;
            unresolvedReview = false;
            await reject(code, attempt,
                typeof invalid === 'string' ? 'unittest-structure' : invalid.gate,
                typeof invalid === 'string' ? 'candidate-structure-rejected' : invalid.reasonCode);
            lastFailure = invalidReason!;
            if (hooks.reviewRequired === false && hooks.continueUnexecutedWriterDraft === true
                && !executionAttempted && !baseline && role === 'writer') {
                if (code !== retainedCode) {
                    hooks.event('writer-draft', 'continued', { attempt, codeHash: repairHash(code),
                        retainedCodeHash: repairHash(retainedCode), reasonCode: 'unexecuted-structure-repair',
                        executable: false, approved: false, executionAttempted: false });
                }
            } else { code = retainedCode; }
            // A malformed file has no proven failing method to replace.
            role = 'writer';
            if (writerRecoveryAttempt && !policy) { break; }
            continue;
        }
        if (policy && !policy.firstExecution(repairHash(code))) {
            await reject(code, attempt, 'candidate-deduplication', 'repeated-candidate');
            lastFailure = 'Repeated candidate: this exact candidate was already executed. Change the rejected cause using existing evidence.';
            role = 'writer';
            continue;
        }
        executionAttempted = true;
        const execution = await hooks.execute(code);
        executionRepairRole = execution.ok ? undefined : execution.repairRole;
        hooks.checkCancelled();
        hooks.event('validation', execution.ok ? 'passed' : 'failed', { attempt, code, ...execution });
        const regression = feedback.record(execution.out, execution.testModule);
        if (!regression.accepted) {
            unresolvedReview = false;
            await reject(code, attempt, 'execution', 'candidate-regression');
            lastFailure = feedback.output;
            code = retainedCode;
            role = executionRepairRole === 'writer' ? 'writer' : 'bug-fixer';
            if (writerRecoveryAttempt && !policy) { break; }
            continue;
        }
        retainedCode = code;
        if (execution.ok) {
            // Persist independently from review acceptance and later quality measurement.
            await hooks.executable?.(code, execution);
            let review: TestReview | undefined;
            if (hooks.reviewRequired !== false) {
                try {
                    review = await hooks.review(code);
                } catch (error) {
                    hooks.checkCancelled();
                    const message = error instanceof Error ? error.message : String(error);
                    const category = error instanceof AnalysisStageError ? error.category : classifyExecutionFailure(message);
                    hooks.event('reviewer', 'failed', { attempt, category, reasonCode: 'review-request-failed' });
                    if (!(error instanceof AnalysisStageError)) { await reject(code, attempt, 'review', 'review-request-failed'); }
                    if (error instanceof AnalysisStageError) {
                        throw new AnalysisStageError(error.category, 'reviewer', error.message, error.diagnostic);
                    }
                    throw new AnalysisStageError(category, 'reviewer', message);
                }
            }
            const reviewStatus: ReviewStatus = hooks.reviewRequired === false ? 'not-required' : 'completed';
            hooks.checkCancelled();
            hooks.event('reviewer', reviewStatus === 'not-required' ? 'not-required' : review ? 'assessed' : 'unavailable', { attempt, review });
            if (hooks.reviewRequired !== false && !review) {
                await reject(code, attempt, 'review', 'review-unavailable');
                throw new AnalysisStageError('validation', 'reviewer',
                    localize("Reviewer 審查未完成；工具執行通過不代表模型審查通過。"),
                    { reasonCode: 'review-unavailable', attempt });
            }
            if (review?.issues.length) {
                unresolvedReview = true;
                const reviewReasonCode = review.issues.some(issue => issue.severity === 'blocking') ? 'review-blocking' : 'review-quality';
                if (review.basisFormatDiagnostics?.length) {
                    await hooks.rejectedCandidate?.(code, attempt, 'review', reviewReasonCode);
                } else {
                    await reject(code, attempt, 'review', reviewReasonCode);
                }
                lastFailure = JSON.stringify(review.issues);
                role = 'writer';
                if (writerRecoveryAttempt && !policy) { break; }
                continue;
            }
            const approvedCodeHash = reviewStatus === 'completed' ? repairHash(code) : undefined;
            if (approvedCodeHash) { hooks.event('reviewer', 'approved', { attempt, approvedCodeHash }); }
            return {
                code,
                execution,
                reviewStatus,
                approvedCodeHash,
                qualityIssues: [...execution.qualityGaps],
                reviewWarnings: []
            };
        }
        unresolvedReview = false;
        await reject(code, attempt, 'execution', 'candidate-execution-failed');
        lastFailure = execution.out;
        executionFailure = true;
        if (writerRecoveryAttempt && !policy) { break; }
        // A module/fixture failure is not a failed test-method replacement.
        role = executionRepairRole === 'writer' || preferWholeCandidateRepair(execution.out, attempt)
            || /(?:_FailedTest|ImportError:|ModuleNotFoundError:|\bin (?:setUp|tearDown)(?:Class|Module)?\b)/.test(execution.out)
            ? 'writer' : 'bug-fixer';
    }
    const failureDetail = lastFailure.startsWith('NO CHANGE:')
        ? `${localize("沒有有效修改：測試修訂產生了相同候選，停止重複修復。")}\n${lastFailure}`
        : lastFailure;
    const reason = localize("測試候選未通過驗證（修訂上限 {0}{1}）：{2}", maxRevisions, writerRecoveryUsed ? localize("，已使用一次 Writer 接手") : '', failureDetail);
    if (unresolvedReview) {
        throw new AnalysisStageError('validation', 'reviewer', reason, { reasonCode: 'review-revisions-exhausted' });
    }
    throw new CandidateValidationError(reason);
}
