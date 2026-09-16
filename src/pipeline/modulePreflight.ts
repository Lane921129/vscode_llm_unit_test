import { pythonToolPath } from './pythonTools';
import { runSpawn } from '../utils/processRunner';
import { buildGeneratedTestEnvironment } from '../utils/pythonTestEnvironment';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { throwIfExecutionCancelled } from './executionContext';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface CachedPreflightFailure {
    key: string;
    error: AnalysisStageError;
}

// A missing dependency is deterministic for the same interpreter, source and
// import roots. Cache only failures so repeated batch entries do not relaunch
// the same failing import, while a source or environment change creates a new
// key and gets a fresh check.
const preflightFailures = new Map<string, CachedPreflightFailure>();

function preflightKey(python: string, file: string, module: string, importPaths: string[], cwd: string): string {
    const source = fs.readFileSync(file);
    return createHash('sha256').update(JSON.stringify({
        python: path.resolve(python), file: path.resolve(file), module,
        importPaths: importPaths.map(item => path.resolve(item)).filter(item => item !== path.resolve(cwd)).sort(),
        source: createHash('sha256').update(source).digest('hex')
    })).digest('hex');
}

export function clearPreflightFailureCache(): void {
    preflightFailures.clear();
}

export function preflightFailureCacheSize(): number {
    return preflightFailures.size;
}

export async function preflightTargetModule(python: string, file: string, module: string, importPaths: string[], cwd: string) {
    const key = preflightKey(python, file, module, importPaths, cwd);
    const cached = preflightFailures.get(key);
    if (cached) {
        throwIfExecutionCancelled();
        throw cached.error;
    }
    try {
        const result = await runSpawn(python, ['-B', pythonToolPath('preflight')], {
            cwd, env: buildGeneratedTestEnvironment(process.env, importPaths), timeout: 15000,
            input: JSON.stringify({ file, module, importPaths })
        });
        throwIfExecutionCancelled();
        if (result.code !== 0) {
            throw new AnalysisStageError('environment', 'module-preflight',
                `模組預檢工具未完成：${(result.stderr || result.stdout).slice(-2000)}`);
        }
        const value = JSON.parse(result.stdout);
        if (value.ok !== true) {
            const error = new AnalysisStageError('environment', value.stage || 'module-preflight',
                `被測模組尚不可在隔離環境載入：${value.reason || 'unknown'}`, value.diagnostic);
            preflightFailures.set(key, { key, error });
            throw error;
        }
        return value as { ok: true; module: string; importPaths: string[] };
    } catch (error) {
        throwIfExecutionCancelled();
        const stageError = error instanceof AnalysisStageError ? error
            : new AnalysisStageError('environment', 'module-preflight', `模組預檢無法完成：${String(error)}`);
        preflightFailures.set(key, { key, error: stageError });
        throw stageError;
    }
}
