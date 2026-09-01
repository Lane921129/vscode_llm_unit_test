import * as path from 'path';

export interface PythonDependency {
    module: string;
    name: string;
    level?: number;
}

export interface PythonImportContext {
    module?: string;
    level?: number;
}

/**
 * Infer the import path that loads the same module namespace as its internal
 * imports. This matters for namespace packages: importing only ``service``
 * can create a second module beside the real ``src.service`` module, making
 * mock.patch target the wrong object.
 */
export function inferTargetImportModule(
    filePath: string,
    fileImports: PythonImportContext[] = []
): string {
    const stem = path.basename(filePath, '.py');
    const parentName = path.basename(path.dirname(filePath));
    for (const imported of fileImports) {
        const parts = (imported.module || '').split('.').filter(Boolean);
        const parentIndex = parts.lastIndexOf(parentName);
        if (parentIndex >= 0) {
            return [...parts.slice(0, parentIndex + 1), stem].join('.');
        }
        if (imported.level === 1 && parentName) {
            return `${parentName}.${stem}`;
        }
    }
    return stem;
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
