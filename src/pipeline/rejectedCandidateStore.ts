import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { containsCredential, normalizeKnownSecrets } from './artifactSafety';

export type CandidateRejectionGate = 'response-format' | 'unittest-structure' | 'python-syntax'
    | 'target-binding' | 'target-signature' | 'assertion-evidence' | 'execution' | 'revision-scope'
    | 'candidate-deduplication' | 'review';
export type CandidatePhase = 'seed' | 'expand' | 'generation' | 'revision';
export interface RejectedCandidateIdentity {
    sourceHash: string;
    target: string;
    runId?: string;
    /** Used only to detect copied implementation; never serialized. */
    sourceCode?: string;
}
export interface RejectedCandidateLimits {
    maxCandidates?: number;
    maxCandidateBytes?: number;
    maxTotalBytes?: number;
}
export interface RejectedCandidateInput {
    /** Already extracted Python, not the provider envelope or explanatory response. */
    code: string;
    phase: CandidatePhase;
    tier: number;
    attempt: number;
    gate: CandidateRejectionGate;
    /** A stable machine code, not a free-text error message. */
    reasonCode: string;
}
export type CandidateWithheldReason = 'empty-candidate' | 'not-extracted-python' | 'credential-detected'
    | 'source-copy' | 'candidate-size-limit' | 'record-limit' | 'storage-limit';
export interface RejectedCandidateArtifact {
    schemaVersion: 'rejected-candidate-v1';
    sourceHash: string;
    target: string;
    runId?: string;
    phase: CandidatePhase;
    tier: number;
    attempt: number;
    gate: CandidateRejectionGate;
    reasonCode: string;
    codeHash: string;
    bytes: number;
    status: 'saved' | 'withheld';
    /** Rejected artifacts must never be promoted to an executable checkpoint. */
    executable: false;
    artifactPath?: string;
    metadataPath?: string;
    withheldReason?: CandidateWithheldReason;
}

const gates = new Set<CandidateRejectionGate>(['response-format', 'unittest-structure', 'python-syntax',
    'target-binding', 'target-signature', 'assertion-evidence', 'execution', 'revision-scope',
    'candidate-deduplication', 'review']);
const phases = new Set<CandidatePhase>(['seed', 'expand', 'generation', 'revision']);
const defaults = { maxCandidates: 32, maxCandidateBytes: 128 * 1024, maxTotalBytes: 2 * 1024 * 1024 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizeLines = (value: string) => value.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#')).join('\n');

function extractedPython(code: string): boolean {
    if (/```|<\/?(?:think|thinking)>|\[\/?(?:python|pytest)\]/i.test(code)) { return false; }
    // A malformed Python candidate remains useful evidence. An arbitrary raw reply does not.
    const first = code.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#')) || '';
    return /^(?:(?:from|import)\s+|(?:async\s+)?def\s+|class\s+|@\w|assert\s+|with\s+)/.test(first);
}

function isSourceCopy(code: string, identity: RejectedCandidateIdentity): boolean {
    const escapedLeaf = identity.target.split('.').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^(?:async\\s+)?def\\s+${escapedLeaf}\\s*\\(`, 'm').test(code)) { return true; }
    if (identity.target.includes('.')) {
        const owner = identity.target.split('.')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`^class\\s+${owner}\\s*[:(]`, 'm').test(code)) { return true; }
    }
    const source = identity.sourceCode ? normalizeLines(identity.sourceCode) : '';
    return Boolean(source && normalizeLines(code).includes(source));
}

function regularFile(file: string): fs.Stats {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('Rejected candidate artifact is not a regular file'); }
    return stat;
}

/** Publish a complete file atomically without replacing an existing artifact. */
function writeImmutable(file: string, content: string): void {
    const temporary = `${file}.${randomUUID()}.pending`;
    try {
        fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        try { fs.linkSync(temporary, file); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            regularFile(file);
            if (fs.readFileSync(file, 'utf8') !== content) { throw new Error('Rejected candidate artifact conflict'); }
        }
    } finally {
        if (fs.existsSync(temporary)) { fs.unlinkSync(temporary); }
    }
}

/** Host-owned forensic artifacts. No provider reply, credential, or executable acceptance is stored. */
export class RejectedCandidateStore {
    private readonly directory: string;
    private readonly identity: RejectedCandidateIdentity;
    private readonly secrets: readonly string[];
    private readonly limits: Required<RejectedCandidateLimits>;

