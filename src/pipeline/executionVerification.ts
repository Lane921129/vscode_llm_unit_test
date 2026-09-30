import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnalysisJournal, evidenceHash } from './analysisJournal';
import { reserveArtifactFiles } from './artifactPaths';
import { ExecutionBaseline, verifyExecutionEvidence } from './executionEvidence';
import { validateTestCandidate, CandidatePipelineHooks } from './testCandidatePipeline';
import { generatedUnittestArguments } from '../utils/pythonTestEnvironment';
import { runSpawn } from '../utils/processRunner';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { throwIfExecutionCancelled } from './executionContext';
import { pythonToolPath } from './pythonTools';

interface ExecutionVerificationOptions {
    directory: string; file: string; target: string; python: string; env: NodeJS.ProcessEnv;
    dependencies: Array<{ file: string; hash: string }>; journal: AnalysisJournal;
    targetModule?: string;
    generate(): Promise<string>;
    hooks: Pick<CandidatePipelineHooks, 'validate' | 'revise' | 'repairRole' | 'validateRevision' | 'event'>;
}

/** Execution-only path: same validation/repair gates, no behavioral probes or quality measurements. */
export async function runExecutionVerification(options: ExecutionVerificationOptions): Promise<ExecutionBaseline> {
    const { directory, file, target, python, env, dependencies, journal, hooks } = options;
    let accepted: ExecutionBaseline | undefined;
    let attempt = 0;
    const expected = { runId: journal.runId, sourceHash: journal.sourceHash, target };
    const checkCurrent = () => {
        throwIfExecutionCancelled();
        let current = false;
        try {
            current = evidenceHash(fs.readFileSync(file, 'utf8')) === journal.sourceHash
                && dependencies.every(item => evidenceHash(fs.readFileSync(item.file, 'utf8')) === item.hash);
        } catch { /* Missing source invalidates the run as well. */ }
        if (!current) {
            journal.knowledge({ evidenceValid: false });
            throw new AnalysisStageError('validation', 'source-changed', '來源或相依已變更；請重新執行，舊證據不能計入通過。');
        }
    };
    checkCurrent();
    const initial = await options.generate();
    hooks.event('writer', 'candidate', { code: initial, validationMode: 'execution' });
    const candidate = await validateTestCandidate(initial, {
        ...hooks, reviewRequired: false, review: async () => undefined, checkCancelled: checkCurrent,
        repairExpectations: async (code, failure) => {
            if (!options.targetModule || !/^FAIL: test_/m.test(failure)) { return undefined; }
            checkCurrent();
            const result = await runSpawn(python, ['-B', pythonToolPath('sourceExpectations')], {
                input: JSON.stringify({ code, failure, source: fs.readFileSync(file, 'utf8'), target,
                    module: options.targetModule }), env, timeout: 5000
            });
            checkCurrent();
            if (result.code !== 0) {
                hooks.event('source-expectation-repair', 'unavailable', { reason: '算術檢查未完成，保留模型修復流程' });
                return undefined;
            }
            try {
                const value = JSON.parse(result.stdout);
                if (value.changed !== true || typeof value.code !== 'string' || !Array.isArray(value.corrections)
                    || value.corrections.length === 0 || value.basis !== 'source-derived-arithmetic-v1') { return undefined; }
                const [proofPath] = reserveArtifactFiles(directory, ['arithmetic'], 'json');
                const evidence = { basis: value.basis, limitation: value.limitation, sourceHash: journal.sourceHash,
                    previousTestHash: evidenceHash(code), candidateTestHash: evidenceHash(value.code), corrections: value.corrections };
                // reserveArtifactFiles already created this exclusively owned file.
                fs.writeFileSync(proofPath, JSON.stringify(evidence, null, 2), { encoding: 'utf8' });
                journal.knowledge({ expectationRepair: { file: path.basename(proofPath), ...evidence } });
                return { code: value.code, evidence };
            } catch {
                hooks.event('source-expectation-repair', 'unavailable', { reason: '算術檢查結果無效，保留模型修復流程' });
                return undefined;
            }
        },
        execute: async code => {
            checkCurrent();
            // Every executed candidate has its own immutable file and evidence.
            const testFile = `exec${++attempt}_test.py`;
            const testPath = path.join(directory, testFile);
            fs.writeFileSync(testPath, code, { encoding: 'utf8', flag: 'wx' });
            const [invocation, isolation] = reserveArtifactFiles(directory, ['invocation', 'isolation'], 'jsonl');
            const baseline: ExecutionBaseline = { schemaVersion: 'execution-baseline-v1', validationMode: 'execution',
                ...expected, testFile, testHash: evidenceHash(code), testRunId: randomUUID(),
                invocationFile: path.basename(invocation), isolationFile: path.basename(isolation), dependencyVersions: dependencies };
            const run = await runSpawn(python, [
                ...generatedUnittestArguments(path.basename(testFile, '.py'), path.dirname(file), false, true),
                '--target-file', file, '--target-name', target, '--target-test-file', testPath,
                '--target-evidence', invocation, '--target-run-id', baseline.testRunId, '--violation-report', isolation
            ], { cwd: directory, env, timeout: 30000 });
            checkCurrent();
            const ok = run.code === 0 && verifyExecutionEvidence(directory, file, baseline, expected);
            const out = (run.stdout + run.stderr).trim()
                + (!ok && run.code === 0 ? '\n執行證據不足：需有真正通過的案例、目標函式呼叫與完整隔離紀錄。' : '');
            if (ok) { accepted = baseline; }
            return { ok, out: out || 'No executable unittest cases', qualityGaps: [], testModule: path.basename(testFile, '.py') };
        }
    }, 2);
    checkCurrent();
    if (!accepted || accepted.testHash !== evidenceHash(candidate.code)
        || !verifyExecutionEvidence(directory, file, accepted, expected)) {
        throw new AnalysisStageError('validation', 'execution-evidence', '執行證據不完整，未計入通過。');
    }
    fs.writeFileSync(path.join(directory, 'execution_baseline.json'), JSON.stringify(accepted, null, 2), { encoding: 'utf8', flag: 'wx' });
    journal.knowledge({ terminalStatus: 'execution-passed', evidenceValid: true, executionVerified: true,
        executionBaseline: 'execution_baseline.json', acceptedTest: accepted.testFile, acceptedCodeHash: accepted.testHash,
        execution: candidate.execution.out, generationMode: 'llm-execution',
        traceStatus: 'deferred', coverage: null, mutationScore: null, mutationStatus: 'deferred',
        qualityAssessment: null, reviewStatus: 'deferred' });
    hooks.event('execution-verification', 'passed', { testFile: accepted.testFile, testHash: accepted.testHash });
    return accepted;
}
