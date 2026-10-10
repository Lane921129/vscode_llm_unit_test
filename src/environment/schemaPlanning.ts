import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runSpawn } from '../utils/processRunner';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { throwIfExecutionCancelled } from '../pipeline/executionContext';
import { pythonToolPath } from '../pipeline/pythonTools';
import { ImportFixtureRule } from '../pipeline/importFixtures';
import { ResourceTable, TestResourceSpec, resourceSpecKey, validateTestResources } from '../pipeline/isolatedResources';

type SqliteResource = Extract<TestResourceSpec, { kind: 'sqlite' }>;
export interface SchemaProposal {
    file: string; sourceHash: string; line: number; connectionLine: number;
    resource: Omit<SqliteResource, 'tables'>; table: ResourceTable;
    sourceDependencies?: Source[];
    configFixtures?: Array<Source & { name: string; text: string }>;
    pythonSourceMode?: true;
    migrationLines?: number[];
}
export interface SchemaDiagnostic { file: string; line?: number; reason: string }
interface Source { file: string; sourceHash: string }
interface SchemaPlan {
    proposedRules: ImportFixtureRule[]; proposals: SchemaProposal[];
    candidates: SchemaProposal[]; diagnostics: SchemaDiagnostic[];
}
const identity = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
const invalid = () => new AnalysisStageError('environment', 'sqlite-schema-plan', 'SQLite schema planning could not be verified.');
const object = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: any, allowed: string[]) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const sourceName = (value: unknown): value is string => typeof value === 'string' && value.length <= 1000
    && !path.isAbsolute(value) && !/[:\u0000-\u001f\u007f]/.test(value)
    && value.split(/[\\/]/).every(part => !!part && part !== '.' && part !== '..');
const line = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

function verifySources(root: string, sources: Source[]): void {
    for (const source of sources) {
        if (!sourceName(source.file) || !source.file.endsWith('.py') || !/^[a-f0-9]{64}$/.test(source.sourceHash)) { throw invalid(); }
        let current = root;
        for (const part of source.file.split(/[\\/]/)) {
            current = path.join(current, part);
            if (fs.lstatSync(current).isSymbolicLink()) { throw invalid(); }
        }
        if (identity(fs.realpathSync(current)) !== identity(current)
            || createHash('sha256').update(fs.readFileSync(current)).digest('hex') !== source.sourceHash) { throw invalid(); }
    }
}

function readCandidate(raw: any, sources: Source[]): SchemaProposal {
    if (!keys(raw, ['file', 'sourceHash', 'line', 'connectionLine', 'resource', 'table', 'sourceDependencies', 'configFixtures', 'pythonSourceMode', 'migrationLines'])
        || !sourceName(raw.file) || !line(raw.line) || !line(raw.connectionLine)
        || !keys(raw.resource, ['kind', 'path', 'scope']) || raw.resource.kind !== 'sqlite'
        || !keys(raw.table, ['name', 'columns', 'unique'])) { throw invalid(); }
    const source = sources.find(item => identity(item.file) === identity(raw.file) && item.sourceHash === raw.sourceHash);
    if (!source) { throw invalid(); }
    const dependencies: Source[] = raw.sourceDependencies || [];
    if (!Array.isArray(dependencies) || dependencies.length > 64 || dependencies.some(item => !keys(item, ['file', 'sourceHash'])
        || !sourceName(item.file) || typeof item.sourceHash !== 'string'
        || !sources.some(source => identity(source.file) === identity(item.file) && source.sourceHash === item.sourceHash))) { throw invalid(); }
    const configs: Array<Source & { name: string; text: string }> = raw.configFixtures || [];
    if (!Array.isArray(configs) || configs.length > 8 || configs.some(item => !keys(item, ['file', 'sourceHash', 'name', 'text'])
        || !sourceName(item.file) || typeof item.sourceHash !== 'string'
        || !sources.some(source => identity(source.file) === identity(item.file) && source.sourceHash === item.sourceHash)
        || typeof item.name !== 'string' || !/^[\w.-]+\.ini$/i.test(item.name) || item.text !== '')
        || raw.pythonSourceMode !== undefined && raw.pythonSourceMode !== true
        || raw.migrationLines !== undefined && (!Array.isArray(raw.migrationLines) || raw.migrationLines.length > 32 || raw.migrationLines.some((value: unknown) => !line(value)))) { throw invalid(); }
    const resource = validateTestResources([{ ...raw.resource, tables: [raw.table] }])[0];
    if (resource.kind !== 'sqlite') { throw invalid(); }
    const { tables, ...location } = resource;
    return { file: source.file, sourceHash: source.sourceHash, line: raw.line,
        connectionLine: raw.connectionLine, resource: location, table: tables[0],
        ...(dependencies.length ? { sourceDependencies: dependencies } : {}),
        ...(configs.length ? { configFixtures: configs } : {}),
        ...(raw.pythonSourceMode ? { pythonSourceMode: true } : {}),
        ...(raw.migrationLines ? { migrationLines: raw.migrationLines } : {}) };
}