    constructor(directory: string, identity: RejectedCandidateIdentity, knownSecrets: string[] = [], limits: RejectedCandidateLimits = {}) {
        if (!/^[a-f0-9]{64}$/i.test(identity.sourceHash) || !identity.target.trim()) {
            throw new TypeError('Rejected candidate identity is invalid');
        }
        this.identity = { ...identity };
        this.secrets = normalizeKnownSecrets(knownSecrets);
        this.limits = { ...defaults, ...limits };
        for (const limit of Object.values(this.limits)) {
            if (!Number.isSafeInteger(limit) || limit < 0) { throw new TypeError('Rejected candidate limit is invalid'); }
        }
        this.directory = path.resolve(directory, 'rejected_candidates');
        fs.mkdirSync(this.directory, { recursive: true });
        const stat = fs.lstatSync(this.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Rejected candidate directory is invalid'); }
    }

    record(input: RejectedCandidateInput): RejectedCandidateArtifact {
        if (!phases.has(input.phase) || !gates.has(input.gate)
            || !/^[a-z][a-z0-9-]{0,79}$/.test(input.reasonCode)
            || !Number.isSafeInteger(input.tier) || input.tier < 0
            || !Number.isSafeInteger(input.attempt) || input.attempt < 0) {
            throw new TypeError('Rejected candidate diagnostic is invalid');
        }
        const artifact: RejectedCandidateArtifact = {
            schemaVersion: 'rejected-candidate-v1', sourceHash: this.identity.sourceHash,
            target: this.identity.target, ...(this.identity.runId ? { runId: this.identity.runId } : {}),
            phase: input.phase, tier: input.tier, attempt: input.attempt, gate: input.gate,
            reasonCode: input.reasonCode, codeHash: hash(input.code), bytes: Buffer.byteLength(input.code, 'utf8'),
            status: 'withheld', executable: false
        };
        const files = fs.readdirSync(this.directory).filter(name => /^(?:candidate_[a-f0-9]{64}\.py|rejection_\d+\.json)$/.test(name));
        let usedBytes = 0;
        let records = 0;
        let lastSequence = 0;
        for (const name of files) {
            const file = path.join(this.directory, name);
            usedBytes += regularFile(file).size;
            const match = name.match(/^rejection_(\d+)\.json$/);
            if (match) {
                records++;
                lastSequence = Math.max(lastSequence, Number(match[1]));
                const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as RejectedCandidateArtifact;
                if (previous.sourceHash !== this.identity.sourceHash || previous.target !== this.identity.target
                    || previous.runId !== this.identity.runId) { throw new Error('Rejected candidate identity conflict'); }
            }
        }
        if (records >= this.limits.maxCandidates) { return { ...artifact, withheldReason: 'record-limit' }; }
        const withheld: CandidateWithheldReason | undefined = !input.code.trim() ? 'empty-candidate'
            : artifact.bytes > this.limits.maxCandidateBytes ? 'candidate-size-limit'
                : containsCredential(input.code, this.secrets) ? 'credential-detected'
                    : !extractedPython(input.code) ? 'not-extracted-python'
                        : isSourceCopy(input.code, this.identity) ? 'source-copy' : undefined;
        if (withheld) { artifact.withheldReason = withheld; }
        else {
            artifact.status = 'saved';
            artifact.artifactPath = `rejected_candidates/candidate_${artifact.codeHash}.py`;
        }
        artifact.metadataPath = `rejected_candidates/rejection_${String(lastSequence + 1).padStart(4, '0')}.json`;
        const candidateFile = path.join(this.directory, `candidate_${artifact.codeHash}.py`);
        const candidateExists = fs.existsSync(candidateFile);
        if (candidateExists) {
            regularFile(candidateFile);
            if (fs.readFileSync(candidateFile, 'utf8') !== input.code) { throw new Error('Rejected candidate artifact conflict'); }
        }
        let metadata = JSON.stringify(artifact, null, 2) + '\n';
        if (usedBytes + Buffer.byteLength(metadata) + (artifact.status === 'saved' && !candidateExists ? artifact.bytes : 0) > this.limits.maxTotalBytes) {
            artifact.status = 'withheld';
            delete artifact.artifactPath;
            artifact.withheldReason = 'storage-limit';
            metadata = JSON.stringify(artifact, null, 2) + '\n';
            if (usedBytes + Buffer.byteLength(metadata) > this.limits.maxTotalBytes) {
                delete artifact.metadataPath;
                return artifact;
            }
        }
        if (artifact.status === 'saved') { writeImmutable(candidateFile, input.code); }
        writeImmutable(path.join(this.directory, path.basename(artifact.metadataPath!)), metadata);
        return artifact;
    }
}
