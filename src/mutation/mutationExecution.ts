import { pythonToolPath } from '../pipeline/pythonTools';

export type ExternalMutationEngine = 'mutatest' | 'mutmut';

export interface ExternalMutationExecution {
    command: string;
    args: string[];
}

/** Require positive runner evidence, never infer isolation from a missing log. */
export function externalIsolationVerified(text: string): boolean {
    const starts = new Set<string>(), finishes = new Set<string>();
    let passed = false;
    try {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
            const event = JSON.parse(line);
            if (!/^[0-9a-f]{32}$/.test(event.runId)) { return false; }
            if (event.event === 'started' && !starts.has(event.runId)) { starts.add(event.runId); }
            else if (event.event === 'completed' && starts.has(event.runId) && !finishes.has(event.runId)
                && ['passed', 'failed'].includes(event.status)) {
                finishes.add(event.runId); passed ||= event.status === 'passed';
            } else { return false; }
        }
    } catch { return false; }
    return passed && starts.size === finishes.size;
}

const mutatestCompatibilityPatch = [
    'import random',
    'orig_sample=random.sample',
    'random.sample=lambda p,k: orig_sample(list(p) if isinstance(p,set) else p,k)',
    'import sys',
    'from mutatest.cli import cli_main',
    'sys.argv[0]=__name__',
    'sys.exit(cli_main())'
].join('; ');

/**
 * Build a shell-free command for native mutation engines.
 *
 * The test runner remains a single argument because both mutation tools pass
 * it to their own runner process.  All file paths are otherwise distinct
 * arguments and are never interpolated into a command shell.
 */
export function buildExternalMutationExecution(
    engine: ExternalMutationEngine,
    targetPath: string,
    testModule: string,
    reportDirectory: string,
    timeoutFactor?: number,
    pythonExecutable: string = 'python',
    violationReport?: string
): ExternalMutationExecution {
    const quote = (value: string): string => {
        if (/[\r\n\0]/.test(value)) { throw new Error('Invalid mutation runner argument'); }
        if (process.platform === 'win32') {
            // Native engines own the final shell. Reject command expansion
            // characters rather than interpolating a path they may execute.
            if (/["%!^&|<>`]/.test(value)) { throw new Error('Unsupported mutation runner path characters'); }
            return `"${value}"`;
        }
        return `'${value.replace(/'/g, `'"'"'`)}'`;
    };
    if (!/^[A-Za-z_]\w*$/.test(testModule)) { throw new Error('Invalid mutation test module'); }
    const runnerArgs = [pythonExecutable, '-B', pythonToolPath('testRunner'), testModule,
        ...(violationReport ? ['--violation-report', violationReport] : [])];
    const testRunner = runnerArgs.map(quote).join(' ');
    if (engine === 'mutmut') {
        const args = ['-m', 'mutmut', 'run', '--paths-to-mutate', targetPath, '--runner', testRunner];
        if (timeoutFactor) {
            args.push('--test-time-multiplier', String(timeoutFactor));
        }
        return { command: pythonExecutable, args };
    }

    const args = [
        '-c', mutatestCompatibilityPatch,
        '-s', targetPath,
        '-t', testRunner,
        '-o', `${reportDirectory}.rst`
    ];
    if (timeoutFactor) {
        args.push('--timeout_factor', String(timeoutFactor));
    }
    return { command: pythonExecutable, args };
}
