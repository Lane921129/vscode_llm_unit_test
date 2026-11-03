import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createImportFixturePlan, importFixtureEnvironment, withImportFixtures } from '../pipeline/importFixtures';
import { closeResourceLease, createResourceLease, RESOURCE_LEASE_ENV, RESOURCE_LEASE_MARKER, TestResourceSpec,
    validateTestResources, type ResourceLease } from '../pipeline/isolatedResources';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { runSpawn } from '../utils/processRunner';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const resources: TestResourceSpec[] = [
    { path: 'data', kind: 'directory' },
    { path: 'data/config.ini', kind: 'text', text: '[test]\nvalue=4\n' },
    { path: 'data/app.sqlite', kind: 'sqlite', tables: [{ name: 'entries',
        columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }, { name: 'name', type: 'TEXT', notNull: true }],
        rows: [{ id: 1, name: 'example' }] }] }
];

test('journal failures keep existing process and cleanup errors and never expose observer text', async () => {
    const processError = new Error('original-process-failure');
    const cleanupError = new Error('original-cleanup-failure');
    const lease = (failCleanup: boolean): ResourceLease => ({ directory: 'unused-test-directory',
        lifecycle: { schemaVersion: 'isolated-resource-lifecycle-v1', planId: 'plan', created: true, cleaned: !failCleanup },
        dispose: async () => { if (failCleanup) { throw cleanupError; } } });
    const observer = () => { throw new Error('PRIVATE_OBSERVER_DETAIL'); };
    await closeResourceLease(lease(false), observer, { error: processError });
    assert.equal((processError as any).resourceJournalError, 'resource-lifecycle-observer-failed');
    assert.equal(processError.message, 'original-process-failure');
    await assert.rejects(closeResourceLease(lease(true), observer, { error: processError }), (error: any) =>
        error === cleanupError && error.cause === processError && error.resourceJournalError === 'resource-lifecycle-observer-failed');
    await assert.rejects(closeResourceLease(lease(false), observer), (error: any) =>
        error.message === 'Resource lifecycle reporting failed.' && !String(error).includes('PRIVATE_OBSERVER_DETAIL'));
});

