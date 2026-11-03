import type { ReviewEvidenceBasis } from '../roles/reviewEvidenceBasis';

/** Explicit current-contract semantic advice, never an asserted tool fact. */
export const testCodeBasis = (line: string | number): ReviewEvidenceBasis => ({
    kind: 'test-code', ref: typeof line === 'number' ? `L${line}` : line, field: 'judgment', value: 'unverified'
});
