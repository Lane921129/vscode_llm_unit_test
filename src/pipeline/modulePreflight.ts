import { pythonToolPath } from './pythonTools';
import { runSpawn } from '../utils/processRunner';
import { buildGeneratedTestEnvironment } from '../utils/pythonTestEnvironment';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { currentExecution, ExecutionContext, throwIfExecutionCancelled } from './executionContext';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentImportFixtures } from './importFixtures';

export interface ResolvedDependency {
    module: string; name: string; level?: number; file?: string; resolvedModule?: string; reason?: string;
}

export interface PreflightResult {
    ok: true;
    module: string;
    importPaths: string[];
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
            throw new AnalysisStageError('environment', 'module-preflight',
                `模組預檢工具未完成：${(result.stderr || result.stdout).slice(-2000)}`);
        }
        const value = JSON.parse(result.stdout);
        if (value.ok !== true) {
            const error = new AnalysisStageError('environment', value.stage || 'module-preflight',
                `被測模組尚不可在隔離環境載入：${value.reason || 'unknown'}`,
                value.importFixtures ? { ...value.diagnostic, importFixtures: value.importFixtures } : value.diagnostic);
            if (value.stage === 'module-import' || value.stage === 'module-resolution') {
                cache?.failures.set(key, error);
            }
            throw error;
        }
        return value as PreflightResult;
    } catch (error) {
        throwIfExecutionCancelled();
        const stageError = error instanceof AnalysisStageError ? error
            : new AnalysisStageError('environment', 'module-preflight', `模組預檢無法完成：${String(error)}`);
        throw stageError;
    }
}
