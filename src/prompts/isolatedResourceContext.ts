import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentImportFixtures, type ImportFixturePlan } from '../pipeline/importFixtures';
import { containsCredential } from '../pipeline/artifactSafety';
import { canonicalExternalResourcePath, canonicalUncResourcePath, resourceSpecKey } from '../pipeline/isolatedResources';
import { SOURCE_VERSIONS_VERSION, validSourceVersions, type SourceVersion } from '../pipeline/sourceVersions';

export interface IsolatedResourceSourceEvidence {
    version: typeof SOURCE_VERSIONS_VERSION;
    target: SourceVersion;
    sources: readonly SourceVersion[];
}
export interface TargetIsolatedResourceContext {
    context: string;
    status: 'projected' | 'unscoped' | 'source-drift' | 'invalid-evidence';
    resourceCount: number;
    exceedsBudget: boolean;
    /** A private schema may be withheld; it must never be treated as an empty schema. */
    complete: boolean;
}

/** Only a prompt projection. The approved plan, worker environment and resource
 * leases remain untouched. A loaded-source snapshot is not proof that a future
 * function-local or dynamic import cannot use another resource. */
export function buildTargetIsolatedResourceContext(plan: ImportFixturePlan | undefined,
    evidence: IsolatedResourceSourceEvidence | undefined, maxChars = 6000,
    knownSecrets: readonly string[] = []): TargetIsolatedResourceContext {
    if (!plan) { return { context: '', status: 'unscoped', resourceCount: 0, exceedsBudget: false, complete: true }; }
    let status: TargetIsolatedResourceContext['status'] = evidence ? 'invalid-evidence' : 'unscoped';
    let rules = plan?.rules.filter(rule => rule.resources?.length) || [];
    const canonical = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
    if (plan && evidence?.version === SOURCE_VERSIONS_VERSION && validSourceVersions(evidence.sources)
        && validSourceVersions([evidence.target])) {
        try {
            const root = fs.realpathSync(plan.root);
            const sourceKey = (file: string) => {
                const absolute = fs.realpathSync(file), relative = path.relative(root, absolute);
                if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
                    throw new Error('outside-source-root');
                }
                return canonical(absolute);
            };
            const versions = new Map(evidence.sources.map(source => [sourceKey(source.file), source.hash]));
            const targetKey = sourceKey(evidence.target.file);
            if (versions.size !== evidence.sources.length || versions.get(targetKey) !== evidence.target.hash) {
                return { context: '', status: 'invalid-evidence', resourceCount: 0, exceedsBudget: false, complete: false };
            }
            const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            if (evidence.sources.some(source => digest(source.file) !== source.hash)) {
                return { context: '', status: 'source-drift', resourceCount: 0, exceedsBudget: false, complete: false };
            }
            // Match real origins, never basenames or application/model vocabulary.
            const selected = rules.filter(rule => versions.has(sourceKey(path.resolve(root, rule.file))));
            const identities = new Set(selected.flatMap(rule => (rule.resources || []).map(resourceSpecKey)));
            rules = rules.flatMap(rule => {
                const resources = (rule.resources || []).filter(resource => identities.has(resourceSpecKey(resource)));
                return resources.length ? [{ ...rule, resources }] : [];
            });
            for (const rule of rules) {
                const file = path.resolve(root, rule.file), key = sourceKey(file);
                if (digest(file) !== rule.sourceHash || rule.resourceSourceHash !== rule.sourceHash
                    || versions.has(key) && versions.get(key) !== rule.sourceHash) {
                    return { context: '', status: 'source-drift', resourceCount: 0, exceedsBudget: false, complete: false };
                }
                for (const dependency of rule.sourceDependencies || []) {
                    const dependencyFile = path.resolve(root, dependency.file), dependencyKey = sourceKey(dependencyFile);
                    if (digest(dependencyFile) !== dependency.sourceHash
                        || versions.has(dependencyKey) && versions.get(dependencyKey) !== dependency.sourceHash) {
                        return { context: '', status: 'source-drift', resourceCount: 0, exceedsBudget: false, complete: false };
                    }
                }
            }
            status = 'projected';
        } catch {
            // Missing files, changed origins and root escapes cannot authorize filtering.
            return { context: '', status: 'invalid-evidence', resourceCount: 0, exceedsBudget: false, complete: false };
        }
    } else if (evidence) {
        return { context: '', status: 'invalid-evidence', resourceCount: 0, exceedsBudget: false, complete: false };
    }
    const notice = status === 'projected'
        ? 'Resource projection uses verified loaded source identities and shared resource identities. Unshown resources remain unknown; future local or dynamic imports are outside this snapshot. The approved runtime plan is unchanged.\n'
        : 'Resource relevance is unknown: no verified source snapshot was supplied. All approved resource declarations are retained.\n';
    const rendered = renderResourceContext(plan, rules, maxChars, knownSecrets, true, notice);
    return { context: rendered.context, status, resourceCount: rules.reduce((count, rule) => count + (rule.resources?.length || 0), 0),
        exceedsBudget: rendered.context.length > maxChars, complete: rendered.omitted === 0 };
}

