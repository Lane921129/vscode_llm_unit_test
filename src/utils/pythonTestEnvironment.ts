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
