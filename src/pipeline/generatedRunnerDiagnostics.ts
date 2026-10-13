import * as fs from 'node:fs';
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
const invalid = (): never => { throw new AnalysisStageError('validation', 'generated-test-runner',
    'Generated test runner diagnostics could not be verified.', { reasonCode: 'generated-test-diagnostics-invalid' }); };

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
