import { spawn } from 'child_process';
import { assessTestGenerationProbe, extractQualificationProbeCode, StructuredOutputProbeResult } from './testGenerationQualification';

type ProbeExecutor = (code: string) => Promise<boolean>;

const PROBE_RUNNER = [
    'import sys, types, unittest',
    'code = sys.stdin.read()',
    'module = types.ModuleType("llm_unit_probe")',
    'module.__file__ = "<llm_unit_probe>"',
    'exec(compile(code, module.__file__, "exec"), module.__dict__)',
    'suite = unittest.defaultTestLoader.loadTestsFromModule(module)',
    'result = unittest.TextTestRunner(verbosity=0).run(suite)',
    'raise SystemExit(0 if result.wasSuccessful() else 1)',
].join('; ');

function probeCode(payload: unknown): string | undefined {
    const response = payload && typeof payload === 'object'
        ? (payload as { response?: unknown }).response
        : undefined;
    if (typeof response !== 'string') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(response) as unknown;
        if (parsed && typeof parsed === 'object' && typeof (parsed as { code?: unknown }).code === 'string') {
            return (parsed as { code: string }).code.trim();
        }
    } catch {
        // Plain-Python compatibility output is handled below.
    }
    return extractQualificationProbeCode(response);
}

/** Permit only the tiny self-contained fixture before executing model output. */
export interface IsolatedProbeCodeAssessment {
    valid: boolean;
    reason?: string;
}

export function assessIsolatedProbeCode(code: string): IsolatedProbeCodeAssessment {
    const allowed = [
        /^import unittest$/,
        /^def increment\(value\):(?: return value \+ 1)?$/,
        /^return value \+ 1$/,
        /^class Test[A-Za-z_]\w*\(unittest\.TestCase\):$/,
        /^def test_[A-Za-z_]\w*\(self\):$/,
        /^self\.assertEqual\(increment\(1\), 2\)$/,
        /^self\.assertEqual\(2, increment\(1\)\)$/,
        /^self\.assertEqual\(increment\(-1\), 0\)$/,
        /^self\.assertEqual\(0, increment\(-1\)\)$/,
        /^if __name__ == ['"]__main__['"]:$/,
        /^unittest\.main\(\)$/,
        /^unittest\.main\(\s*verbosity\s*=\s*\d+\s*\)$/,
        /^#.*$/,
    ];
    const lines = code.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const unsupportedLines = lines.filter(line => !allowed.some(pattern => pattern.test(line)));
    return unsupportedLines.length === 0 && lines.length > 0
        ? { valid: true }
        : {
            valid: false,
            reason: `模型探測碼含 ${unsupportedLines.length || 1} 行最小安全 fixture 不允許的語句。`
        };
}

export function isIsolatedProbeCode(code: string): boolean {
    return assessIsolatedProbeCode(code).valid;
}

export function runIsolatedProbe(code: string, timeoutMs = 3000): Promise<boolean> {
    return new Promise(resolve => {
        const process = spawn('python', ['-I', '-c', PROBE_RUNNER], {
            stdio: ['pipe', 'ignore', 'ignore'],
            shell: false,
            windowsHide: true,
        });
        const timer = setTimeout(() => {
            process.kill();
            resolve(false);
        }, timeoutMs);
        process.once('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
        process.once('close', exitCode => {
            clearTimeout(timer);
            resolve(exitCode === 0);
        });
        process.stdin.end(code);
    });
}

/** Verify structure, constrain the fixture, then execute it in isolated Python. */
export async function verifyRunnableTestGenerationProbe(
    payload: unknown,
    executor: ProbeExecutor = runIsolatedProbe
): Promise<StructuredOutputProbeResult> {
    const assessment = assessTestGenerationProbe(payload);
    if (assessment.capability !== 'verified') {
        return assessment;
    }
    const code = probeCode(payload);
    if (!code) {
        return { capability: 'unverified', reason: '模型沒有可執行的測試程式碼。', responsePreview: assessment.responsePreview };
    }
    const safety = assessIsolatedProbeCode(code);
    if (!safety.valid) {
        return {
            capability: 'unverified',
            reason: safety.reason || '模型探測碼未符合可安全隔離執行的最小 unittest fixture。',
            responsePreview: assessment.responsePreview
        };
    }
    return await executor(code)
        ? { capability: 'verified', reason: '模型已通過 unittest 結構、雙案例行為 assertion 與隔離執行驗證。', responsePreview: assessment.responsePreview }
        : { capability: 'unverified', reason: '模型輸出的 unittest 未能在隔離 Python 環境執行通過。', responsePreview: assessment.responsePreview };
}
