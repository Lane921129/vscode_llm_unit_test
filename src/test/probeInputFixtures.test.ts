import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { evidenceHash } from '../pipeline/analysisJournal';
import { TraceValue, TraceValueSnapshot } from '../pipeline/evidenceContracts';
import { loadTargetProbeFixtures, MAX_PROBE_FIXTURE_BYTES, TargetProbeFixtureRequest } from '../pipeline/probeInputFixtures';
import { typedCallFields } from '../pipeline/probeInputs';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { withoutUncFileSystem } from './uncPathGuard';

const scalar = (type: string, value: string): TraceValue => ({ type, value });
const dictionary = (pairs: Array<[string, TraceValue]>): TraceValue => ({ type: 'dict', items:
    pairs.map(([key, value]) => ({ key: scalar('str', key), value })) });
const input = (args: TraceValue[] = [], kwargs: Array<[string, TraceValue]> = [], constructor: TraceValue[] = []): TraceValueSnapshot => ({
    schema_version: 'trace-value-v1', replayable: true, value: dictionary([
        ['args', { type: 'list', items: args }], ['kwargs', dictionary(kwargs)],
        ['constructor_args', { type: 'list', items: constructor }], ['constructor_kwargs', dictionary([])]
    ])
});
function fixture(operation: (request: TargetProbeFixtureRequest, write: (value: unknown) => void, directory: string) => void): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-probe-data-'));
    const source = '\ufeffdef advance(value):\r\n    return value + 1\r\n';
    fs.writeFileSync(path.join(directory, 'sample.py'), source, 'utf8');
    const request = { root: directory, file: path.join(directory, 'sample.py'), target: 'advance',
        sourceHash: evidenceHash(source), fixtureFile: 'trace-inputs.json' };
    const write = (value: unknown) => fs.writeFileSync(path.join(directory, 'trace-inputs.json'), JSON.stringify(value), 'utf8');
    try { operation(request, write, directory); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
const document = (request: TargetProbeFixtureRequest, cases: unknown[] = [{ input: input([scalar('int', '3')]) }]) => ({
    schemaVersion: 'probe-input-fixtures-v1', targets: [{ file: 'sample.py', target: request.target, sourceHash: request.sourceHash,
        inputs: { schema_version: 'probe-inputs-v1', cases } }]
});

test('manual fixtures preserve complete Python call types and source identity without supplying expected values', () => fixture((request, write) => {
    const typed = input([scalar('int', '900719925474099312345678901234567890'), scalar('float', '1.0'), scalar('float', '-0.0'),
        { type: 'tuple', items: [scalar('bytes', '0041'), scalar('str', 'x')] }],
    [['second', scalar('int', '2')], ['first', scalar('int', '1')]], [scalar('str', 'prefix')]);
    write(document(request, [{ input: typed }]));
    const result = loadTargetProbeFixtures(request);
    assert.equal(result.status, 'loaded');
    assert.deepEqual(result.inputs?.cases[0].input, typed);
    assert.equal(result.identity?.sourceHash, request.sourceHash, 'BOM and CRLF remain in the exact source hash');
    assert.equal(result.identity?.file, 'sample.py');
    assert.equal(result.identity?.inputOnly, true);
    assert.equal(result.identity?.userFixture, true);
    assert.deepEqual(result.inputs?.cases[0].source, { kind: 'unknown', detail: `user-fixture:${result.identity?.fixtureHash}:0` });
    assert.deepEqual(Object.keys(result.inputs!.cases[0]), ['input', 'source']);
}));

test('absent configuration and an untargeted fixture are distinct from refusing a selected stale entry', () => fixture((request, write) => {
    assert.equal(loadTargetProbeFixtures({ ...request, fixtureFile: undefined }).status, 'not-configured');
    const other = document(request); other.targets[0].target = 'different'; write(other);
    assert.deepEqual(loadTargetProbeFixtures(request), { status: 'not-targeted', diagnostics: [] });
    const stale = document(request); stale.targets[0].sourceHash = '0'.repeat(64); write(stale);
    assert.deepEqual(loadTargetProbeFixtures(request), { status: 'rejected', diagnostics: [{ code: 'fixture-source-mismatch' }] });
    write(document(request));
    fs.appendFileSync(request.file, '\n# source changed\n');
    assert.equal(loadTargetProbeFixtures(request).diagnostics[0].code, 'fixture-source-mismatch');
}));

test('duplicate exact target entries are rejected rather than selecting a first fixture', () => fixture((request, write) => {
    const value = document(request); value.targets.push({ ...value.targets[0] }); write(value);
    assert.equal(loadTargetProbeFixtures(request).diagnostics[0].code, 'fixture-target-ambiguous');
}));

test('a fixture cannot include an expected value, source claim or executable test snippet', () => fixture((request, write) => {
    for (const extra of [{ expected: 4 }, { source: { kind: 'caller_literals' } }, { code: 'raise RuntimeError()' }]) {
        write(document(request, [{ input: input(), ...extra }]));
        const result = loadTargetProbeFixtures(request);
        assert.equal(result.status, 'rejected'); assert.equal(result.inputs, undefined);
        assert.deepEqual(result.diagnostics, [{ code: 'fixture-invalid-input', caseIndex: 0 }]);
    }
    const hidden = input(); (hidden.value as any).expected = 4;
    write(document(request, [{ input: hidden }]));
    assert.equal(loadTargetProbeFixtures(request).status, 'rejected');
    // A business dictionary containing a key named expected is still ordinary input data.
    write(document(request, [{ input: input([dictionary([['expected', scalar('int', '4')]])]) }]));
    assert.equal(loadTargetProbeFixtures(request).status, 'loaded');
}));

test('file byte budget and case count are bounded before any fixture becomes executable input', () => fixture((request, write, directory) => {
    write(document(request, []));
    assert.equal(loadTargetProbeFixtures(request).diagnostics[0].code, 'fixture-case-limit');
    write(document(request, Array.from({ length: 33 }, () => ({ input: input() }))));
    assert.equal(loadTargetProbeFixtures(request).diagnostics[0].code, 'fixture-case-limit');
    fs.writeFileSync(path.join(directory, 'trace-inputs.json'), Buffer.alloc(MAX_PROBE_FIXTURE_BYTES + 1, 32));
    assert.equal(loadTargetProbeFixtures(request).diagnostics[0].code, 'fixture-too-large');
}));

test('lossy JSON values and complex object diagnostics do not fall back to untyped calls', () => fixture((request, write) => {
    for (const candidate of [{ args: [1], kwargs: {} }, input([{ type: 'int', value: 9007199254740992 as any }]),
        { schema_version: 'trace-value-v1', replayable: false, value: { type: 'unavailable', reason: 'unsupported-type', python_type: 'Box' } }]) {
        write(document(request, [{ input: candidate }]));
        const result = loadTargetProbeFixtures(request);
        assert.equal(result.status, 'rejected'); assert.equal(result.inputs, undefined);
    }
    const missingConstructor = input(); missingConstructor.value.items!.pop();
    write(document(request, [{ input: missingConstructor }]));
    assert.equal(loadTargetProbeFixtures(request).diagnostics[0].code, 'fixture-invalid-input');
}));

test('nested keys that Python would collapse are rejected without converting the actual argument values', () => fixture((request, write) => {
    const collisions: TraceValue[] = [
        { type: 'dict', items: [{ key: scalar('int', '1'), value: scalar('str', 'a') }, { key: scalar('float', '1.0'), value: scalar('str', 'b') }] },
        { type: 'set', items: [{ type: 'bool', value: false }, scalar('float', '-0.0')] },
        { type: 'dict', items: [{ key: { type: 'tuple', items: [scalar('int', '1')] }, value: scalar('str', 'a') },
            { key: { type: 'tuple', items: [scalar('float', '1.0')] }, value: scalar('str', 'b') }] }
    ];
    for (const value of collisions) {
        write(document(request, [{ input: input([value]) }]));
        assert.equal(loadTargetProbeFixtures(request).status, 'rejected');
    }
    write(document(request, [{ input: input([scalar('int', '9007199254740993'), scalar('float', '9007199254740992.0')]) }]));
    assert.equal(loadTargetProbeFixtures(request).status, 'loaded');
}));

test('typed input budgets reserve the source metadata that Python transport adds before worker execution', () => fixture((request, write) => {
    const values = [100, 100, 100, 100, 93].map(count => ({ type: 'list', items: Array.from({ length: count }, () => scalar('int', '0')) }));
    write(document(request, [{ input: input(values) }]));
    const result = loadTargetProbeFixtures(request);
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.diagnostics, [{ code: 'fixture-invalid-input', caseIndex: 0 }]);
}));

