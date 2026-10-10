import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const RESOURCE_LEASE_ENV = 'LLM_UNIT_TEST_RESOURCE_LEASE';
export const RESOURCE_LEASE_MARKER = '.llm-unit-test-resource-lease.json';
export type ResourceCell = string | number | boolean | null;
export interface ResourceColumn {
    name: string; type: 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'NUMERIC';
    primaryKey?: boolean; notNull?: boolean; unique?: boolean; autoIncrement?: boolean;
    /** Literal fixture data, never an SQL expression. */
    default?: ResourceCell;
}
export interface ResourceTable { name: string; columns: ResourceColumn[]; unique?: string[][]; rows?: Array<Record<string, ResourceCell>> }
export type TestResourceSpec = { path: string; scope?: 'project-parent' | 'external-exact' | 'unc-virtual' } & (
    { kind: 'directory' } | { kind: 'text'; text: string } | { kind: 'sqlite'; tables: ResourceTable[] });
type ResourceRule = { file: string; resources?: TestResourceSpec[] };
export interface ResourceLifecycle {
    schemaVersion: 'isolated-resource-lifecycle-v1'; planId: string; created: true; cleaned: boolean;
}
export interface ResourceLease {
    readonly directory: string;
    readonly lifecycle: ResourceLifecycle;
    dispose(): Promise<void>;
}

/** Reporting cannot conceal a process or cleanup failure; observer text is never exposed. */
export async function closeResourceLease(lease: ResourceLease | undefined,
    observe?: (event: ResourceLifecycle) => void, processFailure?: { error: unknown }): Promise<void> {
    if (!lease) { return; }
    let cleanupFailure: Error | undefined;
    try { await lease.dispose(); }
    catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error('Isolated resource cleanup failed.');
        if (processFailure) { Object.assign(cleanupFailure, { cause: processFailure.error }); }
    }
    try { observe?.({ ...lease.lifecycle }); }
    catch {
        const primary = cleanupFailure || processFailure?.error;
        if (primary && (typeof primary === 'object' || typeof primary === 'function') && Object.isExtensible(primary)) {
            Object.assign(primary, { resourceJournalError: 'resource-lifecycle-observer-failed' });
        } else if (!processFailure && !cleanupFailure) {
            throw Object.assign(new Error('Resource lifecycle reporting failed.'), {
                resourceJournalError: 'resource-lifecycle-observer-failed', resourceLifecycle: { ...lease.lifecycle }
            });
        }
    }
    if (cleanupFailure) { throw cleanupFailure; }
}

