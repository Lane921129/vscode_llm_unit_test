import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createImportFixturePlan } from '../pipeline/importFixtures';
import { canonicalExternalResourcePath, canonicalUncResourcePath, resourceLogicalPath, resourceSpecKey,
    validateResourceLocation, validateTestResources, type TestResourceSpec } from '../pipeline/isolatedResources';

const windows = { skip: process.platform !== 'win32' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const unc = (resourcePath: string): TestResourceSpec => ({ path: resourcePath, scope: 'unc-virtual', kind: 'directory' });

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unc-resource-'));
    const root = path.join(base, 'app'); fs.mkdirSync(root);
    const source = 'def target(): return 1\n', file = path.join(root, 'sample.py');
    fs.writeFileSync(file, source);
    const make = (resources: TestResourceSpec[], sourceHash = digest(source)) => createImportFixturePlan(root,
        [{ file: 'sample.py', resources, resourceSourceHash: sourceHash }])!;
    return { base, root, file, source, make };
}

/** Even a failed remote metadata call would violate the purely virtual contract. */
function forbidUncFilesystem() {
    const files = require('node:fs');
    const names = ['lstatSync', 'statSync', 'realpathSync', 'openSync', 'readFileSync', 'readdirSync', 'existsSync'];
    const originals = new Map<string, (...args: any[]) => any>();
    let uncCalls = 0;
    for (const name of names) {
        const original = files[name]; originals.set(name, original);
        files[name] = (...args: any[]) => {
            if (typeof args[0] === 'string' && args[0].replace(/\\/g, '/').startsWith('//')) {
                uncCalls++; throw new Error('UNC identifiers must never reach filesystem operations');
            }
            return original(...args);
        };
    }
    return { count: () => uncCalls, restore: () => { for (const [name, original] of originals) { files[name] = original; } } };
}

test('UNC virtual identifiers preserve share roots and canonicalize only safe native spelling', windows, () => {
    for (const spelling of ['//Neutral-Server/TestShare', '//NEUTRAL-SERVER/TESTSHARE/', '\\\\Neutral-Server\\TestShare\\']) {
        assert.equal(canonicalUncResourcePath(spelling), '//neutral-server/testshare');
        assert.deepEqual(validateTestResources([unc(spelling)]), [unc('//neutral-server/testshare')]);
        assert.equal(resourceLogicalPath(unc(spelling)), '//neutral-server/testshare');
        assert.equal(resourceSpecKey(unc(spelling)), 'unc-virtual://neutral-server/testshare');
    }
    assert.equal(canonicalUncResourcePath('\\\\Neutral-Server\\TestShare\\nested\\value.txt'),
        '//neutral-server/testshare/nested/value.txt');
    for (const share of ['C$', 'ADMIN$', 'hidden$']) {
        assert.equal(canonicalUncResourcePath('//Neutral-Server/' + share), '//neutral-server/' + share.toLowerCase());
    }
    for (const bad of ['', 'relative/path', 'C:/data', '/server/share', '//server', '//server/', '///server/share',
        '//server//share', '//server/share//', '//server/share/tail/', '//server/share/./tail', '//server/share/../tail',
        '//server/share/tail//value', '//server/share/value:stream', '//server/share/value.', '//server/share/value ',
        '//server/share/CON', '//server/share/lpt1.txt', '//server/share/run.PY', '//server/share/run.exe',
        '//server/share/bad\u0000', '//server/share/*', '//?/UNC/server/share', '//./pipe/name', '//server/IPC$',
        '//server/ipc$/tail', '//CON/share', '//server/' + 'x'.repeat(241)]) {
        assert.throws(() => validateTestResources([unc(bad)]), /Invalid/, bad);
    }
    assert.throws(() => canonicalExternalResourcePath('//server/share'), /Invalid/,
        'the new virtual scope does not relax external-exact');
    assert.throws(() => validateTestResources([{ path: '//server/share', kind: 'directory' }]), /Invalid/);
});

