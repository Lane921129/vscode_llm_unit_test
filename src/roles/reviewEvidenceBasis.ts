import type { ReviewFactIdentity, ReviewFacts } from './reviewFacts';

export const REVIEW_BASIS_KINDS = ['host-fact', 'evidence-gap', 'test-code', 'requirement'] as const;
export interface ReviewEvidenceBasis {
    kind: typeof REVIEW_BASIS_KINDS[number];
    ref: string;
    field: string;
    /** Exact scalar spelling from host facts, never an interpreted expression. */
    value: string;
}
export interface ReviewRequirements extends ReviewFactIdentity {
    items: Array<{ id: string; statement: string }>;
}
export function validReviewRequirements(requirements: ReviewRequirements, identity?: ReviewFactIdentity): boolean {
    return !!identity && Object.keys(requirements).length === 4
        && Object.keys(requirements).every(key => ['runId', 'sourceHash', 'target', 'items'].includes(key))
        && requirements.runId === identity.runId && requirements.sourceHash === identity.sourceHash
        && requirements.target === identity.target && Array.isArray(requirements.items) && requirements.items.length <= 64
        && requirements.items.every(item => item && Object.keys(item).length === 2
            && Object.keys(item).every(key => ['id', 'statement'].includes(key))
            && /^R[0-9a-f]{16}$/.test(item.id) && typeof item.statement === 'string'
            && !!item.statement.trim() && item.statement.length <= 600)
        && new Set(requirements.items.map(item => item.id)).size === requirements.items.length;
}
export type ReviewBasisRejection = 'missing-evidence-basis' | 'invalid-evidence-basis'
    | 'evidence-reference-missing' | 'evidence-reference-unrelated' | 'evidence-fact-contradiction'
    | 'requirement-evidence-missing' | 'requirement-identity-mismatch';

/** One provider-neutral shape; transport validation never proves the judgment. */
export const REVIEW_EVIDENCE_BASIS_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['kind', 'ref', 'field', 'value'],
    properties: {
        kind: { type: 'string', enum: [...REVIEW_BASIS_KINDS] },
        ref: { type: 'string', minLength: 1, maxLength: 80 },
        field: { type: 'string', minLength: 1, maxLength: 80 },
        value: { type: 'string', minLength: 1, maxLength: 600 }
    }
} as const;

export function isReviewEvidenceBasis(value: unknown): value is ReviewEvidenceBasis {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const basis = value as Record<string, unknown>;
    return Object.keys(basis).length === 4 && Object.keys(basis).every(key => ['kind', 'ref', 'field', 'value'].includes(key))
        && REVIEW_BASIS_KINDS.includes(basis.kind as ReviewEvidenceBasis['kind'])
        && ['ref', 'field', 'value'].every(key => typeof basis[key] === 'string'
            && (basis[key] as string).length > 0 && (basis[key] as string).length <= (key === 'value' ? 600 : 80));
}

export const reviewFactId = (kind: 'assertion' | 'call' | 'method' | 'import' | 'class', index: number, child?: number): string => {
    const prefix = { assertion: 'A', call: 'C', method: 'M', import: 'I', class: 'H' }[kind];
    return prefix + (index + 1) + (child === undefined ? '' : '.' + (child + 1));
};

interface FactRecord { fields: Record<string, string>; relevantLines: number[]; methodRange?: [number, number] }
/** Only explicit scalar facts are addressable. Absence never becomes false or unknown. */
function reviewFactRecords(facts: ReviewFacts): Map<string, FactRecord> {
    const result = new Map<string, FactRecord>();
    const fields = (value: object, names: string[]): Record<string, string> => Object.fromEntries(names.flatMap(name => {
        const item = (value as Record<string, unknown>)[name];
        return typeof item === 'string' || typeof item === 'boolean' ? [[name, String(item)]] : [];
    }));
    result.set('E1', { fields: fields(facts, ['executionVerified']), relevantLines: [] });
    facts.imports.forEach((item, index) => {
        const uses = [...(item.harnessUseLines || []), ...(item.targetUseLines || [])];
        const assertions = facts.methods.flatMap(method => method.assertions
            .filter(assertion => assertion.targetCallLine !== undefined && uses.includes(assertion.targetCallLine)).map(assertion => assertion.line));
        result.set(reviewFactId('import', index), { fields: fields(item, ['binding', 'origin']), relevantLines: [item.line, ...uses, ...assertions] });
    });
    facts.classes.forEach((item, index) => result.set(reviewFactId('class', index), {
        fields: fields(item, ['name', 'kind']), relevantLines: [item.line]
    }));
    facts.methods.forEach((method, index) => {
        result.set(reviewFactId('method', index), { fields: fields(method, ['name']), relevantLines: [], methodRange: [method.line, method.endLine] });
        method.assertions.forEach((item, child) => result.set(reviewFactId('assertion', index, child), {
            fields: { ...fields(item, ['kind', 'targetResult', 'expectedOrigin', 'expectedType']),
                observationStatus: item.observationStatus ?? (item.observationVerified === true ? 'verified' : 'unknown') }, relevantLines: [item.line]
        }));
        method.calls.forEach((item, child) => result.set(reviewFactId('call', index, child), {
            fields: fields(item, ['observationReturned']),
            relevantLines: [item.line, ...method.assertions.filter(assertion => assertion.targetCallLine === item.line).map(assertion => assertion.line)]
        }));
    });
    return result;
}

/** Checks lineage and explicit premises; it does not verify arbitrary prose or an oracle. */
export function reviewEvidenceBasisDiagnostic(basis: ReviewEvidenceBasis, line: number,
    context: { identity?: ReviewFactIdentity; facts?: ReviewFacts; requirements?: ReviewRequirements }): ReviewBasisRejection | undefined {
    if (!isReviewEvidenceBasis(basis)) { return 'invalid-evidence-basis'; }
    if (basis.kind === 'test-code') {
        return basis.ref === `L${line}` && basis.field === 'judgment' && basis.value === 'unverified'
            ? undefined : 'invalid-evidence-basis';
    }
    if (basis.kind === 'requirement') {
        const { requirements, identity } = context;
        if (!requirements || !identity) { return 'requirement-evidence-missing'; }
        if (requirements.runId !== identity.runId || requirements.sourceHash !== identity.sourceHash || requirements.target !== identity.target) {
            return 'requirement-identity-mismatch';
        }
        const items = requirements.items.filter(item => item.id === basis.ref);
        return items.length === 1 && basis.field === 'statement' && basis.value === items[0].statement
            ? undefined : 'requirement-evidence-missing';
    }
    if (!context.facts) { return 'evidence-reference-missing'; }
    const record = reviewFactRecords(context.facts).get(basis.ref);
    if (!record || !Object.hasOwn(record.fields, basis.field)) { return 'evidence-reference-missing'; }
    if (basis.ref !== 'E1' && !record.relevantLines.includes(line)
        && !(record.methodRange && record.methodRange[0] <= line && line <= record.methodRange[1])) { return 'evidence-reference-unrelated'; }
    if (record.fields[basis.field] !== basis.value) { return 'evidence-fact-contradiction'; }
    if (basis.kind === 'evidence-gap' && (!['observationStatus', 'expectedOrigin'].includes(basis.field) || basis.value !== 'unknown')) {
        return 'invalid-evidence-basis';
    }
    return undefined;
}
