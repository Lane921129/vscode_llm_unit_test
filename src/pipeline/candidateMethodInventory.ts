import { evidenceHash } from './analysisJournal';
import { pythonToolPath } from './pythonTools';
import { ProcessTimeoutError, runSpawn } from '../utils/processRunner';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { ScenarioIdentity } from '../validation/scenarioIdentity';

export interface CandidateSyntaxDiagnostic { kind: 'SyntaxError' | 'IndentationError' | 'TabError'; line: number | null; column: number | null }
export type CandidateMethodInventory = { status: 'parsed'; methods: ScenarioIdentity[] }
    | { status: 'syntax-error'; reasonCode: 'python-syntax-error'; syntax: CandidateSyntaxDiagnostic };
const keys = (value: any, allowed: string[]) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
const coordinate = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;

/** No application import, generated-code execution, arbitrary stderr or source-line echo. */
export async function readCandidateMethodInventory(options: { code: string; python: string; env?: NodeJS.ProcessEnv }): Promise<CandidateMethodInventory> {
    const failure = (reasonCode: string): never => {
        throw new AnalysisStageError('validation', 'candidate-inventory-tool',
            'The Python method inventory tool did not complete; this is not a model syntax verdict.', { reasonCode });
    };
    const result = await runSpawn(options.python, ['-B', pythonToolPath('scenarios'), '--diagnostics'], {
        input: options.code, timeout: 5000, env: options.env }).catch(error => {
        if (error instanceof ProcessTimeoutError) { return failure('inventory-timeout'); }
        throw error;
    });
    if (result.code !== 0) { return failure('inventory-process-failed'); }
    let value: any;
    try { value = JSON.parse(result.stdout); } catch { return failure('inventory-invalid-response'); }
    if (!keys(value, ['version', 'codeHash', 'status', 'methods', 'reasonCode', 'syntax'])
        || value.version !== 'candidate-method-inventory-v1') { return failure('inventory-invalid-response'); }
    if (value.status === 'unavailable') {
        if (!['inventory-method-limit', 'inventory-parser-limit', 'inventory-input-limit', 'inventory-input-encoding'].includes(value.reasonCode)) {
            return failure('inventory-invalid-response');
        }
        return failure(value.reasonCode);
    }
    if (value.codeHash !== evidenceHash(options.code)) { return failure('inventory-identity-mismatch'); }
    if (value.status === 'syntax-error' && value.reasonCode === 'python-syntax-error'
        && keys(value.syntax, ['kind', 'line', 'column']) && ['SyntaxError', 'IndentationError', 'TabError'].includes(value.syntax.kind)
        && coordinate(value.syntax.line) && coordinate(value.syntax.column)) {
        return { status: 'syntax-error', reasonCode: 'python-syntax-error', syntax: {
            kind: value.syntax.kind, line: value.syntax.line, column: value.syntax.column } };
    }
    if (value.status !== 'parsed' || !Array.isArray(value.methods) || value.methods.length > 256
        || value.methods.some((method: any) => !keys(method, ['id', 'fingerprint']) || typeof method.id !== 'string'
            || method.id.length > 512 || typeof method.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(method.fingerprint))) {
        return failure('inventory-invalid-response');
    }
    return { status: 'parsed', methods: value.methods.map(({ id, fingerprint }: ScenarioIdentity) => ({ id, fingerprint })) };
}
