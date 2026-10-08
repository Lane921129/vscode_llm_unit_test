import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { validateResourceLocation, validateTestResources } from '../pipeline/isolatedResources';

export interface ImportInitializationCandidate {
    schemaVersion: 'import-initialization-candidate-v1';
    kind: 'mkdir' | 'entry-point'; file: string; line: number; sourceHash: string; operation: string;
    evidence: 'blocked-direct-module-call'; returnValue: 'discarded';
    resourcePath?: string;
    resourceScope?: 'project-parent';
}

/** Recheck the Python observation against the selected root and current bytes. */
export function readInitializationCandidate(root: string, diagnostic: any): ImportInitializationCandidate | undefined {
    const value = diagnostic?.initialization_candidate;
    if (diagnostic?.exception_type !== 'TraceSafetyError' || !value || typeof value !== 'object'
        || value.schemaVersion !== 'import-initialization-candidate-v1'
        || !['mkdir', 'entry-point'].includes(value.kind)
        || value.evidence !== 'blocked-direct-module-call' || value.returnValue !== 'discarded'
        || typeof value.file !== 'string' || !value.file.endsWith('.py') || value.file.length > 1000
        || /[:\u0000-\u001f\u007f]/.test(value.file) || path.isAbsolute(value.file)
        || value.file.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..')
        || !Number.isSafeInteger(value.line) || value.line < 1
        || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHash)
        || typeof value.operation !== 'string' || value.operation.length > 240
        || value.operation.trim() !== value.operation || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value.operation)
        || value.kind === 'mkdir' && value.operation !== 'pathlib.Path.mkdir') { return undefined; }
    try {
        root = fs.realpathSync(root);
        const file = fs.realpathSync(path.join(root, value.file));
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)
            || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== value.sourceHash) { return undefined; }
        if (value.resourceScope !== undefined && (value.resourceScope !== 'project-parent' || value.resourcePath === undefined)) { return undefined; }
        if (value.resourcePath !== undefined) {
            if (value.kind !== 'mkdir') { return undefined; }
            const resource = validateTestResources([{ path: value.resourcePath, kind: 'directory',
                ...(value.resourceScope ? { scope: value.resourceScope } : {}) }])[0];
            validateResourceLocation(root, resource);
        }
        return { schemaVersion: value.schemaVersion, kind: value.kind, file: relative.replace(/\\/g, '/'),
            line: value.line, sourceHash: value.sourceHash, operation: value.operation,
            evidence: value.evidence, returnValue: value.returnValue,
            ...(value.resourcePath ? { resourcePath: value.resourcePath } : {}),
            ...(value.resourceScope ? { resourceScope: value.resourceScope } : {}) };
    } catch { return undefined; }
}
