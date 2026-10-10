import { localize } from '../i18n/core';
import { pythonToolPath } from './pythonTools';
import { ProcessTimeoutError, runSpawn } from '../utils/processRunner';
import { buildGeneratedTestEnvironment } from '../utils/pythonTestEnvironment';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { currentExecution, ExecutionContext, throwIfExecutionCancelled } from './executionContext';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentImportFixtures } from './importFixtures';
import { SourceVersion, SOURCE_VERSIONS_VERSION, validSourceVersions } from './sourceVersions';

export interface ResolvedDependency {
    module: string; name: string; level?: number; file?: string; resolvedModule?: string; reason?: string;
}

export const RESOURCE_SCOPE_VERSION = 'loaded-resource-scope-v1';
const resourceScopeReasons = ['invalid-source-snapshot', 'source-budget', 'source-unavailable', 'source-changed',
    'source-parse', 'nested-import', 'dynamic-import', 'unknown-dispatch'] as const;
export interface PreflightResourceScope {
    version: typeof RESOURCE_SCOPE_VERSION;
    eligible: boolean;
    sourceSetHash: string;
    reason?: typeof resourceScopeReasons[number];
}

/** This only binds the worker's conservative syntax check to this exact loaded
 * snapshot. It does not claim a complete arbitrary-runtime import closure. */
export function parsePreflightResourceScope(value: unknown, sourceVersions: unknown): PreflightResourceScope | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !validSourceVersions(sourceVersions)) { return undefined; }
    const scope = value as Record<string, unknown>;
    if (scope.version !== RESOURCE_SCOPE_VERSION || typeof scope.eligible !== 'boolean'
        || typeof scope.sourceSetHash !== 'string' || !/^[a-f0-9]{64}$/.test(scope.sourceSetHash)
        || (scope.reason !== undefined && !resourceScopeReasons.includes(scope.reason as typeof resourceScopeReasons[number]))
        || (scope.eligible && scope.reason !== undefined)) { return undefined; }
    const sourceSetHash = createHash('sha256').update(JSON.stringify(sourceVersions.map(item => [item.file, item.hash]))).digest('hex');
    if (scope.sourceSetHash !== sourceSetHash) { return undefined; }
    return { version: RESOURCE_SCOPE_VERSION, eligible: scope.eligible, sourceSetHash,
        ...(scope.reason !== undefined ? { reason: scope.reason as typeof resourceScopeReasons[number] } : {}) };
}

export type PreflightToolReason = 'timeout' | 'process-failed' | 'invalid-result';
export interface PreflightToolDiagnostic {
    schemaVersion: 'module-preflight-tool-diagnostic-v1';
    reasonCode: PreflightToolReason;
    exitCode?: number | null;
    detailCode?: 'missing-or-invalid-source-versions';
}

function toolFailure(reasonCode: PreflightToolReason, details: Partial<Pick<PreflightToolDiagnostic, 'exitCode' | 'detailCode'>> = {}): AnalysisStageError {
    return new AnalysisStageError('environment', 'module-preflight',
        localize('模組預檢工具未完成（{0}）；未取得可確認的模組載入診斷。', details.detailCode || reasonCode),
        { schemaVersion: 'module-preflight-tool-diagnostic-v1', reasonCode, ...details } satisfies PreflightToolDiagnostic);
}

export interface PreflightResult {
    ok: true;
    module: string;
    importPaths: string[];
    sourceVersionsVersion: typeof SOURCE_VERSIONS_VERSION;
    sourceVersions: SourceVersion[];
    resourceScope?: PreflightResourceScope;
    dependencies?: ResolvedDependency[];
    importFixtures?: { id: string; operations: Array<{ file: string; operation: string; line: number }> };
}

interface PreflightCache {
    failures: Map<string, AnalysisStageError>;
    pending: Map<string, Promise<PreflightResult>>;
}

// A new analysis gets a fresh view of repaired dependencies. Weak keys also
// keep a cancelled, draining batch separate from its replacement.
let preflightCaches = new WeakMap<ExecutionContext, PreflightCache>();

function currentCache(): PreflightCache | undefined {
    const execution = currentExecution();
    if (!execution) { return undefined; }
    let cache = preflightCaches.get(execution);
    if (!cache) {
        cache = { failures: new Map(), pending: new Map() };
        preflightCaches.set(execution, cache);
    }
    return cache;
}