/** The exception is for application code, never a generated test's direct I/O. */
export const ISOLATED_RESOURCE_ROLE_RULE = 'When HOST_ISOLATED_RESOURCE_CONTEXT is supplied, the host prepares only its declared resources before application import. Call the real target through its public API; do not create files, open database connections, invent tables, or replace a declared connection with a scalar mock. The seed is controlled input, not proof of an expected output. Each process starts fresh, but methods in one unittest suite share resources: arrange and clean up through supported public application APIs so tests do not depend on order. Undeclared boundaries still need explicit use-point mocks; network, shell, direct test I/O and shared databases remain forbidden.';

/** Keep ordinary functions and qualification probes at their original prompt size. */
export function isolatedResourceSystemRule(): string {
    return currentImportFixtures()?.rules.some(rule => rule.resources?.length)
        ? '\nUse HOST_ISOLATED_RESOURCE_CONTEXT for declared resources instead of mocks; call real target APIs. Seeds are inputs, not assertion oracles. Direct test I/O stays forbidden.' : '';
}

/** Whole records only: an incomplete seed/schema must never look complete. */
export function buildIsolatedResourceContext(
    plan: ImportFixturePlan | undefined, maxChars = 6000, knownSecrets: readonly string[] = []
): string {
    const rules = plan?.rules.filter(rule => rule.resources?.length) || [];
    return renderResourceContext(plan, rules, maxChars, knownSecrets).context;
}

