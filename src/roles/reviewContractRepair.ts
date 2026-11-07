import { currentStopPolicy } from '../pipeline/stopPolicy';
import { createHash } from 'node:crypto';
import { currentTargetBudget } from '../pipeline/targetBudget';
import { ROLE_CONTRACT_VERSIONS } from './roleContracts';
import { parseTestReviewDetailed, projectRejectedReviewFindings, RejectedReviewFinding,
    reviewContextDiagnostic, ReviewConstraints, ReviewRejectionCode, TestReview } from './testReviewer';
import { reviewEvidenceBasisRepairHints } from './reviewEvidenceBasis';
import { redactCredentialStrings } from '../pipeline/artifactSafety';
import { AnalysisStageError, isModelContentFormatError } from '../utils/executionFailureCategory';
export type { ReviewConstraints } from './testReviewer';

export interface ReviewContractEvent {
    contractVersion: string;
    attempt: number;
    responseHash?: string;
    responseCharacters?: number;
    diagnostics?: ReviewRejectionCode[];
    result?: TestReview;
    /** Diagnostic claims only; rejected assessments never become candidate approval. */
    rejectedFindings?: RejectedReviewFinding[];
    reasonCode?: 'deadline-expired' | 'invalid-host-evidence';
}

export interface ReviewContractRepairOptions {
    tests: string;
    prompt: string;
    constraints?: ReviewConstraints;
    knownSecrets?: readonly string[];
    /** Absolute deadline shared by the original request and all allowed corrections. */
    deadlineAt: number;
    /** The caller owns request/transport/token accounting; never create a new target budget here. */
    request(prompt: string, deadlineAt: number): Promise<string>;
    checkCancelled(): void;
    event(status: 'parsed' | 'invalid-response' | 'repair-requested' | 'repair-skipped', detail: ReviewContractEvent): void;
    now?: () => number;
}

function correctionPrompt(options: ReviewContractRepairOptions, diagnostics: ReviewRejectionCode[],
    findings: RejectedReviewFinding[]): string {
    const hints = reviewEvidenceBasisRepairHints(findings.flatMap(item =>
        item.basis && item.test_line && /^L[1-9]\d*$/.test(item.test_line)
            ? [{ line: Number(item.test_line.slice(1)), basis: item.basis }] : []), options.constraints?.facts);
    const guidance: Partial<Record<ReviewRejectionCode, string>> = {
        'evidence-reference-missing': 'The requested fact or field is absent. Copy an existing field and exact scalar from HOST_VERIFIED_REVIEW_FACTS; field="judgment" belongs only to kind="test-code", ref=test_line, value="unverified".',
        'evidence-reference-unrelated': 'The cited fact does not apply to test_line. Cite a relevant fact and a VALID_TEST_LINE_IDS line demonstrating the same defect.',
        'evidence-fact-contradiction': 'Copy the exact supplied scalar value, including boolean spelling; do not reverse a host fact to support a claim.',
        'requirement-evidence-missing': 'Only AVAILABLE_REQUIREMENT_IDS below and their exact supplied statements are independent requirements. Probe case IDs identify observations, not R requirements. For your interpretation of a source-shown missing case, use kind="test-code", ref=the actual test_line L-number, field="judgment", value="unverified". Do not invent an R-id or promote an observation into a business requirement.',
        'existing-import-contradiction': 'The candidate already imported successfully. Used harness/target imports are not missing or unused; verified canonical imports are valid bindings.',
        'existing-harness-contradiction': 'The executed AST-resolved unittest TestCase/IsolatedAsyncioTestCase is valid. unittest.mock supplies mocks, not a replacement framework.',
        'existing-definition-contradiction': 'The cited definition already exists in this candidate. Requesting that same definition changes nothing.',
        'target-binding-contradiction': 'Use the supplied canonical binding; a unittest harness is not the target owner. From-module and module-qualified calls are both valid.',
        'observed-outcome-contradiction': 'The exact input has a verified observed outcome. Do not replace it with guessed calculations, a guessed exception or another input\'s result.',
        'observed-assertion-verification-contradiction': 'The exact-input assertion already matches the verified observation. Independent requirements remain reviewable, but do not claim that observation is absent.',
        'expected-fixed-value-contradiction': 'expectedOrigin=static-literal establishes a fixed literal or local literal alias, not a runtime calculation or independent business requirement.',
        'expected-literal-type-contradiction': 'Preserve the supplied literal type; do not replace a scalar with a mock or demand an unspecified fixed replacement.',
        'expected-exception-contradiction': 'An evidenced assertRaises checks the expected exception; it is not an uncaught setup failure.',
        'existing-assertion-contradiction': 'A proposal identical to the AST-owned assertion or existing patch changes nothing. Identify a concrete defect instead.',
        'assertion-weakening': 'Do not weaken exact string equality into ordering or loose membership.',
        'exception-evidence-missing': 'A return-to-exception proposal needs the exact input, concrete exception class and supplied source/contract or controlled observation basis.',
        'target-self-mock': 'Keep the selected target real; only source-shown external dependency boundaries may be controlled.',
        'target-implementation-edit': 'Findings may request test-only corrections, never changes to the target implementation.'
    };
    return options.prompt + '\n\nREVIEW_CONTRACT_REPAIR_V1\n'
        + `The previous assessment failed these contract checks: ${diagnostics.join(', ')}.\n`
        + 'Reassess the SAME TEST_FILE and complete evidence above. Every finding needs category, test_line, reason, action and basis {kind,ref,field,value}. '
        + 'For host facts, use only an existing id, present field and exact scalar value. Semantic test-code advice uses ref=test_line, field="judgment", value="unverified". Unknown evidence is not a proven wrong value. '
        + 'Keep all original review rules; give a concrete defect and actionable test-only correction, never generic advice or copied instructions. '
        + (findings.length ? '\nREJECTED_PREVIOUS_ASSESSMENT_V1 (bounded diagnostic projection, NOT accepted findings):\n'
            + JSON.stringify(findings) + '\nUse this record to locate the invalid fields, then reassess each claim against the full evidence. '
            + 'Do not retain unsupported claims merely to fix their format.\n' : '\n')
        + 'AVAILABLE_REQUIREMENT_IDS: ' + JSON.stringify(options.constraints?.requirements?.items.map(item => item.id) || []) + '\n'
        + (hints.length ? '\nREJECTED_BASIS_FIELD_HINTS_V1 (field availability only; no finding is endorsed):\n' + JSON.stringify(hints) + '\n' : '\n')
        + diagnostics.flatMap(code => guidance[code] ? [guidance[code]] : []).join('\n')
        + '\nCite only VALID_TEST_LINE_IDS showing the defect. Return one complete findings JSON contract, with no prose. '
        + 'For a missing scenario, cite a target call or assertion inside an existing test method and name the concrete additional input; imports and main blocks do not demonstrate a scenario gap. '
        + 'Omit unsupported claims; the findings array is empty only when no concrete defect is demonstrated. '
        + 'This correction shares the original deadline and remaining target failure/request budgets.';
}