test('resource declarations bind reviewed source and seed identity without authorizing executable content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-plan-'));
    const source = 'def target(): return 1\n';
    const file = path.join(root, 'sample.py'); fs.writeFileSync(file, source);
    try {
        const rule = { file: 'sample.py', resources, resourceSourceHash: digest(source) };
        const plan = createImportFixturePlan(root, [rule])!;
        assert.deepEqual(plan.rules[0].resources, resources);
        const changed = structuredClone(rule); (changed.resources[1] as { text: string }).text = 'changed seed';
        assert.notEqual(createImportFixturePlan(root, [changed])!.id, plan.id);
        assert.throws(() => createImportFixturePlan(root, [{ file: 'sample.py', resources }]), /approval/);
        assert.throws(() => createImportFixturePlan(root, [{ ...rule, resourceSourceHash: '0'.repeat(64) }]), /approval/);
        fs.writeFileSync(file, source + '# changed\n');
        assert.throws(() => createImportFixturePlan(root, [rule]), /expired/);
        fs.writeFileSync(file, source);
        for (const resourcePath of ['', '../data', '/absolute', 'a/../b', 'a/./b', 'a//b', 'C:/data', 'a\\b',
            'a\u0000b', 'app.py', 'runner.PS1', 'folder/name.', 'NUL', 'data/*.json']) {
            assert.throws(() => validateTestResources([{ kind: 'directory', path: resourcePath }]), /Invalid/, resourcePath);
        }
        for (const invalid of [
            [{ path: 'data', kind: 'directory', text: '' }],
            [{ path: 'seed', kind: 'text', text: 'é'.repeat(32769) }],
            [{ path: 'db', kind: 'sqlite', tables: [], sql: 'DROP TABLE entries' }],
            [{ path: 'db', kind: 'sqlite', tables: [{ name: 'invalid;drop', columns: [] }] }],
            [{ path: 'db', kind: 'sqlite', tables: [{ name: 'entries', columns: [{ name: 'value', type: 'TEXT' }], rows: [{ other: 1 }] }] }],
            [{ path: 'db', kind: 'sqlite', tables: [{ name: 'entries', columns: [{ name: 'value', type: 'TEXT' }], rows: [{ value: Infinity }] }] }],
            [{ path: 'db', kind: 'sqlite', tables: [{ name: 'entries', columns: [{ name: 'v', type: 'TEXT' }, { name: 'V', type: 'TEXT' }] }] }]
        ]) { assert.throws(() => validateTestResources(invalid)); }
        assert.equal(fs.existsSync(path.join(root, 'data')), false, 'validation never materializes resources in the source tree');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SQLite default and uniqueness declarations retain exact values and bind the plan identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-identity-'));
    const source = 'def target(): return 1\n'; fs.writeFileSync(path.join(root, 'sample.py'), source);
    const spec: TestResourceSpec = { kind: 'sqlite', path: 'fixture.db', tables: [{ name: 'entries', columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true },
        { name: 'code', type: 'TEXT', unique: true, default: "quoted'; DROP TABLE entries; --" },
        { name: 'amount', type: 'REAL', default: 2.5 }, { name: 'optional', type: 'TEXT', default: null }
    ], unique: [['code', 'amount']] }] };
    try {
        assert.deepEqual(validateTestResources([spec]), [spec]);
        const makePlan = (resource: TestResourceSpec) => createImportFixturePlan(root,
            [{ file: 'sample.py', resourceSourceHash: digest(source), resources: [resource] }])!;
        const plan = makePlan(spec);
        for (const changed of [
            { ...spec, tables: [{ ...spec.tables[0], unique: [['code']] }] },
            { ...spec, tables: [{ ...spec.tables[0], columns: spec.tables[0].columns.map(column =>
                column.name === 'code' ? { ...column, default: 'different' } : column) }] }
        ]) { assert.notEqual(makePlan(changed).id, plan.id); }
        for (const change of [{ default: { sql: 'CURRENT_TIMESTAMP' } }, { default: 'nul\0' },
            { default: Number.NaN }, { default: 2 ** 53 }, { default: '漢'.repeat(1366) },
            { autoIncrement: true, type: 'TEXT' }, { autoIncrement: true, primaryKey: false }, { unique: 'yes' }]) {
            assert.throws(() => validateTestResources([{ ...spec, tables: [{ name: 'entries',
                columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, ...change }] }] }]));
        }
        for (const unique of [null, [[]], [['missing']], [['code', 'code']], [['code'], ['code']]]) {
            assert.throws(() => validateTestResources([{ ...spec, tables: [{ ...spec.tables[0], unique }] }]));
        }
        assert.equal(fs.existsSync(path.join(root, 'fixture.db')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('shared identical seeds are valid, while conflicting mounts and source-containing mounts are rejected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-mount-'));
    const source = 'value = 1\n'; fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.py'), source); fs.writeFileSync(path.join(root, 'src', 'b.py'), source);
    const rule = (file: string, selected: TestResourceSpec[]) => ({ file, resources: selected, resourceSourceHash: digest(source) });
    try {
        assert.doesNotThrow(() => createImportFixturePlan(root, [rule('src/a.py', resources), rule('src/b.py', resources)]));
        assert.throws(() => createImportFixturePlan(root, [rule('src/a.py', resources),
            rule('src/b.py', [{ kind: 'text', path: 'data/config.ini', text: 'different' }])]));
        assert.throws(() => createImportFixturePlan(root, [rule('src/a.py', [{ kind: 'directory', path: 'src' }])]));
        assert.throws(() => createImportFixturePlan(root, [rule('src/a.py', [{ kind: 'text', path: 'data', text: '' },
            { kind: 'text', path: 'data/child', text: '' }])]));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('parent-scoped resources are source-bound siblings, distinct from project paths and reject aliases', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-parent-'));
    const root = path.join(parent, 'app'); fs.mkdirSync(root);
    const source = 'def target(): return 1\n'; fs.writeFileSync(path.join(root, 'sample.py'), source);
    const make = (resources: TestResourceSpec[]) => createImportFixturePlan(root,
        [{ file: 'sample.py', resources, resourceSourceHash: digest(source) }])!;
    try {
        const outside: TestResourceSpec = { path: 'SharedData', scope: 'project-parent', kind: 'directory' };
        const inside: TestResourceSpec = { path: 'SharedData', kind: 'directory' };
        assert.notEqual(make([outside]).id, make([inside]).id, 'scope participates in evidence identity');
        assert.doesNotThrow(() => make([inside, outside,
            { path: 'SharedData/item.txt', kind: 'text', text: 'inside' },
            { path: 'SharedData/item.txt', scope: 'project-parent', kind: 'text', text: 'outside' }]));
        assert.throws(() => make([outside,
            { path: 'SharedData', scope: 'project-parent', kind: 'text', text: 'conflict' }]));
        for (const resourcePath of ['app', 'app/data', '.', '..', '../outside', '/outside', 'C:/outside', 'app/source.py']) {
            assert.throws(() => make([{ ...outside, path: resourcePath }]), /Invalid/, resourcePath);
        }
        assert.throws(() => validateTestResources([{ ...outside, scope: 'project' }]));
        const original = path.join(parent, 'OriginalData'); fs.mkdirSync(original);
        fs.writeFileSync(path.join(original, 'marker.txt'), 'original data');
        const linked = path.join(parent, 'AliasData'); fs.symlinkSync(original, linked, 'junction');
        assert.throws(() => make([{ ...outside, path: 'AliasData' }]));
        assert.throws(() => make([{ ...outside, path: 'AliasData/new-child' }]));
        assert.equal(fs.readFileSync(path.join(original, 'marker.txt'), 'utf8'), 'original data');
        assert.equal(fs.existsSync(path.join(parent, 'SharedData')), false);
        assert.equal(fs.existsSync(path.join(root, 'SharedData')), false);
        assert.equal(fs.readFileSync(path.join(root, 'sample.py'), 'utf8'), source);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('resource leases are distinct, host-owned and cleaned after successful or failed workers', async () => {
    const plan = { id: 'a'.repeat(64), rules: [{ file: 'sample.py', resources }] };
    const one = createResourceLease(plan)!, two = createResourceLease(plan)!;
    try {
        assert.notEqual(one.directory, two.directory);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(one.directory, RESOURCE_LEASE_MARKER), 'utf8')),
            { schemaVersion: 'isolated-resource-lease-v1', ownerPid: process.pid });
        fs.mkdirSync(path.join(one.directory, 'worker')); fs.writeFileSync(path.join(one.directory, 'worker', 'data'), 'seed');
        await one.dispose();
        assert.equal(fs.existsSync(one.directory), false); assert.equal(one.lifecycle.cleaned, true);
        assert.equal(fs.existsSync(two.directory), true);
        await one.dispose();
        assert.equal(importFixtureEnvironment({ [RESOURCE_LEASE_ENV]: two.directory })[RESOURCE_LEASE_ENV], undefined);
    } finally { await one.dispose(); await two.dispose(); }
    assert.equal(createResourceLease({ id: 'b', rules: [] }), undefined);
});

test('the process runner cleans resources on success, nonzero exit, spawn error, timeout and cancellation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-run-'));
    const source = 'value = 1\n'; fs.writeFileSync(path.join(root, 'sample.py'), source);
    const plan = createImportFixturePlan(root, [{ file: 'sample.py', resources, resourceSourceHash: digest(source) }])!;
    const resourceModule = require('../pipeline/isolatedResources');
    const originalCreate = resourceModule.createResourceLease;
    const leases: ResourceLease[] = [];
    resourceModule.createResourceLease = (...args: Parameters<typeof createResourceLease>) => {
        const lease = originalCreate(...args); if (lease) { leases.push(lease); } return lease;
    };
    try {
        await withImportFixtures(plan, async () => {
            for (const code of [0, 7]) {
                const result = await runSpawn(process.execPath, ['-e',
                    `const fs=require('fs'),p=process.env.${RESOURCE_LEASE_ENV}; fs.mkdirSync(p+'/worker'); process.stdout.write(p); process.exit(${code});`], {});
                assert.equal(result.code, code); assert.equal(result.resourceLifecycle?.cleaned, true);
                assert.equal(fs.existsSync(result.stdout), false);
            }
            await assert.rejects(runSpawn(path.join(root, 'missing-executable'), [], {}), /ENOENT/);
            assert.equal(leases.at(-1)!.lifecycle.cleaned, true);
            await assert.rejects(runSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /超時/);
            assert.equal(leases.at(-1)!.lifecycle.cleaned, true);
            const execution = new ExecutionContext(null);
            const events: unknown[] = [];
            const unsubscribe = execution.subscribeResourceLifecycle(event => events.push(event));
            const running = runInExecution(execution, () => runSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 5000 }));
            const rejected = assert.rejects(running, /中止/);
            await delay(50); execution.cancel(); await rejected;
            assert.equal(leases.at(-1)!.lifecycle.cleaned, true);
            assert.deepEqual(events, [{ schemaVersion: 'isolated-resource-lifecycle-v1', planId: plan.id, created: true, cleaned: true }]);
            unsubscribe();
        });
        assert.equal(leases.length, 5);
        assert.ok(leases.every(lease => !fs.existsSync(lease.directory)));
        const result = await runSpawn(process.execPath, ['-e', `process.stdout.write(process.env.${RESOURCE_LEASE_ENV}||'none')`],
            { env: { ...process.env, [RESOURCE_LEASE_ENV]: root } });
        assert.equal(result.stdout, 'none'); assert.equal(result.resourceLifecycle, undefined);
        assert.equal(fs.existsSync(root), true, 'an inherited lease is never owned or removed by this runner');
    } finally {
        resourceModule.createResourceLease = originalCreate;
        for (const lease of leases) { await lease.dispose(); }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('cancellation drains the owned child tree before deleting its shared resource lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-tree-'));
    const source = 'value=1\n'; fs.writeFileSync(path.join(root, 'sample.py'), source);
    const plan = createImportFixturePlan(root, [{ file: 'sample.py', resources, resourceSourceHash: digest(source) }])!;
    const recorded = path.join(root, 'owned.json');
    const execution = new ExecutionContext(null);
    const script = `const fs=require('fs'),{spawn}=require('child_process');
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
        fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid,lease:process.env.${RESOURCE_LEASE_ENV}}));
        setInterval(()=>{},1000);`;
    const running = withImportFixtures(plan, () => runInExecution(execution,
        () => runSpawn(process.execPath, ['-e', script, recorded], { timeout: 10000 })));
    const rejected = assert.rejects(running, /中止/);
    try {
        for (let attempt = 0; attempt < 200 && !fs.existsSync(recorded); attempt++) { await delay(10); }
        assert.ok(fs.existsSync(recorded), 'the owned process tree must start before cancellation');
        const owned = JSON.parse(fs.readFileSync(recorded, 'utf8'));
        assert.equal(fs.existsSync(owned.lease), true);
        execution.cancel(); await rejected;
        assert.equal(fs.existsSync(owned.lease), false);
        for (const pid of [owned.parent, owned.child]) {
            let alive = false;
            try {
                process.kill(pid, 0);
                alive = !(process.platform === 'linux'
                    && /\nState:\s+Z/.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')));
            } catch { /* An exited child has no live process identity. */ }
            assert.equal(alive, false, 'resource cleanup must not race a still-running owned child');
        }
    } finally { execution.cancel(); await rejected; fs.rmSync(root, { recursive: true, force: true }); }
});

