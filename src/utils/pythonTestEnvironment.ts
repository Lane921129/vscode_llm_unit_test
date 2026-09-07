import * as path from 'path';

/**
 * Create the isolated environment used to execute generated Python tests.
 *
 * The paths are supplied to `spawn` through its environment instead of a
 * platform-specific shell command.  This keeps generated-test validation
 * independent from drive letters, command shells, and current directories.
 */
export function buildGeneratedTestEnvironment(
    baseEnvironment: NodeJS.ProcessEnv,
    importPaths: string[]
): NodeJS.ProcessEnv {
    const inheritedPaths = (baseEnvironment.PYTHONPATH || '')
        .split(path.delimiter)
        .filter(Boolean);
    const pythonPath = [...new Set([...importPaths.filter(Boolean), ...inheritedPaths])]
        .join(path.delimiter);

    return {
        ...baseEnvironment,
        PYTHONIOENCODING: 'utf-8',
        PYTHONPATH: pythonPath
    };
}

export function generatedUnittestArguments(
    testModule: string,
    targetDirectory: string,
    useCoverage: boolean
): string[] {
    return useCoverage
        ? ['-m', 'coverage', 'run', '--branch', `--source=${targetDirectory}`, '-m', 'unittest', testModule]
        : ['-m', 'unittest', testModule];
}

/**
 * Coverage is a quality gate, not a cosmetic report field.  Keep this message
 * path-agnostic so users can fix the same Python interpreter that runs the
 * extension instead of installing into a different account or environment.
 */
export function coverageRequiredMessage(pythonExecutable: string = 'python'): string {
    return `Python coverage is required for quality validation but is unavailable in the interpreter used by this run. `
        + `Install the project dependencies with: ${pythonExecutable} -m pip install -r requirements.txt, `
        + 'then restart the VS Code Extension Development Host and run the analysis again.';
}
