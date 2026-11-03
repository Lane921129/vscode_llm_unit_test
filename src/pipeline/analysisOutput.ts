import * as fs from 'fs';
import * as path from 'path';
import { evidenceHash } from './analysisJournal';
import { checkOutputPath } from './artifactPaths';

const label = (value: string, limit: number): string => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, limit).replace(/[. ]+$/g, '') || 'result';

/** One bounded folder per source; full identity prevents short-name collisions. */
function sourceDirectory(parent: string, file: string, key: string): string {
    const sourceFile = path.resolve(file), sourceKeyHash = evidenceHash(key);
    const name = `${label(path.basename(file, '.py'), 16)}_${sourceKeyHash.slice(0, 8)}`;
    for (let sequence = 1; ; sequence++) {
        const directory = path.join(parent, sequence === 1 ? name : `${name}__${sequence}`);
        checkOutputPath(directory, 78); // separator + target folder + artifact allowance
        try { fs.mkdirSync(directory); }
        catch (error: any) {
            if (error.code !== 'EEXIST') { throw error; }
            try {
                const saved = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
                if (saved.schemaVersion === 'source-location-v1' && saved.sourceFile === sourceFile
                    && saved.sourceKey === key && saved.sourceKeyHash === sourceKeyHash) { return directory; }
            } catch (readError: any) {
                if (readError.code !== 'ENOENT' && readError.code !== 'ENOTDIR' && !(readError instanceof SyntaxError)) { throw readError; }
            }
            continue; // Preserve unrecognized or conflicting results.
        }
        fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify({ schemaVersion: 'source-location-v1',
            sourceFile, sourceKey: key, sourceKeyHash }, null, 2), { encoding: 'utf8', flag: 'wx' });
        return directory;
    }
}

/** Reserve a new run without overwriting failed, incomplete or same-minute evidence. */
export function createAnalysisDirectory(base: string, date: string, file: string, target: string,
    projectName?: string, projectRoot?: string, batchDirectory?: string): string {
    const stem = path.basename(file, '.py');
    const relative = projectRoot ? path.relative(projectRoot, file) : '';
    const key = relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
        ? relative.replace(/\.py$/i, '') : `${stem}-${evidenceHash(path.resolve(file)).slice(0, 10)}`;
    const run = batchDirectory || path.join(base, `${label(projectName || stem, 16)}_${label(date, 24)}`);
    const sourceKeyHash = evidenceHash(JSON.stringify([key, target]));
    const safeTarget = `${label(target, 20)}_${sourceKeyHash.slice(0, 8)}`;
    checkOutputPath(run, 104);
    fs.mkdirSync(run, { recursive: true });
    const parent = sourceDirectory(run, file, key);
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
        checkOutputPath(directory, 104);
        try { fs.mkdirSync(directory); return directory; }
        catch (error: any) { if (error.code !== 'EEXIST') { throw error; } }
    }
}
