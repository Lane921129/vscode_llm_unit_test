import { summarizeRepairOutput } from '../validation/repairFeedback';
import { EVIDENCE_CONTRACT_VERSIONS } from '../pipeline/evidenceContracts';

export const ROLE_CONTRACT_VERSIONS = {
    ...EVIDENCE_CONTRACT_VERSIONS,
    reviewer: 'review-v6',
    qualityAnalyst: 'quality-task-v2',
    writerRevision: 'writer-revision-v2',
    bugFix: 'bug-fix-v3'
} as const;

/** Writer owns review, structure, fixture and multi-method execution failures. */
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
