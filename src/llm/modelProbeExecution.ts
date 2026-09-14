import { spawn } from 'child_process';
import { assessTestGenerationProbe, extractQualificationProbeCode, StructuredOutputProbeResult } from './testGenerationQualification';
import { MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS } from './connectionTimeout';

type ProbeExecutor = (code: string) => Promise<boolean>;

const PROBE_RUNNER = [
    'import sys, types, unittest',
    'code = sys.stdin.read()',
    'module = types.ModuleType("llm_unit_probe")',
    'module.__file__ = "<llm_unit_probe>"',
    'fixture = "def increment(value):\\n    return value + 1\\n"',
    'exec(compile(fixture, module.__file__, "exec"), module.__dict__)',
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

const PROBE_STRING_LITERAL = String.raw`(?:[rRuU]{0,2})?(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`;

function probeTestCaseBases(lines: string[]): string[] {
    const bases = new Set<string>();
    for (const line of lines) {
        const namespaceImport = line.match(/^import unittest(?:\s+as\s+([A-Za-z_]\w*))?$/);
        if (namespaceImport) {
            bases.add(`${namespaceImport[1] || 'unittest'}.TestCase`);
            continue;
        }
        const directImport = line.match(/^from unittest import TestCase(?:\s+as\s+([A-Za-z_]\w*))?$/);
        if (directImport) {
            bases.add(directImport[1] || 'TestCase');
        }
    }
    return [...bases];
}

function isSafeProbeAssertion(line: string): boolean {
    const fixtureTerm = '(?:increment\\(\\s*(?:1|-1)\\s*\\)|[A-Za-z_]\\w*|2|0)';
    return new RegExp(
        '^self\\.assertEqual\\(\\s*' + fixtureTerm + '\\s*,\\s*' + fixtureTerm
        + '(?:\\s*,\\s*' + PROBE_STRING_LITERAL + ')?\\s*\\)$'
    ).test(line);
}

function isSafeProbeAssignment(line: string): boolean {
    return /^[A-Za-z_]\w*\s*=\s*increment\(\s*(?:1|-1)\s*\)$/.test(line)
        || /^[A-Za-z_]\w*\s*=\s*(?:2|0)$/.test(line);
}

export function assessIsolatedProbeCode(code: string): IsolatedProbeCodeAssessment {
    const lines = code.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const testCaseBases = probeTestCaseBases(lines);
    const escapedBases = testCaseBases.map(base => base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const classPattern = escapedBases
        ? new RegExp('^class Test[A-Za-z_]\\w*\\((?:' + escapedBases + ')\\):$')
        : /^(?!)$/;
    const allowed = [
        /^import unittest(?:\s+as\s+[A-Za-z_]\w*)?$/,
        /^from unittest import TestCase(?:\s+as\s+[A-Za-z_]\w*)?$/,
        /^def increment\(value\):(?: return value \+ 1)?$/,
        /^return value \+ 1$/,
        classPattern,
        /^def test_[A-Za-z_]\w*\(self\)(?:\s*->\s*None)?:$/,
        /^if __name__ == ['"]__main__['"]:$/,
        /^unittest\.main\(\)$/,
        /^unittest\.main\(\s*verbosity\s*=\s*\d+\s*\)$/,
        /^#.*$/,
    ];
    const stringStatement = new RegExp('^' + PROBE_STRING_LITERAL + '$');
    const unsupportedLines = lines.filter(line =>
        !allowed.some(pattern => pattern.test(line))
        && !isSafeProbeAssertion(line)
        && !isSafeProbeAssignment(line)
        && !stringStatement.test(line)
    );
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

/**
 * Run the fixed qualification fixture using the same selected interpreter as
 * the rest of the extension.  `-I` still prevents user-site imports from
 * affecting this isolated, standard-library-only execution.
 */
export function runIsolatedProbe(
    code: string,
    timeoutMs = MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS,
    pythonExecutable = 'python'
): Promise<boolean> {
    return new Promise(resolve => {
        const process = spawn(pythonExecutable, ['-I', '-c', PROBE_RUNNER], {
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
        process.stdin.on('error', () => {
            clearTimeout(timer);
            resolve(false);
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