/** Exact source-backed DB locations may be proposed as NEW resources. Nothing is
 * applied until the common setup preview is approved; existing inputs win on conflict. */
export function mergeSchemaProposals(rules: ImportFixtureRule[], candidates: SchemaProposal[]): SchemaPlan {
    const proposedRules = structuredClone(rules), proposals: SchemaProposal[] = [], diagnostics: SchemaDiagnostic[] = [];
    const diagnostic = (items: SchemaProposal[], reason: string) => {
        for (const item of items) {
            if (!diagnostics.some(d => d.file === item.file && d.line === item.line && d.reason === reason)) {
                diagnostics.push({ file: item.file, line: item.line, reason });
            }
        }
    };
    const definition = (table: ResourceTable) => JSON.stringify({ name: table.name, columns: table.columns,
        ...(table.unique !== undefined ? { unique: table.unique } : {}) });
    const groups = new Map<string, SchemaProposal[]>();
    for (const candidate of candidates) {
        const key = `${resourceSpecKey(candidate.resource)}\0${candidate.table.name.toLowerCase()}`;
        groups.set(key, [...(groups.get(key) || []), candidate]);
    }
    for (const items of groups.values()) {
        const first = items[0], key = resourceSpecKey(first.resource);
        if (new Set(items.map(item => definition(item.table))).size !== 1) {
            diagnostic(items, 'conflicting-literal-schema'); continue;
        }
        const pending = structuredClone(proposedRules);
        let conflict = '';
        const ensureRule = (file: string) => {
            let rule = pending.find(rule => identity(rule.file.replace(/\\/g, '/')) === identity(file));
            if (!rule) { rule = { file }; pending.push(rule); }
            return rule;
        };
        for (const item of items) {
            const rule = ensureRule(item.file);
            if (rule.resourceSourceHash && rule.resourceSourceHash !== item.sourceHash) { conflict = 'source-approval-expired'; break; }
            for (const config of item.configFixtures || []) {
                const owner = ensureRule(config.file);
                if (owner.sourceDependencies?.some(d => identity(d.file) === identity(config.file) && d.sourceHash !== config.sourceHash)
                    || owner.resourceSourceHash && owner.resourceSourceHash !== config.sourceHash) {
                    conflict = 'source-approval-expired'; break;
                }
                if (Object.hasOwn(owner.configFiles || {}, config.name) && owner.configFiles![config.name] !== config.text) {
                    conflict = 'config-fixture-conflict'; break;
                }
                owner.configFiles = { ...owner.configFiles, [config.name]: config.text };
                owner.sourceDependencies = [...(owner.sourceDependencies || []).filter(d => identity(d.file) !== identity(config.file)),
                    { file: config.file, sourceHash: config.sourceHash }];
                if (item.pythonSourceMode) { owner.pythonSourceMode = true; }
            }
            const dependencies = [...(rule.sourceDependencies || [])];
            for (const dependency of item.sourceDependencies || []) {
                const existing = dependencies.find(d => identity(d.file) === identity(dependency.file));
                if (existing && existing.sourceHash !== dependency.sourceHash) { conflict = 'source-approval-expired'; break; }
                if (!existing) { dependencies.push(dependency); }
            }
            if (dependencies.length) { rule.sourceDependencies = dependencies; }
            if (item.pythonSourceMode) { rule.pythonSourceMode = true; }
            if (!rule.resources?.some(resource => resourceSpecKey(resource) === key)) {
                rule.resources = [...(rule.resources || []), { ...item.resource, tables: [] }];
            }
            rule.resourceSourceHash = item.sourceHash;
        }
        if (conflict) { diagnostic(items, conflict); continue; }
        const owners = pending.flatMap(rule => (rule.resources || []).filter(resource =>
            resource.kind === 'sqlite' && resourceSpecKey(resource) === key).map(resource => ({ rule, resource: resource as SqliteResource })));
        const bound = items.filter(item => owners.some(({ rule }) => identity(rule.file.replace(/\\/g, '/')) === identity(item.file)
            && rule.resourceSourceHash === item.sourceHash));
        diagnostic(items.filter(item => !bound.includes(item)), 'source-approval-expired');
        if (!bound.length) { continue; }
        const existing = owners.flatMap(({ resource }) => resource.tables.filter(table => table.name.toLowerCase() === first.table.name.toLowerCase()));
        if (existing.some(table => definition(table) !== definition(first.table))) {
            diagnostic(items, 'existing-schema-conflict'); continue;
        }
        if (existing.length === owners.length) {
            if (JSON.stringify(pending) !== JSON.stringify(proposedRules)) {
                proposals.push(...bound.filter((item, index) => bound.findIndex(other => other.file === item.file) === index));
                proposedRules.splice(0, proposedRules.length, ...pending);
            }
            continue;
        }
        if (owners.some(({ rule }) => !bound.some(item => identity(item.file) === identity(rule.file.replace(/\\/g, '/'))
            && item.sourceHash === rule.resourceSourceHash))) {
            diagnostic(bound, 'shared-resource-requires-explicit-schema'); continue;
        }
        if (owners.some(({ resource }) => resource.tables.length >= 16)) {
            diagnostic(bound, 'resource-table-limit'); continue;
        }
        for (const { rule, resource } of owners) {
            if (resource.tables.some(table => table.name.toLowerCase() === first.table.name.toLowerCase())) { continue; }
            const evidence = bound.find(item => identity(item.file) === identity(rule.file.replace(/\\/g, '/')))!;
            resource.tables.push(structuredClone(evidence.table));
            proposals.push(evidence);
        }
        proposedRules.splice(0, proposedRules.length, ...pending);
    }
    return { proposedRules, proposals, candidates, diagnostics };
}