/** Call inside one ReviewSession cache operation. Only a returned contract error is retryable. */
export async function reviewWithContractRepair(options: ReviewContractRepairOptions): Promise<TestReview | undefined> {
    if (!Number.isFinite(options.deadlineAt)) { throw new TypeError('Review deadline must be finite'); }
    const now = options.now || Date.now;
    const deadlineAt = Math.min(options.deadlineAt, currentTargetBudget()?.deadlineAt ?? Infinity);
    const checkContext = (attempt: number) => {
        const contextFailure = reviewContextDiagnostic(options.tests, options.constraints);
        if (!contextFailure) { return; }
        options.event('repair-skipped', { contractVersion: ROLE_CONTRACT_VERSIONS.reviewer,
            attempt, reasonCode: 'invalid-host-evidence', diagnostics: [contextFailure] });
        throw new AnalysisStageError('tool', 'reviewer-evidence', 'Reviewer host evidence is invalid; model correction cannot repair it.',
            { reasonCode: 'invalid-host-evidence', diagnostics: [contextFailure] });
    };
    let prompt = options.prompt;
    for (let attempt = 0; currentStopPolicy() ? currentStopPolicy()!.remainingFailures > 0 : attempt < 2; attempt++) {
        currentStopPolicy()?.beginAttempt();
        options.checkCancelled();
        currentTargetBudget()?.assertRemaining();
        if (now() >= deadlineAt) {
            options.event('repair-skipped', { contractVersion: ROLE_CONTRACT_VERSIONS.reviewer,
                attempt, reasonCode: 'deadline-expired' });
            throw new AnalysisStageError('timeout', 'reviewer', 'Reviewer deadline expired before approval.',
                { reasonCode: 'deadline-expired', attempt });
        }
        checkContext(attempt);
        // Cancellation, transport, timeout and budget exceptions propagate without a second request.
        let raw: string;
        try { raw = await options.request(prompt, deadlineAt); }
        catch (error) {
            if (!isModelContentFormatError(error) || !currentStopPolicy()) { throw error; }
            currentStopPolicy()!.reject('review-response-format');
            prompt = options.prompt + '\nReturn only the complete review JSON contract; omit commentary.';
            continue;
        }
        options.checkCancelled();
        currentTargetBudget()?.assertRemaining();
        if (now() >= deadlineAt) {
            options.event('repair-skipped', { contractVersion: ROLE_CONTRACT_VERSIONS.reviewer,
                attempt, reasonCode: 'deadline-expired' });
            throw new AnalysisStageError('timeout', 'reviewer', 'Reviewer deadline expired before approval.',
                { reasonCode: 'deadline-expired', attempt });
        }
        checkContext(attempt);
        const parsed = parseTestReviewDetailed(raw, options.tests, true, options.constraints);
        const rejectedFindings = parsed.review ? [] : projectRejectedReviewFindings(raw, options.tests, options.knownSecrets);
        options.event(parsed.review ? 'parsed' : 'invalid-response', {
            contractVersion: ROLE_CONTRACT_VERSIONS.reviewer, attempt,
            responseHash: createHash('sha256').update(raw).digest('hex'), responseCharacters: raw.length,
            diagnostics: parsed.diagnostics, ...(parsed.review
                ? { result: redactCredentialStrings(parsed.review, options.knownSecrets) as TestReview }
                : rejectedFindings.length ? { rejectedFindings } : {})
        });
        if (parsed.review) { return parsed.review; }
        currentStopPolicy()?.reject('review-response-format');
        if (currentStopPolicy() || attempt === 0) {
            options.event('repair-requested', { contractVersion: ROLE_CONTRACT_VERSIONS.reviewer,
                attempt: attempt + 1, diagnostics: parsed.diagnostics });
            prompt = correctionPrompt(options, parsed.diagnostics, rejectedFindings);
        }
    }
    return undefined;
}