test('UNC virtual scope rejects non-Windows hosts before inspecting any path', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
        Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
        assert.throws(() => canonicalUncResourcePath('//server/share'), /Invalid/);
        assert.throws(() => validateTestResources([unc('//server/share')]), /Invalid/);
    } finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('UNC virtual plans perform no resource filesystem query, including share roots', windows, () => {
    const item = fixture(), guard = forbidUncFilesystem();
    try {
        const resources: TestResourceSpec[] = [unc('\\\\Neutral-Server\\TestShare\\'),
            { path: '//neutral-server/testshare/label.txt', scope: 'unc-virtual', kind: 'text', text: 'local seed' },
            { path: '//neutral-server/testshare/items.db', scope: 'unc-virtual', kind: 'sqlite', tables: [
                { name: 'items', columns: [{ name: 'id', type: 'INTEGER' }], rows: [{ id: 1 }] }
            ] }];
        const plan = item.make(resources);
        assert.equal(plan.rules[0].resources![0].path, '//neutral-server/testshare');
        assert.equal(guard.count(), 0);
        assert.doesNotThrow(() => validateResourceLocation('//neutral-server/source/app', unc('//neutral-server/testshare')));
        assert.equal(guard.count(), 0);
    } finally { guard.restore(); fs.rmSync(item.base, { recursive: true, force: true }); }
});

test('UNC source overlap is rejected lexically in both directions without remote metadata', windows, () => {
    const guard = forbidUncFilesystem();
    try {
        for (const source of ['//Neutral-Server/TestShare/app', '\\\\Neutral-Server\\TestShare\\app',
            '\\\\?\\UNC\\Neutral-Server\\TestShare\\app']) {
            for (const selected of ['//neutral-server/testshare', '//neutral-server/testshare/app',
                '//neutral-server/testshare/app/data']) {
                assert.throws(() => validateResourceLocation(source, unc(selected)), /Invalid/);
            }
            assert.doesNotThrow(() => validateResourceLocation(source, unc('//neutral-server/testshare/app2')));
            assert.doesNotThrow(() => validateResourceLocation(source, unc('//neutral-server/othershare')));
        }
        assert.throws(() => validateResourceLocation('//neutral-server/testshare/', unc('//neutral-server/testshare/data')), /Invalid/);
        assert.equal(guard.count(), 0);
    } finally { guard.restore(); }
});

test('UNC plan identity binds source, seed, schema and canonical spelling', windows, () => {
    const item = fixture(), guard = forbidUncFilesystem();
    const resources: TestResourceSpec[] = [unc('//Neutral-Server/TestShare'),
        { path: '//Neutral-Server/TestShare/items.db', scope: 'unc-virtual', kind: 'sqlite', tables: [
            { name: 'items', columns: [{ name: 'id', type: 'INTEGER' }], rows: [{ id: 1 }] }
        ] }];
    try {
        const plan = item.make(resources);
        assert.equal(item.make(resources.map(resource => ({ ...resource, path: resource.path.replace(/\//g, '\\').toUpperCase() }))).id,
            plan.id);
        assert.notEqual(item.make([unc('//neutral-server/other-share')]).id, item.make([resources[0]]).id);
        for (const change of ['seed', 'schema']) {
            const changed = structuredClone(resources), db = changed[1];
            if (db.kind === 'sqlite') {
                if (change === 'seed') { db.tables[0].rows![0].id = 2; }
                else { db.tables[0].columns[0].type = 'REAL'; }
            }
            assert.notEqual(item.make(changed).id, plan.id);
        }
        assert.throws(() => item.make(resources, '0'.repeat(64)), /approval/);
        fs.writeFileSync(item.file, item.source + '# changed\n');
        assert.throws(() => item.make(resources), /expired/);
        assert.equal(guard.count(), 0);
    } finally { guard.restore(); fs.rmSync(item.base, { recursive: true, force: true }); }
});

test('UNC case aliases may share seeds but conflicting or nested file mounts are rejected', windows, () => {
    const item = fixture(), guard = forbidUncFilesystem();
    const text: TestResourceSpec = { path: '//neutral-server/testshare/value.txt', scope: 'unc-virtual', kind: 'text', text: 'seed' };
    try {
        assert.doesNotThrow(() => item.make([unc('//neutral-server/testshare'), text, { ...text, path: text.path.toUpperCase() }]));
        assert.throws(() => item.make([text, { ...text, path: text.path.toUpperCase(), text: 'different' }]), /Invalid/);
        assert.throws(() => item.make([text, unc(text.path + '/child')]), /Invalid/);
        assert.equal(guard.count(), 0);
    } finally { guard.restore(); fs.rmSync(item.base, { recursive: true, force: true }); }
});
