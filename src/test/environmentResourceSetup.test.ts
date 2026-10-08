import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectPython, runSetupCommand, setupEnvironment } from '../environment/pythonEnvironmentSetup';
import { createImportFixturePlan, IMPORT_FIXTURE_ENV, withImportFixtures } from '../pipeline/importFixtures';
import { RESOURCE_LEASE_ENV, type ResourceLease, type ResourceLifecycle } from '../pipeline/isolatedResources';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';

test('single-file environment probes receive their own resources while installer commands receive none', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-resource-'));
    const source = 'from pathlib import Path\nVALUE = Path(__file__).with_name("settings.txt").read_text()\ndef target(): return VALUE\n';
    const file = path.join(root, 'sample.py'); fs.writeFileSync(file, source);
    const plan = createImportFixturePlan(root, [{ file: 'sample.py',
        resourceSourceHash: createHash('sha256').update(source).digest('hex'),
        resources: [{ path: 'settings.txt', kind: 'text', text: 'isolated seed' }] }])!;
    const events: ResourceLifecycle[] = [], context = new ExecutionContext(null);
    const unsubscribe = context.subscribeResourceLifecycle(event => events.push(event));
    try {
        await runInExecution(context, () => withImportFixtures(plan, async () => {
            const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
            const result = await inspectPython({ executable: python }, root, file);
            assert.equal(result?.status, 'ready', JSON.stringify(result));
            assert.deepEqual(events, [{ schemaVersion: 'isolated-resource-lifecycle-v1', planId: plan.id, created: true, cleaned: true }]);
            const env = { ...process.env, [IMPORT_FIXTURE_ENV]: 'inherited fixture', [RESOURCE_LEASE_ENV]: root };
            const installer = await runSetupCommand({ executable: process.execPath, cwd: root, env,
                args: ['-e', `console.log(JSON.stringify({fixture:process.env.${IMPORT_FIXTURE_ENV}||null,lease:process.env.${RESOURCE_LEASE_ENV}||null}))`] });
            assert.equal(installer.code, 0);
            assert.deepEqual(JSON.parse(installer.stdout), { fixture: null, lease: null });
            assert.equal(events.length, 1, 'installer-like commands never create a resource lease');
            assert.equal(setupEnvironment(env)[IMPORT_FIXTURE_ENV], undefined);
            assert.equal(setupEnvironment(env)[RESOURCE_LEASE_ENV], undefined);
        }));
        assert.deepEqual(fs.readdirSync(root), ['sample.py']);
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally { unsubscribe(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('environment resource probes clean leases after setup timeout, AbortSignal and spawn failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-resource-stop-'));
    const source = 'value=1\n'; fs.writeFileSync(path.join(root, 'sample.py'), source);
    const plan = createImportFixturePlan(root, [{ file: 'sample.py', resourceSourceHash: createHash('sha256').update(source).digest('hex'),
        resources: [{ path: 'data', kind: 'directory' }] }])!;
    const resourceModule = require('../pipeline/isolatedResources'), originalCreate = resourceModule.createResourceLease;
    const owned: ResourceLease[] = [];
    resourceModule.createResourceLease = (...args: any[]) => {
        const lease = originalCreate(...args); if (lease) { owned.push(lease); } return lease;
    };
    try {
        await withImportFixtures(plan, async () => {
            const command = { executable: process.execPath, cwd: root, env: process.env,
                resourceScope: 'module-probe' as const, timeoutMs: 100,
                args: ['-e', 'setInterval(()=>{},1000)', pythonToolPath('environment')] };
            assert.equal((await runSetupCommand(command)).code, null);
            assert.equal(owned.at(-1)!.lifecycle.cleaned, true);
            const abort = new AbortController();
            const running = runSetupCommand({ ...command, timeoutMs: 5000, signal: abort.signal });
            abort.abort();
            assert.equal((await running).code, null);
            assert.equal(owned.at(-1)!.lifecycle.cleaned, true);
            await assert.rejects(runSetupCommand({ ...command, executable: path.join(root, 'missing-executable') }), /process-start-failed/);
            assert.equal(owned.at(-1)!.lifecycle.cleaned, true);
            assert.equal(owned.length, 3);
            const before = owned.length;
            await assert.rejects(runSetupCommand({ ...command, signal: abort.signal }), /cancelled/);
            assert.equal(owned.length, before, 'an already-aborted preparation must not create resources');
        });
        assert.ok(owned.every(lease => !fs.existsSync(lease.directory)));
    } finally {
        resourceModule.createResourceLease = originalCreate;
        for (const lease of owned) { await lease.dispose(); }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
