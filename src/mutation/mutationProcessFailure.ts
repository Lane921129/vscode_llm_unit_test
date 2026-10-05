import { localize } from '../i18n/core';
import { summarizeImportException } from '../environment/importDiagnostics';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const errorCodes = new Set(['invalid-arguments', 'external-engine-unavailable', 'external-engine-execution-failed']);
const diagnosticCodes = new Set(['package-missing', 'unsupported-version', 'unsupported-platform',
    'adapter-unavailable', 'self-check-failed', 'adapter-execution-failed', 'adapter-contract-mismatch']);

/** Preserve bounded, known diagnostics, not arbitrary stdout, source lines or credentials. */
export function mutationProcessFailure(engine: string, result: { code: number | null; stdout: string; stderr: string }): AnalysisStageError {
    let stdout: { error?: string; diagnosticCode?: string } | undefined;
    try {
        const value = result.stdout.length <= 16_384 ? JSON.parse(result.stdout) : undefined;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const error = errorCodes.has(value.error) ? value.error : undefined;
            const diagnosticCode = diagnosticCodes.has(value.diagnosticCode) ? value.diagnosticCode : undefined;
            if (error || diagnosticCode) { stdout = { error, diagnosticCode }; }
        }
    } catch { /* Traceback fallback below. */ }
    const exception = result.stderr.slice(-8192).split(/\r?\n/).reverse()
        .map(line => /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:Error|Exception)):\s*(.*)$/.exec(line))
        .find(match => match !== null);
    const stderr = exception ? summarizeImportException({ exception_type: exception[1], message: exception[2] }) : undefined;
    const reason = stdout?.diagnosticCode || stdout?.error
        || (stderr ? `${stderr.exceptionType}: ${stderr.message}` : 'no-structured-diagnostic');
    return new AnalysisStageError('mutation', 'mutation-execution',
        localize('突變引擎 {0} 執行失敗；已停止，不改用其他引擎。', engine)
            + ` (exitCode=${result.code ?? 'signal'}; ${reason})`,
        { engine, exitCode: result.code, reason, stdout, stderr });
}
