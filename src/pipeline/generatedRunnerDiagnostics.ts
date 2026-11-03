import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalExistingPath } from '../utils/fileIdentity';
import { AnalysisStageError } from '../utils/executionFailureCategory';

export interface GeneratedRunnerDiagnosticIdentity {
    resultFile: string; invocationFile: string; sourceFile: string; testFile: string;
    target: string; testRunId: string; sourceHash: string; testHash: string;
}

export interface GeneratedRunnerDiagnostic {
    version: 'generated-test-load-diagnostics-v1';
    reasonCode: 'generated-test-load-failed' | 'generated-test-identity-mismatch' | 'generated-test-loader-error';
    failedTests: number; truncated: boolean; repairRole: 'writer' | 'none';
    target: string; testRunId: string; sourceHash: string; testHash: string;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');
const localPath = (value: unknown): value is string => typeof value === 'string' && !!value
    && !/^[\\/]{2}/.test(value) && !/^\\\?\?\\/.test(value);
const invalid = (): never => { throw new AnalysisStageError('tool', 'generated-test-runner',
    'Generated test runner diagnostics could not be verified.', { reasonCode: 'generated-test-diagnostics-invalid' }); };

/** Call only after the current runner artifacts authorize whole-candidate Writer repair. */
export function generatedLoadRepairFeedback(output: string): string {
    return 'GENERATED_TEST_LOAD_FAILED: Repair the generated test imports or module/class setup shown in the actual failure. '
        + 'Check decorator arguments and fixture construction, using the canonical target binding. '
        + 'Do not guess packages, change application source or treat this load failure as a target exception oracle.\n'
        + output.trim();
}

/** Timeout diagnostics identify a currently entered test body, never a pass or
 * coverage result. A fixture/load timeout has no authorized method repair. */
export function readNativeTimeoutFeedback(expected: {
    progressFile: string; sourceFile: string; testFile: string; target: string;
    testRunId: string; sourceHash: string; testHash: string; timeoutMs: number;
}): string | undefined {
    try {
        if (!localPath(expected.progressFile) || fs.statSync(expected.progressFile).size > 1048576
            || digest(expected.sourceFile) !== expected.sourceHash || digest(expected.testFile) !== expected.testHash) { return undefined; }
        const text = fs.readFileSync(expected.progressFile, 'utf8');
        if (!text.endsWith('\n')) { return undefined; }
        const rows = text.trim().split('\n').map(line => JSON.parse(line));
        if (!rows.length || rows.length > 1024 || rows.some(row => !record(row)
            || row.schemaVersion !== 'generated-test-progress-v1' || row.testRunId !== expected.testRunId
            || row.sourceHash !== expected.sourceHash || row.testHash !== expected.testHash || row.target !== expected.target
            || !localPath(row.canonicalFile) || !localPath(row.canonicalTestFile)
            || canonicalExistingPath(row.canonicalFile) !== canonicalExistingPath(expected.sourceFile)
            || canonicalExistingPath(row.canonicalTestFile) !== canonicalExistingPath(expected.testFile)
            || !['fixture', 'test-body-active', 'test-body-completed'].includes(String(row.phase)))) { return undefined; }
        const last = rows[rows.length - 1];
        if (last.phase !== 'test-body-active' || typeof last.testId !== 'string') { return undefined; }
        const parts = last.testId.split('.');
        if (parts.length !== 3 || parts[0] !== path.basename(expected.testFile, '.py')
            || !/^[A-Za-z_]\w*$/.test(parts[1]) || !/^test_[A-Za-z0-9_]+$/.test(parts[2])) { return undefined; }
        return `ERROR: ${parts[2]} (${last.testId})\n`
            + `CandidateExecutionTimeout: the runner terminated this active test body after ${expected.timeoutMs} ms.\n`
            + 'No completed native result or coverage evidence is available. Repair only this test method. '
            + 'Inspect source-awaited waits, pagination termination and controlled dependency sequences at their actual source lookup points. '
            + 'Keep the real target and meaningful assertions; do not increase timeouts or infer an expected result from this timeout. '
            + 'The revised candidate must execute and pass all required review and quality gates again.';
    } catch { return undefined; }
}

function boundedJson(file: string): unknown {
    const size = fs.statSync(file).size;
    if (size <= 0 || size > 131072) { return invalid(); }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Read runner-owned load verdicts only after proving both artifacts and current byte identities. */
export function readGeneratedRunnerDiagnostics(expected: GeneratedRunnerDiagnosticIdentity): GeneratedRunnerDiagnostic | undefined {
    try {
        // Old runner/stub results can omit this optional diagnosis. Existing
        // execution, target-invocation and mutation success gates still apply.
        if (!fs.existsSync(expected.resultFile) || fs.statSync(expected.resultFile).size === 0) { return undefined; }
        const result = boundedJson(expected.resultFile);
        if (!record(result)) { return invalid(); }
        if (!Object.prototype.hasOwnProperty.call(result, 'loadDiagnostics')) { return undefined; }
        const diagnostic = result.loadDiagnostics;
        if (!record(diagnostic) || !exactKeys(diagnostic, ['version', 'reasonCode', 'failedTests', 'truncated'])
            || diagnostic.version !== 'generated-test-load-diagnostics-v1' || diagnostic.truncated !== false
            || !Number.isSafeInteger(diagnostic.failedTests) || Number(diagnostic.failedTests) < 0
            || Number(diagnostic.failedTests) > 32
            || !['generated-test-load-failed', 'generated-test-identity-mismatch', 'generated-test-loader-error'].includes(String(diagnostic.reasonCode))) { return invalid(); }
        const identity = result.identity, invocation = boundedJson(expected.invocationFile);
        if (!hash(expected.sourceHash) || !hash(expected.testHash) || !expected.testRunId
            || !expected.target || expected.target.length > 1024
            || !localPath(expected.sourceFile) || !localPath(expected.testFile)
            || digest(expected.sourceFile) !== expected.sourceHash || digest(expected.testFile) !== expected.testHash
            || result.schemaVersion !== 'generated-test-result-v1' || result.status !== 'runner-error'
            || !record(identity) || !exactKeys(identity, ['version', 'testRunId', 'canonicalFile', 'canonicalTestFile', 'target', 'sourceHash', 'testHash'])
            || identity.version !== 'generated-test-result-identity-v1' || !record(invocation)
            || invocation.schemaVersion !== 'target-invocation-v1' || invocation.status !== 'failed'
            || invocation.profileIntact !== true || invocation.observed !== false || !hash(invocation.targetCodeHash)) { return invalid(); }
        for (const artifact of [identity, invocation]) {
            if (artifact.testRunId !== expected.testRunId || artifact.target !== expected.target
                || artifact.sourceHash !== expected.sourceHash || artifact.testHash !== expected.testHash
                || !localPath(artifact.canonicalFile) || !localPath(artifact.canonicalTestFile)
                || canonicalExistingPath(artifact.canonicalFile) !== canonicalExistingPath(expected.sourceFile)
                || canonicalExistingPath(artifact.canonicalTestFile) !== canonicalExistingPath(expected.testFile)) { return invalid(); }
        }
        const failed = Number(diagnostic.failedTests), failures = result.testFailures;
        if (!Array.isArray(failures) || !Number.isSafeInteger(result.testsRun)) { return invalid(); }
        if (diagnostic.reasonCode === 'generated-test-load-failed') {
            const summary = invocation.testResult;
            if (failed < 1 || result.testsRun !== failed || failures.length !== failed
                || failures.some(item => !record(item) || !exactKeys(item, ['testId', 'kind', 'phase'])
                    || item.testId !== null || item.kind !== 'error' || item.phase !== 'fixture-or-load')
                || !record(summary) || !exactKeys(summary, ['testsRun', 'failures', 'errors', 'skipped', 'expectedFailures', 'unexpectedSuccesses'])
                || summary.testsRun !== failed || summary.errors !== failed || summary.failures !== 0
                || summary.skipped !== 0 || summary.expectedFailures !== 0 || summary.unexpectedSuccesses !== 0) { return invalid(); }
        } else if (failed !== 0 || result.testsRun !== 0 || failures.length !== 0 || invocation.testResult !== null) { return invalid(); }
        return { version: 'generated-test-load-diagnostics-v1',
            reasonCode: diagnostic.reasonCode as GeneratedRunnerDiagnostic['reasonCode'], failedTests: failed, truncated: false,
            repairRole: diagnostic.reasonCode === 'generated-test-load-failed' ? 'writer' : 'none',
            target: expected.target, testRunId: expected.testRunId, sourceHash: expected.sourceHash, testHash: expected.testHash };
    } catch (error) {
        if (error instanceof AnalysisStageError) { throw error; }
        return invalid();
    }
}