const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(value);
const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const invalid = () => new Error('Invalid isolated resource declaration.');
const unsafePathPart = (part: string) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /[\\:<>"|?*\u0000-\u001f\u007f]/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
const executableSuffix = /\.(?:py|pyc|pyo|so|pyd|dll|exe|sh|bat|cmd|ps1)$/i;

/** Canonical spelling only; this does not inspect or access the external location. */
export function canonicalExternalResourcePath(value: unknown): string {
    if (typeof value !== 'string' || !value.length || value.length > 240) { throw invalid(); }
    const windows = process.platform === 'win32';
    if (windows ? !/^[A-Za-z]:[\\/]/.test(value) : !value.startsWith('/') || value.startsWith('//')) { throw invalid(); }
    const normalized = windows ? value.replace(/\\/g, '/') : value;
    const tail = normalized.slice(windows ? 3 : 1);
    if (tail.split('/').some(unsafePathPart) || executableSuffix.test(tail)) { throw invalid(); }
    return identity(normalized);
}

/** A UNC spelling is only a local virtual-resource identifier, never a network grant. */
export function canonicalUncResourcePath(value: unknown): string {
    if (process.platform !== 'win32' || typeof value !== 'string' || !value.length || value.length > 240) { throw invalid(); }
    const normalized = value.replace(/\\/g, '/');
    if (!normalized.startsWith('//')) { throw invalid(); }
    const parts = normalized.slice(2).split('/');
    // Windows Path preserves the separator on a share root. No other empty
    // component is accepted, including a repeated separator at that root.
    if (parts.length === 3 && parts[2] === '') { parts.pop(); }
    if (parts.length < 2 || parts.some(unsafePathPart) || parts[1].toLowerCase() === 'ipc$'
        || executableSuffix.test(parts[parts.length - 1])) { throw invalid(); }
    return '//' + parts.join('/').toLowerCase();
}

/** The same spelling inside and beside a project identifies different resources. */
export const resourceSpecKey = (resource: Pick<TestResourceSpec, 'path' | 'scope'>): string =>
    `${resource.scope || 'project'}:${resource.scope === 'external-exact'
        ? canonicalExternalResourcePath(resource.path) : resource.scope === 'unc-virtual'
            ? canonicalUncResourcePath(resource.path) : identity(resource.path)}`;
export const resourceLogicalPath = (resource: Pick<TestResourceSpec, 'path' | 'scope'>): string =>
    resource.scope === 'external-exact' ? canonicalExternalResourcePath(resource.path)
        : resource.scope === 'unc-virtual' ? canonicalUncResourcePath(resource.path)
            : `${resource.scope === 'project-parent' ? '../' : ''}${resource.path}`;

/** Inspect path metadata only; never open, create or reuse the original resource. */
export function validateResourceLocation(root: string, resource: TestResourceSpec): void {
    if (resource.scope === 'unc-virtual') {
        const selected = canonicalUncResourcePath(resource.path);
        // Do not resolve, stat, open or enumerate a network-style identifier.
        // The source root has its existing validation at plan construction;
        // only a lexical comparison is needed to reject a source overlap here.
        let source = path.resolve(root).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        if (source.startsWith('//?/unc/')) { source = '//' + source.slice(8); }
        const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + '/');
        if (contains(source, selected) || contains(selected, source)) { throw invalid(); }
        return;
    }
    root = fs.realpathSync(root);
    const base = resource.scope === 'project-parent' ? path.dirname(root) : root;
    const external = resource.scope === 'external-exact';
    const selected = external ? path.resolve(canonicalExternalResourcePath(resource.path))
        : path.resolve(base, ...resource.path.split('/'));
    const contains = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    if (external) {
        // Existing project/sibling paths must keep their existing scopes. An
        // external mount can never include the selected application source.
        if (contains(path.dirname(root), selected) || contains(selected, root)) { throw invalid(); }
    } else if (!contains(base, selected) || identity(base) === identity(selected)
        || resource.scope === 'project-parent' && (contains(root, selected) || contains(selected, root))) { throw invalid(); }
    let current = external ? path.parse(selected).root : base;
    const components = external ? selected.slice(current.length).split(path.sep) : resource.path.split('/');
    for (const component of components) {
        current = path.join(current, component);
        try { if (fs.lstatSync(current).isSymbolicLink()) { throw invalid(); } }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { break; }
            throw error;
        }
    }
}