test('cleanup ownership failures reject even a successful worker instead of claiming completion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-cleanup-'));
    const source = 'value=1\n'; fs.writeFileSync(path.join(root, 'sample.py'), source);
    const plan = createImportFixturePlan(root, [{ file: 'sample.py', resources, resourceSourceHash: digest(source) }])!;
    const resourceModule = require('../pipeline/isolatedResources'), originalCreate = resourceModule.createResourceLease;
    let owned: ResourceLease | undefined;
    resourceModule.createResourceLease = (...args: Parameters<typeof createResourceLease>) => owned = originalCreate(...args);
    try {
        await assert.rejects(withImportFixtures(plan, () => runSpawn(process.execPath, ['-e',
            `require('fs').unlinkSync(require('path').join(process.env.${RESOURCE_LEASE_ENV},'${RESOURCE_LEASE_MARKER}'))`], {})),
        (error: any) => /cleanup failed/.test(error.message) && error.resourceLifecycle.cleaned === false);
        assert.ok(owned); assert.equal(fs.existsSync(owned.directory), true);
    } finally {
        resourceModule.createResourceLease = originalCreate;
        if (owned) {
            fs.writeFileSync(path.join(owned.directory, RESOURCE_LEASE_MARKER),
                JSON.stringify({ schemaVersion: 'isolated-resource-lease-v1', ownerPid: process.pid }));
            await owned.dispose();
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
