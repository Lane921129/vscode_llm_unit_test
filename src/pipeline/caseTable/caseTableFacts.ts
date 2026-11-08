/**
 * Host-side reader for python_scripts/case_table_facts.py (case-table-facts-v1).
 */
export const CASE_TABLE_FACTS_VERSION = 'case-table-facts-v1';

export interface CaseTableParameter {
    name: string;
    kind: 'positional_only' | 'positional_or_keyword' | 'var_positional' | 'keyword_only' | 'var_keyword';
    annotation: string | null;
    default: string | null;
}

export interface CaseTableBranch {
    line: number;
    kind: string;
    condition: string;
}

/** `chain` is empty when `patch` itself is the mocked callable; otherwise it walks from the patched root. */
export interface CaseTableDependency {
    name: string;
    patch: string;
    chain: string[];
    create?: boolean;
}

export interface CaseTableFacts {
    version: typeof CASE_TABLE_FACTS_VERSION;
    target: string;
    className: string | null;
    methodKind: 'module' | 'instance' | 'static' | 'class';
    isAsync: boolean;
    signature: string;
    parameters: CaseTableParameter[];
    returns: string | null;
    docstring: string | null;
    branches: CaseTableBranch[];
    raises: string[];
    dependencies: CaseTableDependency[];
    source: string;
}

/** Parse tool stdout; a tool error or malformed shape throws (tool failure, not a model failure). */
export function readCaseTableFacts(stdout: string): CaseTableFacts {
    let value: unknown;
    try { value = JSON.parse(stdout); } catch { throw new Error('case-table-facts-malformed: not JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('case-table-facts-malformed: not an object'); }
    const facts = value as Record<string, unknown>;
    if (facts.version !== CASE_TABLE_FACTS_VERSION) { throw new Error('case-table-facts-malformed: version'); }
    if (typeof facts.error === 'string') { throw new Error(`case-table-facts-failed: ${facts.error}`); }
    const isList = (key: string) => Array.isArray(facts[key]);
    if (typeof facts.target !== 'string' || typeof facts.signature !== 'string' || typeof facts.source !== 'string'
        || !isList('parameters') || !isList('branches') || !isList('raises') || !isList('dependencies')
        || !['module', 'instance', 'static', 'class'].includes(facts.methodKind as string)) {
        throw new Error('case-table-facts-malformed: fields');
    }
    for (const dependency of facts.dependencies as unknown[]) {
        const item = dependency as Record<string, unknown>;
        if (!item || typeof item.name !== 'string' || typeof item.patch !== 'string' || !Array.isArray(item.chain)
            || !item.chain.every(step => typeof step === 'string')) {
            throw new Error('case-table-facts-malformed: dependency');
        }
    }
    return value as CaseTableFacts;
}
