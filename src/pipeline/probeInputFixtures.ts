import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { containsCredential } from './artifactSafety';
import { TraceValue, TraceValueSnapshot } from './evidenceContracts';
import { typedCallFields, TypedProbeInputsV1 } from './probeInputs';
import { validTraceInputSnapshot, validTraceValueSnapshot } from './traceValues';

export const PROBE_INPUT_FIXTURES_VERSION = 'probe-input-fixtures-v1';
export const MAX_PROBE_FIXTURE_BYTES = 64 * 1024;
export const MAX_PROBE_FIXTURE_CASES = 32;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const callFields = ['args', 'kwargs', 'constructor_args', 'constructor_kwargs'] as const;
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
    Object.keys(value).length === allowed.length && allowed.every(key => Object.prototype.hasOwnProperty.call(value, key));

export type ProbeFixtureDiagnosticCode = 'fixture-path-rejected' | 'source-path-rejected' | 'fixture-unreadable'
    | 'fixture-too-large' | 'fixture-invalid-json' | 'fixture-invalid-schema' | 'fixture-sensitive-content'
    | 'fixture-target-ambiguous' | 'fixture-source-mismatch' | 'fixture-case-limit' | 'fixture-invalid-input'
    | 'fixture-unsupported-input' | 'fixture-drifted';
export interface ProbeFixtureDiagnostic { code: ProbeFixtureDiagnosticCode; caseIndex?: number }
export interface ProbeFixtureIdentity {
    schemaVersion: typeof PROBE_INPUT_FIXTURES_VERSION;
    fixtureFile: string; fixtureHash: string; file: string; target: string; sourceHash: string; caseCount: number;
    inputOnly: true; userFixture: true;
}
export interface TargetProbeFixtures {
    status: 'not-configured' | 'not-targeted' | 'loaded' | 'rejected';
    inputs?: TypedProbeInputsV1;
    diagnostics: ProbeFixtureDiagnostic[];
    identity?: ProbeFixtureIdentity;
}
export interface TargetProbeFixtureRequest {
    root: string; file: string; target: string; sourceHash: string; fixtureFile?: string;
    knownSecrets?: readonly string[];
}

class FixtureFailure extends Error {
    constructor(readonly code: ProbeFixtureDiagnosticCode) { super(code); }
}
const normalized = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const relativeName = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');
const inside = (root: string, file: string): boolean => {
    const relative = path.relative(root, file);
    return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const localPath = (value: string): boolean => typeof value === 'string' && !!value && !value.includes('\0')
    && !/^[\\/]{2}/.test(value) && !/^[a-z]:[^\\/]/i.test(value)
    && !value.replace(/^[a-z]:/i, '').includes(':');

/** Inspect the original spelling before resolving it: realpath alone hides junctions. */
function noLinks(file: string): void {
    const parsed = path.parse(file);
    let current = parsed.root;
    for (const part of file.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) { throw new FixtureFailure('fixture-path-rejected'); }
    }
}

function boundFile(root: string, input: string, extension: RegExp, code: ProbeFixtureDiagnosticCode): string {
    if (!localPath(input)) { throw new FixtureFailure(code); }
    const candidate = path.resolve(root, input);
    if (!inside(root, candidate) || !extension.test(candidate)) { throw new FixtureFailure(code); }
    try {
        noLinks(candidate);
        const actual = fs.realpathSync.native(candidate);
        if (!inside(root, actual) || !fs.lstatSync(actual).isFile()) { throw new FixtureFailure(code); }
        return actual;
    } catch { throw new FixtureFailure(code); }
}

function stableBytes(file: string, maximum: number, tooLarge: ProbeFixtureDiagnosticCode): Buffer {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile()) { throw new FixtureFailure('fixture-path-rejected'); }
        if (before.size > maximum) { throw new FixtureFailure(tooLarge); }
        const buffer = Buffer.alloc(maximum + 1);
        let size = 0;
        while (size < buffer.length) {
            const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
            if (!count) { break; }
            size += count;
        }
        if (size > maximum) { throw new FixtureFailure(tooLarge); }
        const after = fs.fstatSync(fd);
        noLinks(file);
        const current = fs.lstatSync(file);
        if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino
            || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.size !== after.size || current.mtimeMs !== after.mtimeMs || size !== before.size) {
            throw new FixtureFailure('fixture-drifted');
        }
        return buffer.subarray(0, size);
    } finally { fs.closeSync(fd); }
}

