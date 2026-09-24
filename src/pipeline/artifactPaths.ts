import * as fs from 'node:fs';
import * as path from 'node:path';

/** Keep room below legacy Windows shell limits; IDs belong inside evidence. */
export function checkOutputPath(file: string, extra = 0): void {
    if (path.resolve(file).length + extra > 240) {
        throw new Error('結果完整路徑過長；請將輸出目錄改為較短的位置，例如 C:\\r，再重新執行。');
    }
}

/** Atomically reserve short names; never replace evidence from another attempt. */
export function reserveArtifactFiles(directory: string, prefixes: string[], extension: 'json' | 'jsonl'): string[] {
    if (!prefixes.length || new Set(prefixes).size !== prefixes.length || prefixes.some(prefix => !/^[a-z]+$/.test(prefix))) {
        throw new Error('Invalid artifact prefixes.');
    }
    for (let sequence = 1; ; sequence++) {
        const files = prefixes.map(prefix => path.join(directory, `${prefix}_${String(sequence).padStart(3, '0')}.${extension}`));
        files.forEach(file => checkOutputPath(file));
        const owned: string[] = [];
        try {
            for (const file of files) { fs.writeFileSync(file, '', { flag: 'wx' }); owned.push(file); }
            return files;
        } catch (error: any) {
            for (const file of owned) { fs.unlinkSync(file); }
            if (error.code !== 'EEXIST') { throw error; }
        }
    }
}
