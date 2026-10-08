import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createImportFixturePlan } from '../pipeline/importFixtures';
import { canonicalExternalResourcePath, resourceLogicalPath, resourceSpecKey, validateResourceLocation,
    validateTestResources, type TestResourceSpec } from '../pipeline/isolatedResources';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const external = (resourcePath: string): TestResourceSpec => ({ path: resourcePath, scope: 'external-exact', kind: 'directory' });

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'external-resource-'));
    const root = path.join(base, 'selected', 'app'), data = path.join(base, 'ExternalData');
    fs.mkdirSync(root, { recursive: true });
    const source = 'def target(): return 1\n', file = path.join(root, 'sample.py');
    fs.writeFileSync(file, source);
    const make = (resources: TestResourceSpec[], sourceHash = digest(source)) => createImportFixturePlan(root,
        [{ file: 'sample.py', resources, resourceSourceHash: sourceHash }])!;
    return { base, root, data, file, source, make };
}

test('external paths use a native absolute canonical identity and reject unsafe raw spelling before normalization', () => {
    const windows = process.platform === 'win32';
    const input = windows ? 'C:\\NeutralExternal\\Data' : '/neutral-external/Data';
    const canonical = windows ? 'c:/neutralexternal/data' : input;
    assert.equal(canonicalExternalResourcePath(input), canonical);
    assert.deepEqual(validateTestResources([external(input)]), [external(canonical)]);
    assert.equal(resourceLogicalPath(external(input)), canonical);
    assert.equal(resourceSpecKey(external(input)), 'external-exact:' + canonical);
    if (windows) {
        assert.equal(resourceSpecKey(external('C:/NEUTRALEXTERNAL/DATA')), resourceSpecKey(external(input)));
    } else {
        assert.notEqual(resourceSpecKey(external('/neutral-external/data')), resourceSpecKey(external(input)));
    }
    const prefix = windows ? 'C:/' : '/';
    for (const value of ['', 'relative/path', prefix, prefix + 'data/../other', prefix + 'data/./other',
        prefix + 'data//other', prefix + 'data/', prefix + 'data/name.', prefix + 'data/name ',
        prefix + 'data/NUL', prefix + 'data/COM1.txt', prefix + 'data/item:stream', prefix + 'data/runner.PY',
        prefix + 'data/load.dll', prefix + 'data/run.ps1', prefix + 'data/*', prefix + 'data/\u0000name',
        prefix + 'x'.repeat(241), '//server/share/data', '\\\\server\\share\\data', '\\\\?\\C:\\data',
        '\\\\.\\C:\\data', 'C:relative', ...(windows ? ['/rooted-without-drive'] : ['C:/foreign-drive', '/data\\name'])]) {
        assert.throws(() => validateTestResources([external(value)]), /Invalid/, value);
    }
    assert.throws(() => validateTestResources([{ path: input, scope: 'external', kind: 'directory' }]), /Invalid/);
    assert.throws(() => validateTestResources([{ path: input, kind: 'directory' }]), /Invalid/,
        'absolute paths remain forbidden without the new explicit scope');
});

test('external declarations are outside the existing parent scope and cannot contain selected source', () => {
    const item = fixture();
    try {
        assert.doesNotThrow(() => item.make([external(item.data)]));
        for (const candidate of [item.root, path.join(item.root, 'data'), path.dirname(item.root),
            path.join(path.dirname(item.root), 'SiblingData'), item.base, path.dirname(item.base)]) {
            assert.throws(() => item.make([external(candidate)]), /Invalid/, candidate);
        }
        assert.doesNotThrow(() => item.make([{ path: 'SiblingData', scope: 'project-parent', kind: 'directory' }]));
        assert.doesNotThrow(() => item.make([{ path: 'data', kind: 'directory' }]));
        assert.equal(fs.existsSync(item.data), false, 'validating an external mount must not materialize it');
    } finally { fs.rmSync(item.base, { recursive: true, force: true }); }
});

