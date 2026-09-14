import { summarizeRepairOutput } from '../validation/repairFeedback';

export const ROLE_CONTRACT_VERSIONS = {
    reviewer: 'review-v3',
    writerRevision: 'writer-revision-v2',
    bugFix: 'bug-fix-v3'
} as const;

/** Explicit Writer handoff used only for Reviewer/structure findings. */
export function buildWriterRevisionRequest(input: {
    code: string;
    findings: string;
    moduleName: string;
    functionName: string;
    evidence: string;
}): string {
    return `WRITER_REVISION_REQUEST_V2
=== TARGET ===
Module: ${input.moduleName}
Function: ${input.functionName}

=== REVIEW OR STRUCTURE FINDINGS ===
${summarizeRepairOutput(input.findings, 3500)}

=== CURRENT TEST FILE ===
\`\`\`python
${input.code}
\`\`\`

=== VERIFIED CONTEXT ===
${input.evidence}

RESPONSE:
Return the complete corrected unittest file. Preserve passing tests and verified assertions. Address only the supplied findings; do not invent behavior.`;
}
