import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createImportFixturePlan, ImportFixtureRule } from '../pipeline/importFixtures';
import { ExecutionContext, runInExecution } from '../pipeline/executionContext';
import type { ImportCheck, ImportCheckTarget } from '../environment/projectImportCheck';
import type { ImportSetupResult } from '../environment/importSetupController';

test('setup results require completed matching checks and propagate batch cancellation', async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-result-'));
    const root = path.join(base, 'app'); fs.mkdirSync(root);
    const file = path.join(root, 'sample.py'), secondFile = path.join(root, 'second.py');
    const source = 'def target(value): return value + 1\n';
    fs.writeFileSync(file, source); fs.writeFileSync(secondFile, source);
    const targets = [{ file, target: 'target' }, { file: secondFile, target: 'target' }];
    const Module = require('module'), originalLoad = Module._load;
    let settings: Record<string, any> = {}, trusted = true, scans = 0, updates = 0, confirmations = 0;
    let duringScan: ((check: ImportCheck) => void) | undefined;
    let duringReport: (() => void) | undefined;
    let duringConfirmation: (() => void) | undefined;
    let propose = false, approve = true;
    const vscode = {
        ConfigurationTarget: { Global: 1 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: {
            get isTrusted() { return trusted; },
            getConfiguration: () => ({
                get: (key: string, fallback: unknown) => settings[key] ?? fallback,
                update: async (key: string, value: unknown) => { updates++; settings[key] = value; }
            }),
            openTextDocument: async (file: string) => ({ file })
        },
        window: {
            showTextDocument: async (document: { file: string }) => {
                if (path.basename(document.file) === 'import_setup.md') { duringReport?.(); }
            },
            showInformationMessage: async () => {},
            showWarningMessage: async (_message: string, options?: { modal?: boolean }, action?: string) => {
                if (options?.modal) { confirmations++; duringConfirmation?.(); return approve ? action : undefined; }
                return undefined;
            }
        }
    };
    const checks = {
        inspectProjectImports: async (scanRoot: string, python: string, selected: ImportCheckTarget[], directory: string,
            rules: ImportFixtureRule[], _log: unknown, boundRoot: string) => {
            scans++;
            const check: ImportCheck = { root: fs.realpathSync(scanRoot), python, directory,
                fixtureId: createImportFixturePlan(scanRoot, rules, boundRoot)?.id || null,
                rows: [...new Set(selected.map(target => target.file))].map(file => ({
                    file: path.relative(scanRoot, file).replace(/\\/g, '/'), status: 'loaded' })),
                proposedRules: structuredClone(rules), proposedPlan: null, proposals: [] };
            if (propose && scans === 1) {
                check.proposedRules = [{ file: 'sample.py', mkdir: true }];
                check.proposedPlan = createImportFixturePlan(scanRoot, check.proposedRules);
            }
            fs.mkdirSync(directory, { recursive: true });
            duringScan?.(check);
            return check;
        },
        verifyImportProposal: (check: ImportCheck) => {
            assert.equal(createImportFixturePlan(check.root, check.proposedRules)?.id, check.proposedPlan?.id);
        }
    };
    Module._load = function(name: string, ...args: any[]) {
        if (name === 'vscode') { return vscode; }
        if (name === './projectImportCheck' && args[0]?.filename.endsWith(path.join('environment', 'importSetupController.js'))) { return checks; }
        return originalLoad.call(this, name, ...args);
    };
    try {
        const { ImportSetupController } = require('../environment/importSetupController');
        const { pythonEnvironmentActivity } = require('../environment/pythonEnvironmentSetup');
        const reset = () => {
            settings = { pythonPath: 'fixture-python', projectPath: root, importFixtures: [] };
            trusted = true; scans = 0; updates = 0; confirmations = 0; propose = false; approve = true;
            duringScan = undefined; duringReport = undefined; duringConfirmation = undefined;
            fs.writeFileSync(file, source);
            return new ImportSetupController(() => {});
        };
        const run = (controller: InstanceType<typeof ImportSetupController>, selected = targets): Promise<ImportSetupResult> =>
            controller.prepare(root, path.join(base, 'results'), selected);
        const reportStatus = (result: ImportSetupResult) => JSON.parse(fs.readFileSync(path.join(result.directory!, 'import_setup.json'), 'utf8')).status;

        await t.test('preconditions return distinct outcomes without scanning', async () => {
            const controller = reset();
            trusted = false; assert.equal((await run(controller)).status, 'untrusted');
            trusted = true; assert.equal((await controller.prepare(file)).status, 'invalid-root');
            const release = pythonEnvironmentActivity.acquire('use');
            assert.ok(release);
            try { assert.equal((await run(controller)).status, 'busy'); } finally { release(); }
            assert.equal(scans, 0); assert.equal(updates, 0);
        });
        await t.test('ready reports the actual final plan and exact selected targets', async () => {
            const controller = reset();
            settings.importFixtures = [{ file: 'sample.py', mkdir: true }]; settings.importFixtureRoot = root;
            const result = await run(controller);
            assert.equal(result.status, 'ready'); assert.equal(result.python, 'fixture-python');
            assert.equal(result.fixtureId, createImportFixturePlan(root, settings.importFixtures, root)!.id);
            assert.deepEqual(result.targets, targets.map(target => ({ ...target, file: fs.realpathSync(target.file) })));
            assert.deepEqual(result.rows, [{ file: 'sample.py', status: 'loaded' }, { file: 'second.py', status: 'loaded' }]);
            assert.equal(reportStatus(result), 'ready'); assert.equal(scans, 1); assert.equal(updates, 0);
        });
        await t.test('blocked and zero-target results cannot authorize continuation', async () => {
            let controller = reset(); duringScan = check => { check.rows[0].status = 'blocked'; };
            assert.equal((await run(controller)).status, 'blocked');
            controller = reset();
            const empty = await run(controller, []);
            assert.equal(empty.status, 'no-targets'); assert.deepEqual(empty.targets, []); assert.deepEqual(empty.rows, []);
        });
        for (const mismatch of ['missing', 'duplicate', 'extra', 'root', 'python', 'fixture'] as const) {
            await t.test(`a completed but ${mismatch} check is not ready`, async () => {
                const controller = reset();
                duringScan = check => {
                    if (mismatch === 'missing') { check.rows.pop(); }
                    if (mismatch === 'duplicate') { check.rows[1] = { ...check.rows[0] }; }
                    if (mismatch === 'extra') { check.rows.push({ file: 'unselected.py', status: 'loaded' }); }
                    if (mismatch === 'root') { check.root = base; }
                    if (mismatch === 'python') { check.python = 'other-python'; }
                    if (mismatch === 'fixture') { check.fixtureId = 'different-actual-plan'; }
                };
                const result = await run(controller);
                assert.equal(result.status, 'failed'); assert.equal(reportStatus(result), 'incomplete');
                assert.equal(scans, 1); assert.equal(updates, 0);
            });
        }
        for (const phase of ['scan', 'report'] as const) {
            for (const change of ['source', 'settings', 'python'] as const) {
                await t.test(`${change} changed during ${phase} prevents ready handoff`, async () => {
                    const controller = reset();
                    const mutate = () => {
                        if (change === 'source') { fs.appendFileSync(file, '# changed\n'); }
                        if (change === 'settings') { settings.importFixtures = [{ file: 'sample.py', mkdir: true }]; }
                        if (change === 'python') { settings.pythonPath = 'changed-python'; }
                    };
                    if (phase === 'scan') { duringScan = mutate; } else { duringReport = mutate; }
                    const result = await run(controller);
                    assert.equal(result.status, 'failed'); assert.equal(reportStatus(result), 'incomplete');
                    assert.equal(result.fixtureId, null, 'a later settings change is not the actually scanned fixture plan');
                    assert.equal(scans, 1); assert.equal(updates, 0);
                });
            }
        }
        await t.test('failed recheck never adopts a previously loaded preview', async () => {
            const controller = reset(); propose = true;
            duringScan = () => { if (scans === 2) { throw new Error('fixture check unavailable'); } };
            const result = await run(controller);
            assert.equal(result.status, 'failed'); assert.equal(result.applied, true); assert.equal(result.fixtureId, null);
            assert.equal(reportStatus(result), 'incomplete'); assert.equal(scans, 2); assert.equal(confirmations, 1);
        });
        await t.test('declined loaded preview remains declined and does not adopt proposed plan', async () => {
            const controller = reset(); propose = true; approve = false;
            const result = await run(controller);
            assert.equal(result.status, 'declined'); assert.equal(result.fixtureId, null); assert.equal(result.applied, false);
            assert.equal(reportStatus(result), 'incomplete'); assert.equal(scans, 1); assert.equal(updates, 0);
        });
        for (const phase of ['before', 'confirmation', 'report'] as const) {
            await t.test(`parent cancellation during ${phase} cancels setup and releases its activity lock`, async () => {
                const controller = reset(), parent = new ExecutionContext({});
                if (phase === 'before') { parent.cancel(); }
                if (phase === 'confirmation') { propose = true; duringConfirmation = () => parent.cancel(); }
                if (phase === 'report') { duringReport = () => parent.cancel(); }
                const result = await runInExecution(parent, () => run(controller));
                assert.equal(result.status, 'cancelled'); assert.equal(reportStatus(result), 'cancelled');
                assert.equal(scans, phase === 'before' ? 0 : 1); assert.equal(updates, 0);
                const release = pythonEnvironmentActivity.acquire('use'); assert.ok(release); release();
            });
        }
    } finally {
        Module._load = originalLoad;
        fs.rmSync(base, { recursive: true, force: true });
    }
});