test('external path, seed, schema and source approvals remain bound to plan identity', () => {
    const item = fixture();
    const resources: TestResourceSpec[] = [external(item.data),
        { path: path.join(item.data, 'settings.ini'), scope: 'external-exact', kind: 'text', text: 'test input' },
        { path: path.join(item.data, 'items.db'), scope: 'external-exact', kind: 'sqlite', tables: [
            { name: 'entries', columns: [{ name: 'id', type: 'INTEGER' }], rows: [{ id: 1 }] }
        ] }];
    try {
        const plan = item.make(resources);
        assert.equal(plan.rules[0].resources![0].path, canonicalExternalResourcePath(item.data));
        if (process.platform === 'win32') {
            const alternate = resources.map(resource => ({ ...resource, path: resource.path.replace(/\\/g, '/').toUpperCase() }));
            assert.equal(item.make(alternate).id, plan.id, 'Windows spelling changes do not change the approved logical identity');
        }
        assert.notEqual(item.make([external(item.data + '-different')]).id, item.make([external(item.data)]).id);
        for (const change of ['seed', 'schema']) {
            const changed = structuredClone(resources);
            const db = changed[2]; assert.equal(db.kind, 'sqlite');
            if (db.kind === 'sqlite') {
                if (change === 'seed') { db.tables[0].rows![0].id = 2; }
                else { db.tables[0].columns[0].type = 'REAL'; }
            }
            assert.notEqual(item.make(changed).id, plan.id);
        }
        assert.throws(() => item.make(resources, '0'.repeat(64)), /approval/);
        fs.writeFileSync(item.file, item.source + '# changed source\n');
        assert.throws(() => item.make(resources), /expired/);
        assert.equal(fs.existsSync(item.data), false);
    } finally { fs.rmSync(item.base, { recursive: true, force: true }); }
});

test('external validation inspects metadata without reading original resource contents', () => {
    const item = fixture(); fs.mkdirSync(item.data);
    const original = path.join(item.data, 'original.txt'); fs.writeFileSync(original, 'untouched original input');
    const files = require('node:fs'), read = files.readFileSync, open = files.openSync, list = files.readdirSync;
    const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const protectedRoot = normalized(item.data);
    const guard = (operation: (...args: any[]) => any) => (...args: any[]) => {
        if (typeof args[0] === 'string' && (normalized(args[0]) === protectedRoot
            || normalized(args[0]).startsWith(protectedRoot + path.sep))) {
            throw new Error('resource content must not be read during validation');
        }
        return operation(...args);
    };
    try {
        files.readFileSync = guard(read); files.openSync = guard(open); files.readdirSync = guard(list);
        assert.doesNotThrow(() => item.make([external(item.data)]));
    } finally {
        files.readFileSync = read; files.openSync = open; files.readdirSync = list;
        assert.equal(fs.readFileSync(original, 'utf8'), 'untouched original input');
        fs.rmSync(item.base, { recursive: true, force: true });
    }
});

test('external aliases and file mounts cannot hide links or conflicting seeds', () => {
    const item = fixture(); fs.mkdirSync(item.data);
    const alias = path.join(item.base, 'ExternalAlias'); fs.symlinkSync(item.data, alias, 'junction');
    try {
        assert.throws(() => item.make([external(alias)]), /Invalid/);
        assert.throws(() => item.make([external(path.join(alias, 'new-child'))]), /Invalid/);
        const filename = path.join(item.data, 'settings.ini');
        const text: TestResourceSpec = { path: filename, scope: 'external-exact', kind: 'text', text: 'first' };
        const aliasName = process.platform === 'win32' ? filename.toUpperCase() : filename;
        assert.throws(() => item.make([text, { ...text, path: aliasName, text: 'different' }]), /Invalid/);
        assert.throws(() => item.make([text, external(path.join(filename, 'child'))]), /Invalid/);
        assert.doesNotThrow(() => item.make([external(item.data), text, { ...text, path: aliasName }]));
        assert.equal(fs.existsSync(filename), false);
    } finally { fs.rmSync(item.base, { recursive: true, force: true }); }
});

test('native Windows cross-drive external validation stays lexical and never creates the original directory', {
    skip: process.platform !== 'win32'
}, () => {
    const item = fixture();
    const drive = ['C:', 'D:'].find(value => value.toLowerCase() !== path.parse(item.root).root.slice(0, 2).toLowerCase())!;
    const destination = drive + '/llm-unit-test-external-' + randomUUID();
    try {
        assert.equal(fs.existsSync(destination), false);
        assert.doesNotThrow(() => validateResourceLocation(item.root, external(destination)));
        assert.doesNotThrow(() => item.make([external(destination)]));
        assert.equal(fs.existsSync(destination), false);
    } finally { fs.rmSync(item.base, { recursive: true, force: true }); }
});
