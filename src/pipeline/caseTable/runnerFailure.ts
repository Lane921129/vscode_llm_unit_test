import { AnalysisStageError } from '../../utils/executionFailureCategory';
import { currentExecution } from '../executionContext';
import { ProcessTimeoutError, runSpawn } from '../../utils/processRunner';

export function runnerCrashed(operation: string, code: number | null): AnalysisStageError {
    return new AnalysisStageError('tool', 'case-table-runner', `The ${operation} runner did not complete its result report.`,
        { reasonCode: 'runner-crashed', operation, exitCode: code });
}

/** Keep failures local to v2; runSpawn still owns process-tree termination and resource cleanup. */
export async function runRowProcess(command: string, args: string[], options: Parameters<typeof runSpawn>[2], operation: string) {
    try { return await runSpawn(command, args, options); }
    catch (error) {
        if (error instanceof AnalysisStageError || currentExecution()?.cancelled) { throw error; }
        if (error instanceof ProcessTimeoutError) {
            throw new AnalysisStageError('timeout', 'case-table-runner', `The ${operation} runner timed out.`,
                { reasonCode: 'runner-timeout', operation, timeoutMs: error.timeoutMs });
        }
        throw runnerCrashed(operation, null);
    }
}
