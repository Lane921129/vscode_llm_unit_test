/**
 * Per-row capture and per-method execution for the v2 pipeline (architecture section 4 rows 5 and 8).
 *
 * Each row is captured in its own process, and each generated method runs alone
 * through the existing generated_test_runner (same isolation guard and target
 * invocation evidence as v1). Passing methods are merged and measured with the
 * existing mutation engines.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pythonToolPath } from '../pythonTools';
import { runSpawn } from '../../utils/processRunner';
import { buildGeneratedTestEnvironment, generatedUnittestArguments } from '../../utils/pythonTestEnvironment';
import { mutationArguments, selectMutationEngine } from '../../mutation/mutationSelection';
import { MutationRun, mutationScore, parseIsolatedMutationRun } from '../../mutation/mutationResult';
import { CaseMock } from './caseTable';
import { CaseTableDependency } from './caseTableFacts';
import { ExceptionReference } from './rowToTest';

export interface CaptureRequestRow {
    id: string;
    args?: string;
    kwargs?: string;
    setup?: string;
    mocks: CaseMock[];
}

export interface CaptureReport {
    id: string;
    status: 'captured' | 'capture-failed';
    reason?: string;
    actual?: { kind: 'return' | 'raise'; value: string };
    exception?: { name: string; mro: string[]; reference: ExceptionReference | null };
}

export interface RowRuntime {
    python: string;
    sourceFile: string;
    target: string;
    importPaths: string[];
    artifacts: string;
}

const CAPTURE_TIMEOUT_MS = 30000;
const METHOD_TIMEOUT_MS = 30000;

export function sha256File(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function environment(runtime: RowRuntime): NodeJS.ProcessEnv {
    return buildGeneratedTestEnvironment(process.env, runtime.importPaths);
}

export async function captureRow(runtime: RowRuntime, row: CaptureRequestRow, dependencies: readonly CaseTableDependency[]): Promise<CaptureReport> {
    const request = { version: 'case-capture-request-v1', file: runtime.sourceFile, target: runtime.target,
        importPaths: runtime.importPaths, dependencies, row };
    let run: Awaited<ReturnType<typeof runSpawn>>;
    try {
        run = await runSpawn(runtime.python, ['-B', pythonToolPath('caseCapture')],
            { cwd: runtime.artifacts, env: environment(runtime), timeout: CAPTURE_TIMEOUT_MS, input: JSON.stringify(request) });
    } catch (error) {
        if ((error as Error)?.name === 'ProcessTimeoutError') { return { id: row.id, status: 'capture-failed', reason: 'capture-timeout' }; }
        throw error;
    }
    try {
        const report = JSON.parse(run.stdout) as CaptureReport & { error?: string };
        if (report.error || report.id !== row.id || !['captured', 'capture-failed'].includes(report.status)) {
            return { id: row.id, status: 'capture-failed', reason: 'capture-tool-error' };
        }
        return report;
    } catch {
        return { id: row.id, status: 'capture-failed', reason: 'capture-tool-error' };
    }
}

export interface MethodRun {
    passed: boolean;
    targetObserved: boolean;
    error: string;
    testFile: string;
}

/** Run one test file through generated_test_runner; `module` is the file stem inside runtime.artifacts. */
export async function runTestFile(runtime: RowRuntime, module: string, code: string): Promise<MethodRun> {
    const testFile = path.join(runtime.artifacts, `${module}.py`);
    fs.writeFileSync(testFile, code, { encoding: 'utf8', flag: 'wx' });
    const evidence = path.join(runtime.artifacts, `${module}.invocation.json`);
    const resultFile = path.join(runtime.artifacts, `${module}.runner.json`);
    const args = [...generatedUnittestArguments(module, path.dirname(runtime.sourceFile), false, true),
        '--target-file', runtime.sourceFile, '--target-name', runtime.target, '--target-test-file', testFile,
        '--target-evidence', evidence, '--target-run-id', randomUUID(),
        '--violation-report', path.join(runtime.artifacts, `${module}.isolation.jsonl`),
        '--result-json', resultFile];
    let run: Awaited<ReturnType<typeof runSpawn>>;
    try {
        run = await runSpawn(runtime.python, args, { cwd: runtime.artifacts, env: environment(runtime), timeout: METHOD_TIMEOUT_MS });
    } catch (error) {
        if ((error as Error)?.name === 'ProcessTimeoutError') { return { passed: false, targetObserved: false, error: 'Test method timed out.', testFile }; }
        throw error;
    }
    const read = (file: string): Record<string, unknown> | undefined => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
    };
    const result = read(resultFile);
    const invocation = read(evidence);
    const passed = run.code === 0 && result?.status === 'passed';
    const targetObserved = invocation?.observed === true && invocation?.status === 'passed';
    const output = `${run.stdout}\n${run.stderr}`.trim();
    return { passed, targetObserved, error: output.length > 3000 ? output.slice(output.length - 3000) : output, testFile };
}

export interface MutationMeasurement {
    run?: MutationRun;
    score: number | null;
    failure?: string;
}

export async function measureMutation(runtime: RowRuntime, testFile: string, options: {
    engine: unknown; workers: unknown; stageSeconds: number; className: string;
}): Promise<MutationMeasurement> {
    const env = environment(runtime);
    try {
        const selection = await selectMutationEngine(options.engine, options.workers,
            args => runSpawn(runtime.python, args, { env, timeout: 10000 }));
        const execution = await runSpawn(runtime.python,
            mutationArguments(selection, runtime.sourceFile, testFile, runtime.target.split('.').pop() || '', options.className, options.stageSeconds),
            { cwd: runtime.artifacts, env, timeout: (options.stageSeconds + 5) * 1000 });
        if (execution.code !== 0) { return { score: null, failure: `mutation-exit-${execution.code}` }; }
        const run = parseIsolatedMutationRun(execution.stdout, {
            sourcePath: runtime.sourceFile, sourceHash: sha256File(runtime.sourceFile), testHash: sha256File(testFile),
            targetScope: { kind: 'function', qualifiedName: runtime.target }, stageTimeoutSeconds: options.stageSeconds
        }, selection.actual);
        return { run, score: mutationScore(run) };
    } catch (error) {
        return { score: null, failure: (error as Error)?.message || 'mutation-failed' };
    }
}

/** Expectation dumps before/after a Bug Fixer edit must be identical. */
export async function sameAssertionExpectations(runtime: RowRuntime, before: string, after: string, method: string): Promise<boolean> {
    const run = await runSpawn(runtime.python, ['-B', pythonToolPath('caseRowAssertions')],
        { env: environment(runtime), timeout: 10000, input: JSON.stringify({ before, after, method }) });
    try {
        const report = JSON.parse(run.stdout);
        return report.parsed === true && report.sameName === true && report.expectationsEqual === true;
    } catch { return false; }
}
