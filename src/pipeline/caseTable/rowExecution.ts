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
import { assessTargetCoverageEvidence } from '../../mutation/targetCoverage';
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
export async function runTestFile(runtime: RowRuntime, module: string, code: string, useCoverage = false): Promise<MethodRun> {
    const testFile = path.join(runtime.artifacts, `${module}.py`);
    fs.writeFileSync(testFile, code, { encoding: 'utf8', flag: 'wx' });
    const evidence = path.join(runtime.artifacts, `${module}.invocation.json`);
    const resultFile = path.join(runtime.artifacts, `${module}.runner.json`);
    const args = [...generatedUnittestArguments(module, path.dirname(runtime.sourceFile), useCoverage, true),
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

export interface CoverageMeasurement {
    available: boolean;
    /** Covered share of the target's executable lines, 0-100. */
    linePercent: number | null;
    executableLines: number;
    missingLines: number[];
    /** null when branch data could not be determined. */
    branchesCovered: boolean | null;
    missingBranches: string[];
    reasonCode?: string;
}

/**
 * Line and branch coverage of the merged formal test file with the existing tools
 * (generated_test_runner --coverage-source, coverage_read.py, assessTargetCoverageEvidence).
 * Failure only yields a reason code; it never changes the usable verdict.
 */
export async function measureCoverage(runtime: RowRuntime, code: string): Promise<CoverageMeasurement> {
    const unavailable = (reasonCode: string): CoverageMeasurement => ({ available: false, linePercent: null, executableLines: 0,
        missingLines: [], branchesCovered: null, missingBranches: [], reasonCode });
    try {
        const module = 'test_case_table_coverage';
        const run = await runTestFile(runtime, module, code, true);
        if (!run.passed || !run.targetObserved) { return unavailable('coverage-run-failed'); }
        const evidence = path.join(runtime.artifacts, `${module}.invocation.json`);
        const invocation = JSON.parse(fs.readFileSync(evidence, 'utf8'));
        const expectedRun = { testRunId: String(invocation.testRunId), testHash: String(invocation.testHash) };
        const read = await runSpawn(runtime.python, ['-B', pythonToolPath('coverage'), runtime.sourceFile, runtime.target,
            '--invocation-evidence', evidence, '--expected-run-id', expectedRun.testRunId, '--expected-test-hash', expectedRun.testHash],
            { cwd: runtime.artifacts, env: environment(runtime), timeout: 10000 });
        if (read.code !== 0) { return unavailable('coverage-read-failed'); }
        fs.writeFileSync(path.join(runtime.artifacts, 'coverage.json'), read.stdout, 'utf8');
        const assessment = assessTargetCoverageEvidence(read.stdout, runtime.sourceFile, runtime.target, sha256File(runtime.sourceFile), expectedRun);
        if (!assessment.available || !assessment.executableTargetLines) { return unavailable(assessment.reason || 'coverage-unavailable'); }
        const executable = assessment.executableTargetLines.length;
        const missing = assessment.missingTargetLines ?? [];
        return { available: true, linePercent: executable ? Math.round(((executable - missing.length) / executable) * 1000) / 10 : null,
            executableLines: executable, missingLines: missing, branchesCovered: assessment.targetBranchesCovered ?? null,
            missingBranches: assessment.missingTargetBranches ?? [] };
    } catch {
        return unavailable('coverage-failed');
    }
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

/**
 * A Bug Fixer edit may only change setup: target calls, every self.assert* call, mock setup
 * and the control flow around calls and assertions must stay AST-identical (case_row_assertions.py).
 */
export async function fixPreservesContract(runtime: RowRuntime, before: string, after: string, method: string,
    callees: readonly string[]): Promise<{ accepted: boolean; violations: string[] }> {
    const run = await runSpawn(runtime.python, ['-B', pythonToolPath('caseRowAssertions')],
        { env: environment(runtime), timeout: 10000, input: JSON.stringify({ before, after, method, callees }) });
    try {
        const report = JSON.parse(run.stdout);
        const violations = Array.isArray(report.violations) ? report.violations.filter((item: unknown) => typeof item === 'string') : ['invalid-report'];
        return { accepted: report.accepted === true && violations.length === 0, violations };
    } catch { return { accepted: false, violations: ['invalid-report'] }; }
}
