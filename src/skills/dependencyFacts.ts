import { createHash } from 'node:crypto';

export interface DependencySkillBinding {
    name: string;
    origin: string;
    kind: 'import' | 'factory-result';
    line: number;
}

/** Reject stale/partial facts; origin is initializer syntax, never an object type. */
export function dependencySkillBindings(context?: any): DependencySkillBinding[] {
    const facts = context?.dependency_skill_facts;
    const source = typeof context?.code === 'string' ? context.code.replace(/\r\n?/g, '\n') : '';
    const dotted = /^[_\p{ID_Start}][_\p{ID_Continue}]*(?:\.[_\p{ID_Start}][_\p{ID_Continue}]*)*$/u;
    if (!source || facts?.schemaVersion !== 'dependency-skill-facts-v1' || facts.status !== 'complete'
        || facts.authority !== 'skill-selection-only' || facts.assertionOracle !== false || facts.patchAuthorization !== false
        || facts.targetSourceHash !== createHash('sha256').update(source).digest('hex')
        || facts.target !== (context.class_name ? `${context.class_name}.${context.name}` : context.name)
        || !Array.isArray(facts.bindings) || facts.bindings.length > 64
        || Buffer.byteLength(JSON.stringify(facts), 'utf8') > 32768) { return []; }
    const names = new Set<string>();
    for (const binding of facts.bindings) {
        if (!binding || typeof binding.name !== 'string' || binding.name.includes('.') || !dotted.test(binding.name)
            || names.has(binding.name) || typeof binding.origin !== 'string' || binding.origin.length > 500
            || !dotted.test(binding.origin) || !['import', 'factory-result'].includes(binding.kind)
            || !Number.isSafeInteger(binding.line) || binding.line <= 0) { return []; }
        names.add(binding.name);
    }
    return facts.bindings;
}

export function dependencyLibraryBindings(kind: 'database' | 'http', context?: any): DependencySkillBinding[] {
    const library = kind === 'database'
        ? /^(?:sqlite3|sqlalchemy|psycopg|psycopg2|psycopg3|pymysql|mysql\.connector|asyncpg)(?:\.|$)/
        : /^(?:requests|httpx|aiohttp|urllib\.request)(?:\.|$)/;
    return dependencySkillBindings(context).filter(binding => library.test(binding.origin));
}
