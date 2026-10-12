import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { currentExecution, ExecutionContext } from './executionContext';
import { existingRealPath } from '../utils/fileIdentity';
import { RuntimeQualificationSession, RuntimeQualificationIdentity } from '../llm/runtimeQualificationSession';
import { SourceVersion, sourceVersionsCurrent } from './sourceVersions';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stores = new WeakMap<ExecutionContext, BatchRuntimeQualification>();

/** A batch owns only capability evidence, never actual test/Trace/resource results. */
export class BatchRuntimeQualification {
    readonly session: RuntimeQualificationSession;
    readonly scopeIdentity: string;
    readonly pythonIdentity: string;
    private readonly sources: Array<{ file: string; real: string; hash: string }>;
    private readonly dependencies = new Map<string, SourceVersion>();
    private readonly preferred = new Map<string, number>();
    private invalidated = false;
    constructor(batchId: string, readonly root: string, files: readonly string[], readonly python: string) {
        this.session = new RuntimeQualificationSession(batchId);
        this.sources = files.map(file => ({ file, real: existingRealPath(file), hash: digest(fs.readFileSync(file)) }));
        this.scopeIdentity = digest(JSON.stringify([existingRealPath(root), this.sources.map(item => [item.real, item.hash]).sort()]));
        this.pythonIdentity = this.interpreterIdentity();
    }
    private interpreterIdentity(): string {
        const candidates = path.isAbsolute(this.python) ? [this.python] : (process.env.PATH || '').split(path.delimiter)
            .flatMap(directory => [path.join(directory, this.python), path.join(directory, this.python + '.exe')]);
        const file = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (!file) { return digest(JSON.stringify([this.python, process.env.PATH])); }
        const real = existingRealPath(file), stat = fs.statSync(real);
        // The analysis environment lease prevents approved installation from overlapping this batch.
        const configuration = path.join(path.dirname(path.dirname(real)), 'pyvenv.cfg');
        return digest(JSON.stringify([this.python, real, stat.size, stat.mtimeMs,
            fs.existsSync(configuration) ? digest(fs.readFileSync(configuration)) : null]));
    }
    current(): boolean {
        try {
            if (!this.invalidated && this.interpreterIdentity() === this.pythonIdentity
                && this.sources.every(item => existingRealPath(item.file) === item.real && digest(fs.readFileSync(item.file)) === item.hash)
                && (!this.dependencies.size || sourceVersionsCurrent([...this.dependencies.values()]))) { return true; }
        } catch { /* Missing or changed files revoke all owned capability evidence. */ }
        this.clear(); return false;
    }
    bindDependencies(values: readonly SourceVersion[]): void {
        // A new successful preflight cannot overwrite a changed old dependency
        // and silently resurrect qualifications bound before that drift.
        if (!this.current() || !sourceVersionsCurrent(values)) { this.clear(); return; }
        for (const value of values) { this.dependencies.set(value.file, { ...value }); }
    }
    identity(input: Omit<RuntimeQualificationIdentity, 'pythonIdentity' | 'scopeIdentity'>, fixtureId?: string): RuntimeQualificationIdentity {
        return { ...input, pythonIdentity: this.pythonIdentity, scopeIdentity: digest(this.scopeIdentity + '\0' + (fixtureId || 'none')) };
    }
    private preferenceKey(identity: RuntimeQualificationIdentity): string {
        return digest(JSON.stringify([identity.endpointKey, identity.modelName, identity.qualificationVersion,
            identity.pythonIdentity, identity.scopeIdentity]));
    }
    preferredContext(identity: RuntimeQualificationIdentity): number | undefined {
        return this.current() ? this.preferred.get(this.preferenceKey(identity)) : undefined;
    }
    rememberContext(identity: RuntimeQualificationIdentity): void {
        if (this.current()) { this.preferred.set(this.preferenceKey(identity), identity.numCtx); }
    }
    clear(): void { this.invalidated = true; this.session.clear(); this.preferred.clear(); }
}

export function initializeBatchRuntimeQualification(root: string, files: readonly string[], python: string): void {
    const owner = currentExecution();
    if (owner) { stores.set(owner, new BatchRuntimeQualification(owner.id, root, files, python)); }
}
export function currentBatchRuntimeQualification(root: string, file: string, python: string): BatchRuntimeQualification {
    const owner = currentExecution();
    const existing = owner && stores.get(owner);
    if (existing && existingRealPath(existing.root) === existingRealPath(root) && existing.python === python) { return existing; }
    const store = new BatchRuntimeQualification(owner?.id || 'single-target', root, [file], python);
    if (owner) { stores.set(owner, store); }
    return store;
}
