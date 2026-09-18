import * as fs from 'fs';
import * as path from 'path';
import { evidenceHash } from './analysisJournal';

/** Reserve a new run without overwriting failed, incomplete or same-minute evidence. */
export function createAnalysisDirectory(base: string, date: string, file: string, target: string,
    projectName?: string, projectRoot?: string, batchDirectory?: string): string {
    const stem = path.basename(file, '.py');
    const relative = projectRoot ? path.relative(projectRoot, file) : '';
    const key = relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
        ? relative.replace(/\.py$/i, '') : `${stem}-${evidenceHash(path.resolve(file)).slice(0, 10)}`;
    const parent = batchDirectory ? path.join(batchDirectory, key) : projectName
        ? path.join(base, `${projectName}_${date}`, key)
        : path.join(base, `${stem}_${date}`);
    fs.mkdirSync(parent, { recursive: true });
    const safeTarget = target.replace(/[<>:"/\\|?*]/g, '_');
    for (let attempt = 1; ; attempt++) {
        const directory = path.join(parent, attempt === 1 ? safeTarget : `${safeTarget}__run${attempt}`);
        try { fs.mkdirSync(directory); return directory; }
        catch (error: any) { if (error.code !== 'EEXIST') { throw error; } }
    }
}

/** A batch owns one new root, including its inventory and completion record. */
export function createBatchDirectory(base: string, date: string, projectName: string): string {
    fs.mkdirSync(base, { recursive: true });
    for (let attempt = 1; ; attempt++) {
        const directory = path.join(base, `${projectName}_${date}${attempt === 1 ? '' : `__run${attempt}`}`);
        try { fs.mkdirSync(directory); return directory; }
        catch (error: any) { if (error.code !== 'EEXIST') { throw error; } }
    }
}
