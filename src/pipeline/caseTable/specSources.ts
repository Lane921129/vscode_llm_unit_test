/**
 * Spec sources for the v2 spec oracle (architecture 1.1): docstring, type
 * annotations and the requirements file. README sections are not used yet.
 * Only the docstring and requirement texts can verify a prediction's basis;
 * annotations and the function name are shown but are weak evidence.
 */
import { CaseTableFacts } from './caseTableFacts';
import { RequirementEntry } from './requirements';

export interface SpecSources {
    signature: string;
    docstring: string | null;
    annotations: { name: string; annotation: string }[];
    returns: string | null;
    requirements: RequirementEntry[];
}

export function collectSpecSources(facts: CaseTableFacts, requirements: readonly RequirementEntry[]): SpecSources {
    return {
        signature: facts.signature,
        docstring: facts.docstring?.trim() || null,
        annotations: facts.parameters.filter(param => param.annotation).map(param => ({ name: param.name, annotation: param.annotation! })),
        returns: facts.returns,
        requirements: [...requirements]
    };
}

/** A spec exists when there is a docstring or a requirement; annotations alone cannot decide values. */
export function hasSpecSource(spec: SpecSources): boolean {
    return Boolean(spec.docstring) || spec.requirements.length > 0;
}

function normalize(text: string): string {
    return text.toLowerCase().replace(/[\s　]+/g, ' ').replace(/^[\s"'“”「」`.,;:，。；：]+|[\s"'“”「」`.,;:，。；：]+$/g, '').trim();
}

const LABEL = /^(?:docstring|requirements?|spec(?:ification)?|r[1-9]\d*)\s*[:：\-–]\s*/i;
export const MIN_BASIS_CHARACTERS = 6;

/** True only when the quoted basis really appears in the docstring or a requirement text. */
export function basisVerified(basis: string, spec: SpecSources): boolean {
    let text = basis.trim();
    while (LABEL.test(text)) { text = text.replace(LABEL, ''); }
    const quoted = normalize(text);
    if (Array.from(quoted).length < MIN_BASIS_CHARACTERS) { return false; }
    const corpus = [spec.docstring ?? '', ...spec.requirements.map(entry => entry.text)].map(normalize);
    return corpus.some(source => source.includes(quoted));
}