/** Parse source syntax in a separate tool; no target imports, SQL execution or database reads. */
export async function planSqliteSchemas(root: string, python: string, sources: Source[], rules: ImportFixtureRule[], directory: string): Promise<SchemaPlan> {
    verifySources(root, sources);
    const result = await runSpawn(python, ['-B', pythonToolPath('sqliteSchemaPlan')], {
        input: JSON.stringify({ root, files: sources.map(source => path.join(root, source.file)) }), timeout: 15000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    throwIfExecutionCancelled();
    let value: any;
    try { value = result.code === 0 ? JSON.parse(result.stdout) : undefined; } catch { throw invalid(); }
    if (value?.schemaVersion !== 'sqlite-schema-plan-v1' || !Array.isArray(value.sources) || value.sources.length !== sources.length
        || !Array.isArray(value.candidates) || value.candidates.length > 256
        || !Array.isArray(value.diagnostics) || value.diagnostics.length > 256) { throw invalid(); }
    const seen = new Set<string>();
    for (const item of value.sources) {
        if (!keys(item, ['file', 'sourceHash']) || !sourceName(item.file) || seen.has(identity(item.file))
            || !sources.some(source => identity(source.file) === identity(item.file) && source.sourceHash === item.sourceHash)) { throw invalid(); }
        seen.add(identity(item.file));
    }
    const diagnostics: SchemaDiagnostic[] = value.diagnostics.map((item: any) => {
        if (!keys(item, ['file', 'line', 'reason']) || !sourceName(item.file) || !sources.some(source => identity(source.file) === identity(item.file))
            || typeof item.reason !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(item.reason)
            || item.line !== undefined && !line(item.line)) { throw invalid(); }
        return item;
    });
    const merged = mergeSchemaProposals(rules, value.candidates.map((item: any) => readCandidate(item, sources)));
    merged.diagnostics.unshift(...diagnostics);
    verifySources(root, sources);
    fs.writeFileSync(path.join(directory, 'schema_plan.json'), JSON.stringify({ schemaVersion: value.schemaVersion,
        sources, candidates: merged.candidates, proposals: merged.proposals, diagnostics: merged.diagnostics,
        note: 'Literal DDL only. No application initialization, database reads, or seed inference. Approval is required before isolated workers create fresh schemas.'
    }, null, 2));
    return merged;
}