function renderResourceContext(plan: ImportFixturePlan | undefined, rules: ImportFixturePlan['rules'], maxChars: number,
    knownSecrets: readonly string[], preserveSchemas = false, notice = ''): { context: string; omitted: number } {
    if (!plan || !rules.length) { return { context: plan && preserveSchemas ? notice : '', omitted: 0 }; }
    const parentScope = rules.some(rule => rule.resources?.some(resource => resource.scope === 'project-parent'))
        ? 'Scope project-parent means a logical sibling path under the project parent; the host redirects it to fresh temporary resources without reading or writing the original location. Omitted scope means project-relative.\n' : '';
    // Redaction must still cover private paths belonging to unselected resources.
    const externalPaths = plan.rules.flatMap(rule => (rule.resources || []).filter(resource => resource.scope === 'external-exact')
        .map(resource => canonicalExternalResourcePath(resource.path)));
    const uncPaths = plan.rules.flatMap(rule => (rule.resources || []).filter(resource => resource.scope === 'unc-virtual')
        .map(resource => canonicalUncResourcePath(resource.path)));
    const externalScope = rules.some(rule => rule.resources?.some(resource => resource.scope === 'external-exact'))
        ? 'Scope external-exact is a user-approved external logical path redirected to fresh temporary resources. Only its alias and hash are shown; never use the alias as a literal path or an expected value.\n' : '';
    const uncScope = rules.some(rule => rule.resources?.some(resource => resource.scope === 'unc-virtual'))
        ? 'Scope unc-virtual treats a network-style name only as an identifier for fresh local temporary resources. It grants no network connection or remote I/O. Only its alias and hash are shown; never use the alias as a literal path or expected value.\n' : '';
    const comparable = (value: string) => process.platform === 'win32' ? value.replace(/[\\/]+/g, '/').toLowerCase() : value;
    const privatePaths = [...externalPaths, ...uncPaths].map(comparable);
    const containsPrivatePath = (value: unknown): boolean => {
        if (typeof value === 'string') {
            const normalized = comparable(value);
            return privatePaths.some(privatePath => normalized.includes(privatePath));
        }
        if (Array.isArray(value)) { return value.some(containsPrivatePath); }
        return !!value && typeof value === 'object' && Object.values(value).some(containsPrivatePath);
    };
    const header = `HOST_ISOLATED_RESOURCE_CONTEXT\nPlan identity (includes source, schema and seed): ${plan.id}\n${notice}${ISOLATED_RESOURCE_ROLE_RULE}\n${parentScope}${externalScope}${uncScope}Resource declarations are setup facts, not execution results. Text contents are withheld. Omitted rows are unknown, never empty.\n`;
    if (!preserveSchemas && maxChars < header.length + 100) { return { context: '', omitted: 0 }; }
    const records: string[] = [];
    const optionalRows: Array<{ index: number; full: string }> = [];
    let omitted = 0;
    const fits = (record: string) => header.length + records.join('\n').length + record.length + 100 <= maxChars;
    for (const rule of rules) {
        for (const resource of rule.resources || []) {
            const privatePath = resource.scope === 'external-exact' ? canonicalExternalResourcePath(resource.path)
                : resource.scope === 'unc-virtual' ? canonicalUncResourcePath(resource.path) : undefined;
            const pathHash = privatePath ? createHash('sha256').update(resource.scope + ':' + privatePath).digest('hex') : undefined;
            const common = { declaredBy: rule.file, sourceHash: rule.sourceHash,
                ...(pathHash ? { pathAlias: `${resource.scope === 'unc-virtual' ? 'unc' : 'external'}-${pathHash.slice(0, 16)}`, pathHash }
                    : { path: resource.path }),
                ...(resource.scope ? { scope: resource.scope } : {}), kind: resource.kind };
            const summary = resource.kind === 'sqlite'
                ? { ...common, tables: resource.tables.map(table => ({ name: table.name, columns: table.columns,
                    ...(table.unique !== undefined ? { unique: table.unique } : {}),
                    rowCount: table.rows?.length || 0, rowsStatus: 'withheld' })) }
                : resource.kind === 'text'
                    ? { ...common, textBytes: Buffer.byteLength(resource.text, 'utf8'),
                        textHash: createHash('sha256').update(resource.text).digest('hex'), textStatus: 'withheld' }
                    : common;
            const complete = resource.kind === 'sqlite'
                ? { ...common, tables: resource.tables.map(table => ({ name: table.name, columns: table.columns,
                    ...(table.unique !== undefined ? { unique: table.unique } : {}),
                    rowCount: table.rows?.length || 0, rowsStatus: 'complete', rows: table.rows || [] })) }
                : summary;
            const full = JSON.stringify(complete), brief = JSON.stringify(summary);
            if (preserveSchemas) {
                if (containsPrivatePath(summary) || containsCredential(brief, knownSecrets)) { omitted++; }
                else {
                    if (!containsPrivatePath(complete) && !containsCredential(full, knownSecrets)) {
                        optionalRows.push({ index: records.length, full });
                    }
                    records.push(brief);
                }
            }
            else if (!containsPrivatePath(complete) && !containsCredential(full, knownSecrets) && fits(full)) { records.push(full); }
            else if (!containsPrivatePath(summary) && !containsCredential(brief, knownSecrets) && fits(brief)) { records.push(brief); }
            else { omitted++; }
        }
    }
    const suffix = omitted ? `\nWhole resource declarations omitted: ${omitted}; details are unknown.` : '';
    for (const { index, full } of optionalRows) {
        if (header.length + records.join('\n').length - records[index].length + full.length + suffix.length <= maxChars) {
            records[index] = full;
        }
    }
    return { context: header + records.join('\n') + suffix, omitted };
}
