import * as fs from 'node:fs';
import * as path from 'node:path';
import { evidenceHash } from './analysisJournal';
import { checkOutputPath } from './artifactPaths';

const VERSION = 'function-loops-v1';

/** Create only inside a newly reserved target directory; historical runs are untouched. */
export function createResultLayout(root: string): string {
    const data = path.join(root, 'loop', '_run');
    checkOutputPath(data, 48);
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'layout.json'), JSON.stringify({ schemaVersion: VERSION }), { flag: 'wx' });
    fs.renameSync(path.join(root, 'target.json'), path.join(data, 'target.json'));
    return data;
}

export function resultDataDirectory(root: string): string {
    const data = path.join(root, 'loop', '_run');
    if (!fs.existsSync(data)) {
        if (fs.existsSync(path.join(root, 'loop'))) { throw Error('missing-result-layout'); }
        return root;
    }
    if (JSON.parse(fs.readFileSync(path.join(data, 'layout.json'), 'utf8')).schemaVersion !== VERSION
        || fs.realpathSync(data) !== path.resolve(data)) { throw Error('invalid-result-layout'); }
    return data;
}

export function functionReportDirectory(data: string): string {
    if (path.basename(data) !== '_run' || path.basename(path.dirname(data)) !== 'loop') { return data; }
    const root = path.dirname(path.dirname(data));
    return resultDataDirectory(root) === data ? root : data;
}

export function roundDirectory(data: string, loop: number): string {
    if (!Number.isSafeInteger(loop) || loop < 1) { throw Error('invalid-result-round'); }
    const root = functionReportDirectory(data);
    return root === data ? data : path.join(root, 'loop', String(loop));
}

/** Basename-only evidence references; never search other runs for missing artifacts. */
export function resultArtifactPath(directory: string, name: string): string {
    if (typeof name !== 'string' || !name || name === '.' || name === '..'
        || path.basename(name) !== name || /[\\/:]/.test(name)) { throw Error('invalid-artifact-path'); }
    const data = resultDataDirectory(directory);
    let file = path.join(data, name);
    if (!fs.existsSync(file) && functionReportDirectory(data) !== data) {
        const loop = /^loop([1-9]\d*)_/.exec(name)?.[1];
        // Execution-only runs use the first round, with unique filenames per attempt.
        if (loop || /^(?:exec\d+_test\.py|(?:invocation|isolation|arithmetic)_\d+\.jsonl?)$/.test(name)) {
            file = path.join(roundDirectory(data, loop ? Number(loop) : 1), name);
        }
    }
    if (fs.existsSync(file) && (fs.realpathSync(file) !== path.resolve(file) || !fs.lstatSync(file).isFile())) {
        throw Error('invalid-artifact-path');
    }
    return file;
}

/** Preserve each executed candidate before a revision or rollback overwrites it. */
export function preserveCandidate(file: string): void {
    if (!fs.existsSync(file)) { return; }
    const code = fs.readFileSync(file, 'utf8');
    const snapshot = path.join(path.dirname(file), `candidate_${evidenceHash(code).slice(0, 16)}.py`);
    if (fs.existsSync(snapshot)) {
        if (fs.readFileSync(snapshot, 'utf8') !== code) { throw Error('candidate-snapshot-collision'); }
        return;
    }
    fs.writeFileSync(snapshot, code, { encoding: 'utf8', flag: 'wx' });
}