test('credential inputs are rejected with codes only, including tagged dictionary credential fields', () => fixture((request, write) => {
    const known = ['private', 'fixture', 'secret', '12345678'].join('-');
    write(document(request, [{ input: input([scalar('str', known)]) }]));
    const result = loadTargetProbeFixtures({ ...request, knownSecrets: [known] });
    assert.equal(result.diagnostics[0].code, 'fixture-sensitive-content');
    assert.ok(!JSON.stringify(result).includes(known));
    const contextual = 'neutral-opaque-value-01234567890123456789';
    write(document(request, [{ input: input([dictionary([['api_key', scalar('str', contextual)]])]) }]));
    assert.equal(loadTargetProbeFixtures(request).diagnostics[0].code, 'fixture-sensitive-content');
}));

test('escaped JSON strings and hex-encoded bytes cannot bypass decoded credential checks', () => fixture((request, write, directory) => {
    const known = ['private', 'fixture', 'secret', '12345678'].join('-');
    write(document(request, [{ input: input([scalar('str', known)]) }]));
    const file = path.join(directory, 'trace-inputs.json');
    const raw = fs.readFileSync(file, 'utf8').replace(known, '\\u0070' + known.slice(1));
    assert.ok(!raw.includes(known));
    fs.writeFileSync(file, raw);
    for (const kind of ['escaped-string', 'encoded-bytes']) {
        if (kind === 'encoded-bytes') { write(document(request, [{ input: input([scalar('bytes', Buffer.from(known).toString('hex'))]) }])); }
        const result = loadTargetProbeFixtures({ ...request, knownSecrets: [known] });
        assert.equal(result.diagnostics[0].code, 'fixture-sensitive-content');
        assert.ok(!JSON.stringify(result).includes(known));
    }
}));

