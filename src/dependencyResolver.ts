import * as path from 'path';

export interface PythonDependency {
    module: string;
    name: string;
    level?: number;
}

/**
 * Resolve a direct Python import target. Absolute imports are project-root
 * relative; relative imports are anchored at the file that owns the import.
 */
export function resolvePythonDependencyPath(
    targetFilePath: string,
    projectRoot: string,
    dependency: PythonDependency
): string {
    const moduleParts = dependency.module.split('.').filter(Boolean);
    if (dependency.level && dependency.level > 0) {
        let baseDirectory = path.dirname(targetFilePath);
        for (let currentLevel = 1; currentLevel < dependency.level; currentLevel++) {
            baseDirectory = path.dirname(baseDirectory);
        }
        if (moduleParts.length === 0) {
            return path.join(baseDirectory, dependency.name) + '.py';
        }
        return path.join(baseDirectory, ...moduleParts) + '.py';
    }
    return path.join(projectRoot, ...moduleParts) + '.py';
}

export function formatPythonImport(dependency: PythonDependency): string {
    return '.'.repeat(dependency.level || 0) + dependency.module;
}
