import * as fs from 'fs';
import * as path from 'path';

/** Resolve a user-selected interpreter without introducing shell arguments. */
export function normalizePythonExecutable(value?: string): string {
    const candidate = typeof value === 'string' ? value.trim() : '';
    return candidate || 'python';
}

/**
 * Choose one interpreter for every Python-backed step of a workspace run.
 *
 * A user or laboratory setting always wins.  Otherwise, a conventional
 * workspace `.venv` is preferred so extension commands do not silently mix
 * its dependencies with a system or user-site Python installation.
 */
export function resolvePythonExecutable(
    configuredValue?: string,
    workspaceRoot?: string,
    platform: NodeJS.Platform = process.platform,
    pathExists: (candidate: string) => boolean = fs.existsSync
): string {
    const configured = typeof configuredValue === 'string' ? configuredValue.trim() : '';
    if (configured) {
        return configured;
    }

    if (workspaceRoot) {
        const virtualEnvironmentPython = platform === 'win32'
            ? path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
            : path.join(workspaceRoot, '.venv', 'bin', 'python');
        if (pathExists(virtualEnvironmentPython)) {
            return virtualEnvironmentPython;
        }
    }

    return 'python';
}

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
    useCoverage: boolean,
    verbose: boolean = false
): string[] {
    const args = useCoverage
        ? ['-m', 'coverage', 'run', '--branch', `--source=${targetDirectory}`, '-m', 'unittest', testModule]
        : ['-m', 'unittest', testModule];
    return verbose ? [...args, '-v'] : args;
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
