import * as fs from 'fs';
import * as path from 'path';
import { evidenceHash } from './analysisJournal';
import { checkOutputPath } from './artifactPaths';

const label = (value: string, limit: number): string => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, limit).replace(/[. ]+$/g, '') || 'result';

/** Reserve a new run without overwriting failed, incomplete or same-minute evidence. */
export function createAnalysisDirectory(base: string, date: string, file: string, target: string,
    projectName?: string, projectRoot?: string, batchDirectory?: string): string {
    const stem = path.basename(file, '.py');
    const relative = projectRoot ? path.relative(projectRoot, file) : '';
    const key = relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
        ? relative.replace(/\.py$/i, '') : `${stem}-${evidenceHash(path.resolve(file)).slice(0, 10)}`;
    const parent = batchDirectory || path.join(base, `${label(projectName || stem, 16)}_${label(date, 24)}`);
    const sourceKeyHash = evidenceHash(JSON.stringify([key, target]));
    const safeTarget = `t_${label(stem, 10)}_${label(target, 12)}_${sourceKeyHash.slice(0, 10)}`;
    checkOutputPath(path.join(parent, safeTarget), 48);
    fs.mkdirSync(parent, { recursive: true });
    for (let attempt = 1; ; attempt++) {
        const directory = path.join(parent, attempt === 1 ? safeTarget : `${safeTarget}__run${attempt}`);
        checkOutputPath(directory, 48);
        try { fs.mkdirSync(directory); }
        catch (error: any) { if (error.code === 'EEXIST') { continue; } throw error; }
        fs.writeFileSync(path.join(directory, 'target.json'), JSON.stringify({ schemaVersion: 'target-location-v1',
            sourceFile: path.resolve(file), sourceKey: key, sourceKeyHash, target }, null, 2), { encoding: 'utf8', flag: 'wx' });
        return directory;
    }
}

/** A batch owns one new root, including its inventory and completion record. */
export function createBatchDirectory(base: string, date: string, projectName: string): string {
    fs.mkdirSync(base, { recursive: true });
    for (let attempt = 1; ; attempt++) {
        const directory = path.join(base, `${label(projectName, 16)}_${label(date, 24)}${attempt === 1 ? '' : `__run${attempt}`}`);
        checkOutputPath(directory, 88);
        try { fs.mkdirSync(directory); return directory; }
        catch (error: any) { if (error.code !== 'EEXIST') { throw error; } }
    }
}