function utf8(bytes: Buffer): string {
    // Keep any BOM in the source hash; reject lossy replacement decoding.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Python hashable equality, used only to reject collapsing keys/elements; input tags remain unchanged. */
function keyIdentity(node: TraceValue): string {
    switch (node.type) {
        case 'none': return 'none';
        case 'bool': return `number:${node.value ? '1' : '0'}`;
        case 'int': return `number:${BigInt(node.value as string)}`;
        case 'float': {
            const number = Number(node.value);
            return Number.isInteger(number) ? `number:${BigInt(number)}` : `fraction:${number}`;
        }
        case 'str': case 'bytes': return `${node.type}:${JSON.stringify(node.value)}`;
        case 'tuple': return `tuple:${JSON.stringify((node.items as TraceValue[]).map(keyIdentity))}`;
        case 'frozenset': return `frozenset:${JSON.stringify((node.items as TraceValue[]).map(keyIdentity).sort())}`;
        default: return 'unsupported';
    }
}

function strictValue(node: TraceValue, knownSecrets: readonly string[]): boolean {
    if (!object(node)) { return false; }
    if (node.type === 'none') { return keys(node, ['type']); }
    if (['bool', 'int', 'float', 'str', 'bytes'].includes(node.type)) {
        if (['str', 'bytes'].includes(node.type) && containsCredential(node.type === 'bytes'
            ? Buffer.from(node.value as string, 'hex').toString('utf8') : node.value as string, knownSecrets)) {
            throw new FixtureFailure('fixture-sensitive-content');
        }
        return keys(node, ['type', 'value']);
    }
    if (!['list', 'tuple', 'dict', 'set', 'frozenset'].includes(node.type) || !keys(node, ['type', 'items']) || !Array.isArray(node.items)) { return false; }
    if (node.type === 'dict') {
        const entries = node.items as Array<{ key: TraceValue; value: TraceValue }>;
        if (entries.some(pair => !object(pair) || !keys(pair, ['key', 'value'])
            || !strictValue(pair.key, knownSecrets) || !strictValue(pair.value, knownSecrets))) { return false; }
        if (new Set(entries.map(pair => keyIdentity(pair.key))).size !== entries.length) { return false; }
        if (entries.some(pair => pair.key.type === 'str' && ['str', 'bytes'].includes(pair.value.type)
            && containsCredential(`${pair.key.value} = ${JSON.stringify(pair.value.type === 'bytes'
                ? Buffer.from(pair.value.value as string, 'hex').toString('utf8') : pair.value.value)}`, knownSecrets))) {
            throw new FixtureFailure('fixture-sensitive-content');
        }
        return true;
    }
    const items = node.items as TraceValue[];
    return items.every(item => strictValue(item, knownSecrets))
        && (!['set', 'frozenset'].includes(node.type) || new Set(items.map(keyIdentity)).size === items.length);
}

function fixtureInput(input: unknown, knownSecrets: readonly string[]): input is TraceValueSnapshot {
    if (!object(input) || !keys(input, ['schema_version', 'replayable', 'value'])
        || !validTraceValueSnapshot(input) || !input.replayable || !strictValue(input.value, knownSecrets)) { return false; }
    const fields = typedCallFields(input);
    if (!fields || callFields.some(field => !fields[field])) { return false; }
    const snapshots = Object.fromEntries(callFields.map(field => [field,
        { schema_version: 'trace-value-v1', replayable: true, value: fields[field] }]));
    if (!validTraceInputSnapshot({ ...snapshots, replayable: true, call_graph: input })) { return false; }
    // Python transport adds source to the call graph before encoding the worker input.
    // Reserve its six nodes now so a full-budget input cannot be silently refused later.
    return validTraceValueSnapshot({ ...input, value: { type: 'dict', items: [...input.value.items!, {
        key: { type: 'str', value: 'source' }, value: { type: 'dict', items: [
            { key: { type: 'str', value: 'kind' }, value: { type: 'str', value: 'unknown' } },
            { key: { type: 'str', value: 'detail' }, value: { type: 'str', value: 'user-fixture' } }
        ] }
    }] } });
}

/** Read data only. No application import, fixture execution, expected value or assertion is accepted. */
export function loadTargetProbeFixtures(request: TargetProbeFixtureRequest): TargetProbeFixtures {
    const rejected = (code: ProbeFixtureDiagnosticCode, caseIndex?: number): TargetProbeFixtures =>
        ({ status: 'rejected', diagnostics: [{ code, ...(caseIndex === undefined ? {} : { caseIndex }) }] });
    if (request.fixtureFile === undefined || request.fixtureFile === '') { return { status: 'not-configured', diagnostics: [] }; }
    if (typeof request.fixtureFile !== 'string') { return rejected('fixture-path-rejected'); }
    if (request.fixtureFile.trim() === '') { return { status: 'not-configured', diagnostics: [] }; }
    let caseIndex: number | undefined;
    try {
        if (!localPath(request.root) || !path.isAbsolute(request.root)) { throw new FixtureFailure('fixture-path-rejected'); }
        const spelling = path.resolve(request.root);
        noLinks(spelling);
        const root = fs.realpathSync.native(spelling);
        if (!fs.lstatSync(root).isDirectory()) { throw new FixtureFailure('fixture-path-rejected'); }
        const source = boundFile(root, request.file, /\.pyw?$/i, 'source-path-rejected');
        const fixture = boundFile(root, request.fixtureFile, /\.json$/i, 'fixture-path-rejected');
        if (!/^[0-9a-f]{64}$/.test(request.sourceHash) || request.target.length > 512
            || !/^[_\p{ID_Start}][_\p{ID_Continue}]*(?:\.[_\p{ID_Start}][_\p{ID_Continue}]*)?$/u.test(request.target)) {
            throw new FixtureFailure('fixture-source-mismatch');
        }
        const bytes = stableBytes(fixture, MAX_PROBE_FIXTURE_BYTES, 'fixture-too-large');
        let document: unknown;
        try { document = JSON.parse(utf8(bytes)); } catch { throw new FixtureFailure('fixture-invalid-json'); }
        if (containsCredential(utf8(bytes), request.knownSecrets)) { throw new FixtureFailure('fixture-sensitive-content'); }
        if (!object(document) || !keys(document, ['schemaVersion', 'targets'])
            || document.schemaVersion !== PROBE_INPUT_FIXTURES_VERSION || !Array.isArray(document.targets) || document.targets.length > 128
            || document.targets.some(entry => !object(entry) || !keys(entry, ['file', 'target', 'sourceHash', 'inputs'])
                || typeof entry.file !== 'string' || typeof entry.target !== 'string' || typeof entry.sourceHash !== 'string')) {
            throw new FixtureFailure('fixture-invalid-schema');
        }
        const file = relativeName(root, source);
        const entries = document.targets.filter(entry => object(entry) && normalized(entry.file as string) === normalized(file) && entry.target === request.target) as Record<string, unknown>[];
        if (!entries.length) { return { status: 'not-targeted', diagnostics: [] }; }
        if (entries.length !== 1) { throw new FixtureFailure('fixture-target-ambiguous'); }
        const entry = entries[0];
        const sourceBytes = stableBytes(source, MAX_SOURCE_BYTES, 'source-path-rejected');
        utf8(sourceBytes);
        if (entry.sourceHash !== request.sourceHash || hash(sourceBytes) !== request.sourceHash) { throw new FixtureFailure('fixture-source-mismatch'); }
        const inputs = entry.inputs;
        if (!object(inputs) || !keys(inputs, ['schema_version', 'cases']) || inputs.schema_version !== 'probe-inputs-v1' || !Array.isArray(inputs.cases)) {
            throw new FixtureFailure('fixture-invalid-input');
        }
        if (!inputs.cases.length || inputs.cases.length > MAX_PROBE_FIXTURE_CASES) { throw new FixtureFailure('fixture-case-limit'); }
        const cases: TypedProbeInputsV1['cases'] = [];
        for (const [index, item] of inputs.cases.entries()) {
            caseIndex = index;
            if (!object(item) || !keys(item, ['input'])) { throw new FixtureFailure('fixture-invalid-input'); }
            if (object(item.input) && item.input.replayable === false) { throw new FixtureFailure('fixture-unsupported-input'); }
            if (!fixtureInput(item.input, request.knownSecrets ?? [])) { throw new FixtureFailure('fixture-invalid-input'); }
            cases.push({ input: item.input, source: { kind: 'unknown', detail: `user-fixture:${hash(bytes)}:${index}` } });
        }
        caseIndex = undefined;
        // Recheck after parsing: this result never grants permission to use a drifted source/fixture.
        if (hash(stableBytes(source, MAX_SOURCE_BYTES, 'source-path-rejected')) !== request.sourceHash
            || hash(stableBytes(fixture, MAX_PROBE_FIXTURE_BYTES, 'fixture-too-large')) !== hash(bytes)) {
            throw new FixtureFailure('fixture-drifted');
        }
        return { status: 'loaded', diagnostics: [], inputs: { schema_version: 'probe-inputs-v1', cases }, identity: {
            schemaVersion: PROBE_INPUT_FIXTURES_VERSION, fixtureFile: relativeName(root, fixture), fixtureHash: hash(bytes),
            file, target: request.target, sourceHash: request.sourceHash, caseCount: cases.length, inputOnly: true, userFixture: true
        } };
    } catch (error) { return rejected(error instanceof FixtureFailure ? error.code : 'fixture-unreadable', caseIndex); }
}
