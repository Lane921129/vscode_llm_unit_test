import { summarizeRepairOutput } from '../validation/repairFeedback';
import { EVIDENCE_CONTRACT_VERSIONS } from '../pipeline/evidenceContracts';
import { executionFailureRepairGuidance, missingNameRepairGuidance } from '../prompts/dependencyMockContract';
import { createHash } from 'node:crypto';
import type { ReviewIssue } from './testReviewer';
import { AnalysisStageError } from '../utils/executionFailureCategory';

export const ROLE_CONTRACT_VERSIONS = {
    ...EVIDENCE_CONTRACT_VERSIONS,
    semanticPlan: 'semantic-plan-v3',
    reviewer: 'review-v8',
    qualityAnalyst: 'quality-task-v3',
    qualityAnalystGrounded: 'quality-task-v4',
    writerRevision: 'writer-revision-v2',
    bugFix: 'bug-fix-v5'
} as const;

/** The ungrounded and executed-focus paths share a shape, not a scenario contract. */
export function qualityAnalystContractVersion(grounded: boolean): 'quality-task-v3' | 'quality-task-v4' {
    return grounded ? ROLE_CONTRACT_VERSIONS.qualityAnalystGrounded : ROLE_CONTRACT_VERSIONS.qualityAnalyst;
}

/** Replace only a complete, byte-identical fenced file; never trim or slice Python. */
export function referenceRepeatedTestFile(evidence: string, code: string): string {
    if (!code.trim()) { return evidence; }
    // Consume other fenced blocks too: a matching-looking fragment inside
    // a larger source/example block must never rewrite that block's source.
    return evidence.replace(/^(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)^\1[ \t]*(?=\r?$)/gm,
        (block: string, _fence: string, language: string, body: string) =>
            ['python', 'py'].includes(language.trim()) && (body === code + '\n' || body === code + '\r\n')
                ? '[The identical complete current test file is supplied in CURRENT TEST FILE below.]' : block);
}

/** Host-owned findings from the exact executed and reviewed candidate. */
export interface WriterReviewFeedback {
    version: 'writer-review-feedback-v1';
    testHash: string;
    findings: readonly ReviewIssue[];
    methodScope: { mode: 'preserve-method-set' | 'allow-additions'; methodIds: readonly string[] };
}

/** Writer owns review, structure, fixture and multi-method execution failures. */
export function buildWriterRevisionRequest(input: {
    code: string;
    findings: string;
    moduleName: string;
    functionName: string;
    evidence: string;
    reviewFeedback?: WriterReviewFeedback;
    outputScope?: 'method-replacements';
}): string {
    const feedback = input.reviewFeedback;
    if (feedback && (feedback.version !== 'writer-review-feedback-v1'
        || feedback.testHash !== createHash('sha256').update(input.code).digest('hex')
        || !Array.isArray(feedback.findings) || feedback.findings.length < 1 || feedback.findings.length > 5
        || JSON.stringify(feedback.findings) !== input.findings
        || !feedback.methodScope || feedback.methodScope.mode !== (feedback.findings.some(item => item.category === 'missing-scenario')
            ? 'allow-additions' : 'preserve-method-set')
        || !Array.isArray(feedback.methodScope.methodIds) || !feedback.methodScope.methodIds.length
        || feedback.methodScope.methodIds.length > 256
        || feedback.methodScope.methodIds.some(id => typeof id !== 'string' || !id.trim() || /[\r\n]/.test(id))
        || new Set(feedback.methodScope.methodIds).size !== feedback.methodScope.methodIds.length)) {
        throw new AnalysisStageError('validation', 'writer-review-feedback', 'Review feedback does not match this candidate and findings.',
            { reasonCode: 'review-feedback-identity-mismatch' });
    }
    // Structured review evidence is indivisible. The final request budget must
    // accommodate the whole packet or reject it; never summarize nested JSON.
    const findings = feedback ? 'HOST_REVIEW_FINDINGS_V1\n' + JSON.stringify(feedback)
        : summarizeRepairOutput(referenceRepeatedTestFile(input.findings, input.code), 3500);
    const repairGuidance = feedback ? '' : [missingNameRepairGuidance(input.findings), executionFailureRepairGuidance(input.findings)]
        .filter(Boolean).join('\n');
    return `WRITER_REVISION_REQUEST_V2
=== TARGET ===
Module: ${input.moduleName}
Function: ${input.functionName}

=== REVIEW OR STRUCTURE FINDINGS ===
${findings}${repairGuidance ? '\n' + repairGuidance : ''}

=== CURRENT TEST FILE ===
\`\`\`python
${input.code}
\`\`\`

=== VERIFIED CONTEXT ===
${referenceRepeatedTestFile(input.evidence, input.code)}

RESPONSE:
${input.outputScope === 'method-replacements'
    ? 'Return only the methods named by WRITER_METHOD_EDIT_V1, inside their existing class-name wrappers in one Python fence. Keep signatures and decorators; no module imports, fixtures, new methods or unrelated code.'
    : 'Return the complete corrected unittest file. Preserve passing tests and verified assertions. Address only the supplied findings; do not invent behavior.'}`;
}
