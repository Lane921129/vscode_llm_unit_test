import * as fs from 'node:fs';
import { resultArtifactPath as artifact } from './resultLayout';
import { evidenceHash } from './analysisJournal';

export interface ExecutionBaseline {
    schemaVersion: 'execution-baseline-v1'; validationMode: 'execution';
    runId: string; sourceHash: string; target: string; testFile: string; testHash: string;
    testRunId: string; invocationFile: string; isolationFile: string;
    dependencyVersions: Array<{ file: string; hash: string }>;
}

function canonical(file: string): string {
    const value = fs.realpathSync(file);
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Re-read runner-owned artifacts and current source. A saved boolean alone is not proof. */
export function verifyExecutionEvidence(directory: string, sourceFile: string, baseline: ExecutionBaseline,
    expected: { runId: string; sourceHash: string; target: string }): boolean {
    try {
        if (baseline.schemaVersion !== 'execution-baseline-v1' || baseline.validationMode !== 'execution'
            || baseline.runId !== expected.runId || baseline.sourceHash !== expected.sourceHash
            || baseline.target !== expected.target || !baseline.testRunId
            || evidenceHash(fs.readFileSync(sourceFile, 'utf8')) !== expected.sourceHash
            || !Array.isArray(baseline.dependencyVersions)
            || baseline.dependencyVersions.some(item => evidenceHash(fs.readFileSync(item.file, 'utf8')) !== item.hash)) { return false; }
        const test = artifact(directory, baseline.testFile);
        if (evidenceHash(fs.readFileSync(test, 'utf8')) !== baseline.testHash) { return false; }
        const invocation = JSON.parse(fs.readFileSync(artifact(directory, baseline.invocationFile), 'utf8'));
        const result = invocation.testResult;
        if (invocation.schemaVersion !== 'target-invocation-v1' || invocation.status !== 'passed'
            || invocation.observed !== true || invocation.profileIntact !== true
            || invocation.testRunId !== baseline.testRunId || invocation.sourceHash !== baseline.sourceHash
            || invocation.testHash !== baseline.testHash || invocation.target !== baseline.target
            || canonical(invocation.canonicalFile) !== canonical(sourceFile)
            || canonical(invocation.canonicalTestFile) !== canonical(test)
            || !/^[a-f0-9]{64}$/.test(invocation.targetCodeHash) || invocation.coverageDataHash !== null
            || !result || ['testsRun', 'failures', 'errors', 'skipped', 'expectedFailures', 'unexpectedSuccesses']
                .some(key => !Number.isSafeInteger(result[key]) || result[key] < 0)
            || result.failures !== 0 || result.errors !== 0 || result.unexpectedSuccesses !== 0
            || result.testsRun <= result.skipped + result.expectedFailures) { return false; }
        const events = fs.readFileSync(artifact(directory, baseline.isolationFile), 'utf8')
            .trim().split(/\r?\n/).map(line => JSON.parse(line));
        return events.length === 2 && events[0].event === 'started' && events[1].event === 'completed'
            && events[1].status === 'passed' && /^[a-f0-9]{32}$/.test(events[0].runId)
            && events[0].runId === events[1].runId
            && events.every(event => event.policyVersion === 'python-execution-policy-v1'
                && event.targetRunId === baseline.testRunId && event.testHash === baseline.testHash
                && event.sourceHash === baseline.sourceHash);
    } catch { return false; }
}
