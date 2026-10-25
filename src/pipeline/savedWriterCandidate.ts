import * as fs from 'node:fs';
import * as path from 'node:path';
import { evidenceHash } from './analysisJournal';
import { resultArtifactPath } from './resultLayout';
import { containsCredential, WITHHELD_SENSITIVE_CONTENT } from './artifactSafety';
import { sameRecordedFile } from '../utils/fileIdentity';
import { AnalysisStageError } from '../utils/executionFailureCategory';

/** Explicitly resume an unapproved AI artifact, never an old success status. */
export interface SavedWriterCandidateRequest {
    directory: string; sequence: number; codeHash: string; repair?: boolean; allowIdenticalSource?: boolean;
}

export function readSavedWriterCandidate(request: SavedWriterCandidateRequest, expected: {
    sourceFile: string; sourceHash: string; target: string; model: string; modelIdentity: string;
}): { code: string; origin: { version: 'saved-writer-candidate-v1'; runId: string; sequence: number; codeHash: string;
    sourceRelationship: 'same-native-file' | 'identical-source-draft' } } {
    const fail = (): never => { throw new AnalysisStageError('validation', 'candidate-replay',
        'Saved AI candidate identity or evidence is invalid; no candidate was executed.'); };
    try {
        if (!request || typeof request.directory !== 'string' || !path.isAbsolute(request.directory)
            || /^[\\/]{2}/.test(request.directory) || !Number.isSafeInteger(request.sequence) || request.sequence < 1
            || !/^[a-f0-9]{64}$/.test(request.codeHash)
            || request.repair !== undefined && typeof request.repair !== 'boolean'
            || request.allowIdenticalSource !== undefined && typeof request.allowIdenticalSource !== 'boolean') { return fail(); }
        for (let current = path.resolve(request.directory);;) {
            if (fs.lstatSync(current).isSymbolicLink()) { return fail(); }
            const parent = path.dirname(current);
            if (parent === current) { break; }
            current = parent;
        }
        const read = (name: string, maximum: number) => {
            const file = resultArtifactPath(request.directory, name);
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) { return fail(); }
            return fs.readFileSync(file, 'utf8');
        };
        const manifest = JSON.parse(read('run_manifest.json', 1024 * 1024));
        const location = JSON.parse(read('target.json', 1024 * 1024));
        if (manifest.validationMode !== 'execution' || manifest.sourceHash !== expected.sourceHash
            || manifest.target !== expected.target || manifest.model !== expected.model
            || manifest.report?.modelIdentity !== expected.modelIdentity
            || typeof manifest.runId !== 'string' || !manifest.runId
            || location.target !== expected.target || typeof location.sourceFile !== 'string'
            || !path.isAbsolute(location.sourceFile) || /^[\\/]{2}/.test(location.sourceFile)) { return fail(); }
        const sameFile = sameRecordedFile(location.sourceFile, expected.sourceFile);
        if (!sameFile && (request.allowIdenticalSource !== true
            || evidenceHash(fs.readFileSync(location.sourceFile, 'utf8')) !== expected.sourceHash
            || evidenceHash(fs.readFileSync(expected.sourceFile, 'utf8')) !== expected.sourceHash)) { return fail(); }
        const events = read('role_events.jsonl', 8 * 1024 * 1024).trim().split(/\r?\n/).map(line => JSON.parse(line));
        let previous = 0;
        let lastRequest: any;
        for (const event of events) {
            if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous
                || event.runId !== manifest.runId || event.sourceHash !== expected.sourceHash) { return fail(); }
            previous = event.sequence;
            if (event.stage === 'model-request' && ['requested', 'completed', 'error'].includes(event.status)) {
                lastRequest = event;
            }
            if (event.sequence !== request.sequence) { continue; }
            const code = event.detail?.code;
            if (!['writer', 'bug-fixer'].includes(event.stage) || event.status !== 'candidate' || typeof code !== 'string'
                || !code.trim() || Buffer.byteLength(code, 'utf8') > 256 * 1024
                || evidenceHash(code) !== request.codeHash || containsCredential(code)
                || code.includes(WITHHELD_SENSITIVE_CONTENT)
                || lastRequest?.status !== 'completed' || lastRequest.loop !== event.loop
                || !['writer', 'writer-revision', 'bug-fixer'].includes(lastRequest.detail?.role)) { return fail(); }
            return { code, origin: { version: 'saved-writer-candidate-v1', runId: manifest.runId,
                sequence: event.sequence, codeHash: request.codeHash,
                sourceRelationship: sameFile ? 'same-native-file' : 'identical-source-draft' } };
        }
        return fail();
    } catch (error) {
        if (error instanceof AnalysisStageError) { throw error; }
        return fail();
    }
}
