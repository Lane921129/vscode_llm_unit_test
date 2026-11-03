import * as fs from 'node:fs';
import * as path from 'node:path';
import { evidenceHash } from './analysisJournal';

/** Sources actually loaded by the guarded project import, including constants,
 * package initializers and transitive imports. This is separate from prompt context. */
export const SOURCE_VERSIONS_VERSION = 'loaded-project-sources-v1';
export interface SourceVersion { file: string; hash: string }

export function validSourceVersions(value: unknown): value is SourceVersion[] {
    // A successful project import always includes at least the selected module.
    if (!Array.isArray(value) || value.length === 0) { return false; }
    const seen = new Set<string>();
    return value.every(item => {
        if (!item || typeof item.file !== 'string' || !path.isAbsolute(item.file)
            || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) { return false; }
        const key = process.platform === 'win32' ? path.resolve(item.file).toLowerCase() : path.resolve(item.file);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

export function sourceVersionsCurrent(value: unknown): boolean {
    if (!validSourceVersions(value)) { return false; }
    try {
        return value.every(item => evidenceHash(fs.readFileSync(item.file, 'utf8')) === item.hash);
    } catch { return false; }
}
