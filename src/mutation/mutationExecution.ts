export type ExternalMutationEngine = 'mutatest' | 'mutmut';

export interface ExternalMutationExecution {
    command: string;
    args: string[];
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
    pythonExecutable: string = 'python'
): ExternalMutationExecution {
    // mutmut owns this runner string. JSON quoting keeps a selected interpreter
    // path with spaces as one executable token when mutmut launches it.
    const testRunner = `${JSON.stringify(pythonExecutable)} -m unittest ${testModule}`;
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
