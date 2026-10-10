import { summarizeRepairOutput } from '../validation/repairFeedback';
import { EVIDENCE_CONTRACT_VERSIONS } from '../pipeline/evidenceContracts';

export const ROLE_CONTRACT_VERSIONS = {
    ...EVIDENCE_CONTRACT_VERSIONS,
    reviewer: 'review-v7',
    qualityAnalyst: 'quality-task-v3',
    writerRevision: 'writer-revision-v2',
    bugFix: 'bug-fix-v5'
} as const;

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
${summarizeRepairOutput(referenceRepeatedTestFile(input.findings, input.code), 3500)}

=== CURRENT TEST FILE ===
\`\`\`python
${input.code}
\`\`\`

=== VERIFIED CONTEXT ===
${referenceRepeatedTestFile(input.evidence, input.code)}

RESPONSE:
Return the complete corrected unittest file. Preserve passing tests and verified assertions. Address only the supplied findings; do not invent behavior.`;
}
