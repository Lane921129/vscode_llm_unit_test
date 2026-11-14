import * as fs from 'node:fs';
import { AnalysisStageError } from '../../utils/executionFailureCategory';
import { currentExecution } from '../executionContext';
import { ProcessExitDetails, ProcessTimeoutError, runSpawn } from '../../utils/processRunner';
import { normalizeKnownSecrets, redactCredentialStrings, WITHHELD_SENSITIVE_CONTENT } from '../artifactSafety';
import { hasSensitiveDiagnosticContent } from '../../environment/importDiagnostics';
import { safeLine } from '../../llm/modelOutputDiagnostics';

export interface RunnerContext {
    rowId?: string | null;
    resultFile?: string;
    knownSecrets?: readonly string[];
}

export interface RunnerDiagnostic {
    version: 'runner-diagnostics-v1';
    reasonCode: string;
    operation: string;
    rowId: string | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    runnerJsonExists: boolean;
}

/** Apply the v1 credential/location rules before truncation, so a cutoff cannot expose a partial secret. */
function safeTail(text: string, secrets: readonly string[]): string {
    const redacted = String(redactCredentialStrings(text, secrets));
    return redacted.split(/\r?\n/).map(line => hasSensitiveDiagnosticContent(line) ? WITHHELD_SENSITIVE_CONTENT : safeLine(line, secrets)).join('\n').slice(-1500);
}

export function runnerDiagnostic(operation: string, code: number | null,
    evidence: Partial<ProcessExitDetails> & RunnerContext = {}, reasonCode = 'runner-crashed'): RunnerDiagnostic {
    const secrets = normalizeKnownSecrets(evidence.knownSecrets ?? []);
    return { version: 'runner-diagnostics-v1', reasonCode, operation, rowId: evidence.rowId ?? null,
        exitCode: code, signal: evidence.signal ?? null, timedOut: evidence.timedOut ?? false,
        stdout: safeTail(evidence.stdout ?? '', secrets), stderr: safeTail(evidence.stderr ?? '', secrets),
        runnerJsonExists: !!evidence.resultFile && fs.existsSync(evidence.resultFile) };
}

export function isRunnerDiagnostic(value: unknown): value is RunnerDiagnostic {
    return !!value && typeof value === 'object' && (value as RunnerDiagnostic).version === 'runner-diagnostics-v1';
}

export function runnerCrashed(operation: string, code: number | null,
    evidence: Partial<ProcessExitDetails> & RunnerContext = {}): AnalysisStageError {
    return new AnalysisStageError('tool', 'case-table-runner', `The ${operation} runner did not complete its result report.`,
        runnerDiagnostic(operation, code, evidence));
}

/** Observe close before rejection; cleanup, budgets and cancellation remain owned by runSpawn. */
export async function runRowProcess(command: string, args: string[], options: Parameters<typeof runSpawn>[2],
    operation: string, context: RunnerContext = {}) {
    let exit: ProcessExitDetails | undefined;
    try {
        const result = await runSpawn(command, args, { ...options, onExit: detail => { exit = detail; options.onExit?.(detail); } });
        return { ...result, signal: exit?.signal ?? null, timedOut: exit?.timedOut ?? false };
    } catch (error) {
        if (error instanceof AnalysisStageError || currentExecution()?.cancelled) { throw error; }
        if (error instanceof ProcessTimeoutError) {
            throw new AnalysisStageError('timeout', 'case-table-runner', `The ${operation} runner timed out.`,
                { ...runnerDiagnostic(operation, exit?.code ?? null, { ...exit, ...context, timedOut: true }, 'runner-timeout'),
                    timeoutMs: error.timeoutMs });
        }
        throw runnerCrashed(operation, exit?.code ?? null, { ...exit, ...context });
    }
}