/** A resource is declarative data at a bounded logical path, never executable source. */
export function validateTestResources(input: unknown): TestResourceSpec[] {
    if (!Array.isArray(input) || input.length > 16) { throw invalid(); }
    const result: TestResourceSpec[] = [];
    for (const value of input) {
        if (!object(value) || typeof value.path !== 'string' || value.path.length > 240
            || value.scope !== undefined && value.scope !== 'project-parent' && value.scope !== 'external-exact'
                && value.scope !== 'unc-virtual') { throw invalid(); }
        const resourcePath = value.scope === 'external-exact' ? canonicalExternalResourcePath(value.path)
            : value.scope === 'unc-virtual' ? canonicalUncResourcePath(value.path) : value.path;
        if (value.scope !== 'external-exact' && value.scope !== 'unc-virtual' && (resourcePath.split('/').some(unsafePathPart)
            || executableSuffix.test(resourcePath))) { throw invalid(); }
        const location = { path: resourcePath, ...(value.scope === 'project-parent' || value.scope === 'external-exact' || value.scope === 'unc-virtual'
            ? { scope: value.scope } : {}) } as Pick<TestResourceSpec, 'path' | 'scope'>;
        if (value.kind === 'directory') {
            if (!keys(value, ['path', 'scope', 'kind'])) { throw invalid(); }
            result.push({ ...location, kind: value.kind });
        } else if (value.kind === 'text') {
            if (!keys(value, ['path', 'scope', 'kind', 'text']) || typeof value.text !== 'string'
                || Buffer.byteLength(value.text, 'utf8') > 65536) { throw invalid(); }
            result.push({ ...location, kind: value.kind, text: value.text });
        } else if (value.kind === 'sqlite') {
            if (!keys(value, ['path', 'scope', 'kind', 'tables']) || !Array.isArray(value.tables) || value.tables.length > 16) { throw invalid(); }
            const names = new Set<string>();
            const tables: ResourceTable[] = value.tables.map(table => {
                if (!object(table) || !keys(table, ['name', 'columns', 'unique', 'rows']) || !identifier(table.name)
                    || /^sqlite_/i.test(table.name) || names.has(table.name.toLowerCase())
                    || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 32) { throw invalid(); }
                names.add(table.name.toLowerCase());
                const columnNames = new Set<string>();
                const columns: ResourceColumn[] = table.columns.map(column => {
                    if (!object(column) || !keys(column, ['name', 'type', 'primaryKey', 'notNull', 'unique', 'autoIncrement', 'default'])
                        || !identifier(column.name) || columnNames.has(column.name.toLowerCase())
                        || !['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'].includes(String(column.type))
                        || column.primaryKey !== undefined && typeof column.primaryKey !== 'boolean'
                        || column.notNull !== undefined && typeof column.notNull !== 'boolean'
                        || column.unique !== undefined && typeof column.unique !== 'boolean'
                        || column.autoIncrement !== undefined && typeof column.autoIncrement !== 'boolean'
                        || column.autoIncrement === true && (column.primaryKey !== true || column.type !== 'INTEGER')) { throw invalid(); }
                    const literal = column.default;
                    if (Object.hasOwn(column, 'default') && !(literal === null || typeof literal === 'boolean'
                        || typeof literal === 'number' && Number.isFinite(literal) && (!Number.isInteger(literal) || Number.isSafeInteger(literal))
                        || typeof literal === 'string' && !literal.includes('\0') && Buffer.byteLength(literal, 'utf8') <= 4096)) { throw invalid(); }
                    columnNames.add(column.name.toLowerCase());
                    return { name: column.name, type: column.type as ResourceColumn['type'],
                        ...(column.primaryKey !== undefined ? { primaryKey: column.primaryKey } : {}),
                        ...(column.notNull !== undefined ? { notNull: column.notNull } : {}),
                        ...(column.unique !== undefined ? { unique: column.unique } : {}),
                        ...(column.autoIncrement !== undefined ? { autoIncrement: column.autoIncrement } : {}),
                        ...(Object.hasOwn(column, 'default') ? { default: literal as ResourceCell } : {}) };
                });
                if (columns.filter(column => column.primaryKey).length > 1
                    || table.rows !== undefined && (!Array.isArray(table.rows) || table.rows.length > 256)) { throw invalid(); }
                if (table.unique !== undefined && (!Array.isArray(table.unique) || table.unique.length > 16)) { throw invalid(); }
                const uniqueKeys = new Set<string>();
                const unique = (table.unique as unknown[] | undefined)?.map(group => {
                    if (!Array.isArray(group) || !group.length || group.length > 32
                        || group.some(name => typeof name !== 'string' || !columns.some(column => column.name === name))
                        || new Set(group).size !== group.length) { throw invalid(); }
                    const key = [...group].sort().join('\0');
                    if (uniqueKeys.has(key)) { throw invalid(); }
                    uniqueKeys.add(key);
                    return [...group] as string[];
                });
                const rows = (table.rows as unknown[] | undefined)?.map(row => {
                    if (!object(row) || Object.keys(row).some(key => !columns.some(column => column.name === key))) { throw invalid(); }
                    const normalized: Array<[string, ResourceCell]> = [];
                    for (const column of columns) {
                        if (!Object.hasOwn(row, column.name)) { continue; }
                        const cell = row[column.name];
                        if (!(cell === null || typeof cell === 'boolean' || typeof cell === 'number' && Number.isFinite(cell)
                            || typeof cell === 'string' && Buffer.byteLength(cell, 'utf8') <= 4096)) { throw invalid(); }
                        normalized.push([column.name, cell]);
                    }
                    return Object.fromEntries(normalized);
                });
                return { name: table.name, columns, ...(unique !== undefined ? { unique } : {}), ...(rows !== undefined ? { rows } : {}) };
            });
            result.push({ ...location, kind: value.kind, tables });
        } else { throw invalid(); }
    }
    return result;
}