test('ordinary JSON is required, and malformed UTF-8 is not silently replaced', () => fixture((request, _write, directory) => {
    fs.writeFileSync(path.join(directory, 'trace-inputs.json'), Buffer.from([0xff, 0x7b]));
    assert.equal(loadTargetProbeFixtures(request).diagnostics[0].code, 'fixture-invalid-json');
    assert.equal(loadTargetProbeFixtures({ ...request, fixtureFile: 'sample.py' }).diagnostics[0].code, 'fixture-path-rejected');
    assert.equal(loadTargetProbeFixtures({ ...request, file: 'original.db' }).diagnostics[0].code, 'source-path-rejected');
}));

test('escaped and network fixture/source paths are refused before querying those locations', async () => {
    await withoutUncFileSystem(() => fixture((request, write) => {
        write(document(request));
        for (const fixtureFile of ['../outside.json', '\\\\unread-host\\share\\inputs.json', '//unread-host/share/inputs.json']) {
            assert.equal(loadTargetProbeFixtures({ ...request, fixtureFile }).diagnostics[0].code, 'fixture-path-rejected');
        }
        assert.equal(loadTargetProbeFixtures({ ...request, root: '\\\\unread-host\\share' }).diagnostics[0].code, 'fixture-path-rejected');
        assert.equal(loadTargetProbeFixtures({ ...request, file: '../outside.py' }).diagnostics[0].code, 'source-path-rejected');
    }));
});

test('a directory junction cannot disguise a root-contained fixture or source', () => fixture((request, write, directory) => {
    write(document(request));
    const folder = path.join(directory, 'ordinary'); fs.mkdirSync(folder);
    fs.copyFileSync(path.join(directory, 'trace-inputs.json'), path.join(folder, 'inputs.json'));
    fs.copyFileSync(request.file, path.join(folder, 'sample.py'));
    const link = path.join(directory, 'linked');
    fs.symlinkSync(folder, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(loadTargetProbeFixtures({ ...request, fixtureFile: 'linked/inputs.json' }).diagnostics[0].code, 'fixture-path-rejected');
    assert.equal(loadTargetProbeFixtures({ ...request, file: path.join(link, 'sample.py') }).diagnostics[0].code, 'source-path-rejected');
    assert.equal(loadTargetProbeFixtures({ ...request, root: link }).diagnostics[0].code, 'fixture-path-rejected');
    const project = path.resolve(__dirname, '../..');
    const built = spawnSync(resolvePythonExecutable('', project), ['-B', path.join(project, 'python_scripts/probe_fixture_builder.py'),
        '--root', directory, '--file', path.join(link, 'sample.py'), '--target', 'advance'], {
        input: JSON.stringify({ cases: [{}] }), encoding: 'utf8', timeout: 30000
    });
    assert.equal(built.status, 2, built.stdout + built.stderr);
    assert.equal(JSON.parse(built.stdout).diagnostics[0].code, 'source-path-rejected', 'Python builder also refuses the original junction spelling');
}));

test('host literal builder output loads unchanged and never imports application code', () => fixture((request, _write, directory) => {
    const source = "raise RuntimeError('builder must never import this application')\ndef advance(data): return data\n";
    fs.writeFileSync(request.file, source, 'utf8'); request.sourceHash = evidenceHash(source);
    const project = path.resolve(__dirname, '../..');
    const python = resolvePythonExecutable('', project);
    const built = spawnSync(python, ['-B', path.join(project, 'python_scripts/probe_fixture_builder.py'), '--root', directory,
        '--file', request.file, '--target', request.target], { input: JSON.stringify({ cases: [{
            args_literals: "[(9007199254740993, b'\\x00A', 1.0, -0.0)]", kwargs_literals: "{'second': 2, 'first': 1}",
            constructor_kwargs_literals: "{'prefix': 'x'}"
        }] }), encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(built.status, 0, built.stderr + built.stdout);
    const builtDocument = JSON.parse(built.stdout);
    fs.writeFileSync(path.join(directory, 'trace-inputs.json'), built.stdout, 'utf8');
    const result = loadTargetProbeFixtures(request);
    assert.equal(result.status, 'loaded');
    assert.deepEqual(result.inputs?.cases[0].input, builtDocument.targets[0].inputs.cases[0].input);
    const fields = typedCallFields(result.inputs!.cases[0].input)!;
    assert.equal((fields.args.items![0] as TraceValue).type, 'tuple');
    assert.equal((fields.constructor_kwargs!.items![0] as any).key.value, 'prefix');
    assert.equal(result.identity?.sourceHash, evidenceHash(source));
}));
