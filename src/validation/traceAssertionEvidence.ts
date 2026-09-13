export interface TraceAssertionExample {
    args?: string[];
    kwargs?: Record<string, string>;
    result?: string;
    call_assertable?: boolean;
    result_assertable?: boolean;
}

export interface TraceAssertionEvidence {
    examples?: TraceAssertionExample[];
}

export interface TraceAssertionEvidenceValidation {
    valid: boolean;
    reason?: string;
}


import { runSpawn } from '../utils/processRunner';
import { pythonToolPath } from '../pipeline/pythonTools';

export async function validateTraceEvidence(
    code: string, target: string, trace: TraceAssertionEvidence | undefined,
    module: string, python: string, className?: string | null
): Promise<TraceAssertionEvidenceValidation> {
    const result = await runSpawn(python, ['-B', pythonToolPath('assertionEvidence')], {
        input: JSON.stringify({ code, target, trace: trace || {}, module, className }),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 5000
    });
    if (result.code !== 0) { return { valid: false, reason: 'Trace 證據檢查無法完成：' + result.stderr.slice(-500) }; }
    const parsed = JSON.parse(result.stdout);
    return typeof parsed.valid === 'boolean' ? parsed : { valid: false, reason: 'Trace 證據檢查輸出無效。' };
}