/** Aliases may share an identical seed; they may not disagree or mount source directories. */
export function validateResourcePlanConflicts(rules: readonly ResourceRule[], root?: string): void {
    const mounted = new Map<string, TestResourceSpec>();
    for (const rule of rules) {
        for (const resource of rule.resources || []) {
            if (root) { validateResourceLocation(root, resource); }
            else if (resource.scope) { throw invalid(); }
            const name = resourceSpecKey(resource), previous = mounted.get(name);
            if (previous && JSON.stringify({ ...previous, path: name }) !== JSON.stringify({ ...resource, path: name })) { throw invalid(); }
            if (!resource.scope && rules.some(source => identity(source.file) === identity(resource.path)
                || resource.kind === 'directory' && identity(source.file).startsWith(identity(resource.path) + '/'))) { throw invalid(); }
            mounted.set(name, resource);
        }
    }
    for (const [name, resource] of mounted) {
        if (resource.kind !== 'directory' && [...mounted.keys()].some(other => other.startsWith(name + '/'))) { throw invalid(); }
    }
}

export function resourceLeaseEnvironment(base: NodeJS.ProcessEnv, lease?: ResourceLease): NodeJS.ProcessEnv {
    const env = { ...base };
    for (const key of Object.keys(env)) { if (key.toUpperCase() === RESOURCE_LEASE_ENV) { delete env[key]; } }
    if (lease) { env[RESOURCE_LEASE_ENV] = lease.directory; }
    return env;
}

/** The host owns the outer lease; workers create separate instances underneath it. */
export function createResourceLease(plan?: { id: string; rules: readonly ResourceRule[] }): ResourceLease | undefined {
    if (!plan?.rules.some(rule => rule.resources?.length)) { return undefined; }
    const parent = fs.realpathSync(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(parent, 'llm-unit-resources-'));
    const rootStat = fs.lstatSync(directory);
    const marker = JSON.stringify({ schemaVersion: 'isolated-resource-lease-v1', ownerPid: process.pid });
    const markerPath = path.join(directory, RESOURCE_LEASE_MARKER);
    try { fs.writeFileSync(markerPath, marker, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (error) { fs.rmdirSync(directory); throw error; }
    const lifecycle: ResourceLifecycle = { schemaVersion: 'isolated-resource-lifecycle-v1', planId: plan.id, created: true, cleaned: false };
    let disposed = false;
    return { directory, lifecycle, async dispose() {
        if (disposed) { return; }
        try {
            const current = fs.lstatSync(directory);
            if (path.dirname(directory) !== parent || current.isSymbolicLink() || !current.isDirectory()
                || current.dev !== rootStat.dev || current.ino !== rootStat.ino || fs.realpathSync(directory) !== directory
                || fs.lstatSync(markerPath).isSymbolicLink() || fs.readFileSync(markerPath, 'utf8') !== marker) {
                throw new Error('Resource lease ownership changed.');
            }
            await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            disposed = true; lifecycle.cleaned = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(directory)) {
                disposed = true; lifecycle.cleaned = true; return;
            }
            const failure = new Error('Isolated resource cleanup failed; temporary state was not confirmed removed.');
            Object.assign(failure, { resourceLifecycle: { ...lifecycle } });
            throw failure;
        }
    } };
}
