import * as fs from 'node:fs';
import * as path from 'node:path';

/** Existing physical paths only. Native resolution expands Windows 8.3 aliases,
 * matching Python realpath; it is not a resolver for planned resource addresses. */
export function existingRealPath(file: string): string {
    return fs.realpathSync.native(file);
}

export function canonicalExistingPath(file: string): string {
    const resolved = existingRealPath(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Historical records may outlive their source files. Keep identical lexical
 * identities valid, but accept different spellings only with physical proof.
 * Never probe a remote/device address to infer a new alias. */
export function sameRecordedFile(left: string, right: string): boolean {
    const lexical = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    try {
        if (lexical(left) === lexical(right)) { return true; }
        if (process.platform === 'win32' && [left, right].some(file => /^[\\/]{2}/.test(file))) { return false; }
        return canonicalExistingPath(left) === canonicalExistingPath(right);
    } catch { return false; }
}