function preflightKey(python: string, file: string, module: string, importPaths: string[], cwd: string): string {
    const source = fs.readFileSync(file);
    return createHash('sha256').update(JSON.stringify({
        python: path.resolve(python), file: path.resolve(file), module,
        importPaths: [...new Set(importPaths.map(item => path.resolve(item)).filter(item => item !== path.resolve(cwd)))],
        inheritedPythonPath: process.env.PYTHONPATH || '',
        executableSearchPath: process.env.PATH || '',
        importFixtures: currentImportFixtures()?.id || null,
        source: createHash('sha256').update(source).digest('hex')
    })).digest('hex');
}

export function clearPreflightFailureCache(): void {
    preflightCaches = new WeakMap();
}

/** An explicit recheck must observe repaired dependencies in this execution.
 * Other executions and in-flight workers retain their own lifecycle and cache.
 * Ordinary per-target checks still share failures until the next explicit scan.
 */
export function invalidateCurrentPreflightFailures(): number {
    const execution = currentExecution();
    const failures = execution ? preflightCaches.get(execution)?.failures : undefined;
    const removed = failures?.size || 0;
    failures?.clear();
    return removed;
}

export function preflightFailureCacheSize(): number {
    return currentCache()?.failures.size || 0;
}

export async function preflightTargetModule(python: string, file: string, module: string, importPaths: string[], cwd: string,
    dependencies: Array<{ module: string; name: string; level?: number }> = [], sourceRoot?: string) {
    const key = preflightKey(python, file, module, importPaths, cwd);
    const cache = currentCache();
    const cached = cache?.failures.get(key);
    if (cached) {
        throwIfExecutionCancelled();
        throw cached;
    }
    const pending = cache?.pending.get(key);
    if (pending) {
        // Share a failure, but a successful target must receive its own cwd /
        // output import roots rather than those of a concurrent target.
        await pending;
        throwIfExecutionCancelled();
        return executePreflight(python, file, module, importPaths, cwd, key, cache, dependencies, sourceRoot);
    }
    const operation = executePreflight(python, file, module, importPaths, cwd, key, cache, dependencies, sourceRoot);
    cache?.pending.set(key, operation);
    try { return await operation; }
    finally { cache?.pending.delete(key); }
}

async function executePreflight(python: string, file: string, module: string, importPaths: string[], cwd: string,
    key: string, cache?: PreflightCache, dependencies: Array<{ module: string; name: string; level?: number }> = [],
    sourceRoot?: string): Promise<PreflightResult> {
    try {
        const result = await runSpawn(python, ['-B', pythonToolPath('preflight')], {
            cwd, env: buildGeneratedTestEnvironment(process.env, importPaths), timeout: 15000,
            input: JSON.stringify({ file, module, importPaths, dependencies, sourceRoot })
        });
        throwIfExecutionCancelled();
        if (result.code !== 0) {
            throw toolFailure('process-failed', { exitCode: result.code });
        }
        let value: any;
        try { value = JSON.parse(result.stdout); }
        catch { throw toolFailure('invalid-result'); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') {
            throw toolFailure('invalid-result');
        }
        if (value.ok === false) {
            if (!['module-import', 'module-resolution'].includes(value.stage) || typeof value.reason !== 'string') {
                throw toolFailure('invalid-result');
            }
            const error = new AnalysisStageError('environment', value.stage || 'module-preflight',
                localize("被測模組尚不可在隔離環境載入：{0}", value.reason || 'unknown'),
                value.importFixtures ? { ...value.diagnostic, importFixtures: value.importFixtures } : value.diagnostic);
            if (value.stage === 'module-import' || value.stage === 'module-resolution') {
                cache?.failures.set(key, error);
            }
            throw error;
        }
        if (value.sourceVersionsVersion !== SOURCE_VERSIONS_VERSION || !validSourceVersions(value.sourceVersions)) {
            throw toolFailure('invalid-result', { detailCode: 'missing-or-invalid-source-versions' });
        }
        // Missing/old/malformed optional evidence never authorizes filtering.
        // Keep the successful import; the caller must retain all resources.
        const resourceScope = parsePreflightResourceScope(value.resourceScope, value.sourceVersions);
        const { resourceScope: _untrustedResourceScope, ...preflight } = value;
        return { ...preflight, ...(resourceScope ? { resourceScope } : {}) } as PreflightResult;
    } catch (error) {
        throwIfExecutionCancelled();
        const stageError = error instanceof AnalysisStageError ? error
            : toolFailure(error instanceof ProcessTimeoutError ? 'timeout' : 'process-failed');
        throw stageError;
    }
}
