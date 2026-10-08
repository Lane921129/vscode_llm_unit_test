import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { createImportFixturePlan } from '../pipeline/importFixtures';
import { canonicalExternalResourcePath, canonicalUncResourcePath } from '../pipeline/isolatedResources';
import type { ImportCheck, ImportCheckTarget } from '../environment/projectImportCheck';
import type { ImportSetupReason } from '../environment/importSetupSession';
import { getLanguage, setLanguage } from '../i18n/core';
import { withoutUncFileSystem } from './uncPathGuard';

interface SetupSession {
    schemaVersion: string;
    status: string;
    reason: string;
    applied: boolean;
    nextSetupAvailable: boolean;
    checks: Array<{ directory: string; blocked: number; loaded: number }>;
}

test('initialization setup stops after one confirmed recheck and preserves the remaining evidence', async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-recheck-'));
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const Module = require('module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
    let root = '', settings: Record<string, any> = {}, approve = true, confirmations = 0, updates = 0, modelCalls = 0;
    let duringConfirmation: (() => void) | undefined;
    const messages: any[] = [];
    const confirmationMessages: string[] = [];
    const vscode = {
        ConfigurationTarget: { Global: 1 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: {
            get workspaceFolders() { return [{ uri: { fsPath: root } }]; },
            getConfiguration: () => ({
                get: (key: string, fallback: unknown) => settings[key] ?? fallback,
                update: async (key: string, value: unknown) => { updates++; settings[key] = value; }
            }),
            openTextDocument: async (file: string) => { assert.ok(fs.existsSync(file)); return { file }; }
        },
        window: {
            showTextDocument: async () => {}, showInformationMessage: async () => {},
            showWarningMessage: async (_message: string, options?: { modal?: boolean }, action?: string) => {
                if (options?.modal) { confirmationMessages.push(_message); confirmations++; duringConfirmation?.(); return approve ? action : undefined; }
                return undefined;
            }
        }
    };
    Module._load = function(name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    globalThis.fetch = async () => { modelCalls++; throw new Error('Import setup cannot request a model'); };
    try {
        const { ImportSetupController } = require('../environment/importSetupController');
        const { recheckReason, importSetupMessage, saveImportSetupSession } = require('../environment/importSetupSession');
        const createFixture = (name: string, source: string) => {
            const parent = path.join(base, name); root = path.join(parent, 'app');
            fs.mkdirSync(root, { recursive: true });
            const file = path.join(root, 'sample.py'); fs.writeFileSync(file, source);
            fs.writeFileSync(path.join(parent, 'neutral_runtime.py'),
                'from pathlib import Path\ndef launch():\n    Path("must_not_exist").mkdir()\n');
            settings = { pythonPath: python, projectPath: root, importFixtures: [] };
            approve = true; confirmations = 0; updates = 0; messages.length = 0; confirmationMessages.length = 0; duringConfirmation = undefined;
            const output = path.join(parent, 'results');
            const controller = new ImportSetupController((message: unknown) => messages.push(message));
            return { file, source, output, controller };
        };
        const run = async (fixture: ReturnType<typeof createFixture>, targets?: ImportCheckTarget[]) => {
            const before = fs.existsSync(fixture.output) ? fs.readdirSync(fixture.output) : [];
            await fixture.controller.prepare(root, fixture.output, targets);
            const added = fs.readdirSync(fixture.output).filter(file => !before.includes(file));
            assert.equal(added.length, 1, 'one user action owns one terminal session report');
            const directory = path.join(fixture.output, added[0]);
            const session: SetupSession = JSON.parse(fs.readFileSync(path.join(directory, 'import_setup.json'), 'utf8'));
            assert.equal(session.schemaVersion, 'import-setup-session-v1');
            assert.ok(fs.existsSync(path.join(directory, 'import_setup.md')));
            for (const check of session.checks) {
                assert.ok(fs.existsSync(path.join(directory, check.directory, 'import_check.json')));
                assert.ok(fs.existsSync(path.join(directory, check.directory, 'import_check.md')));
            }
            return { directory, session };
        };
        await t.test('parent data initialization is previewed once and one recheck leaves original sibling data untouched', async () => {
            const fixture = createFixture('parent-resource', 'from pathlib import Path\n'
                + 'DATA = Path(__file__).resolve().parent.parent / "VMS_Data"\n'
                + 'DATA.mkdir(parents=True, exist_ok=True)\ndef target(): return DATA.is_dir()\n');
            const original = path.join(path.dirname(root), 'VMS_Data'); fs.mkdirSync(original);
            fs.writeFileSync(path.join(original, 'original.txt'), 'original data');
            const result = await run(fixture);
            assert.equal(confirmations, 1);
            assert.ok(confirmationMessages[0].includes('專案父層資源：../VMS_Data')
                && confirmationMessages[0].includes('不讀取或寫入原位置'));
            assert.equal(updates, 2);
            assert.equal(modelCalls, 0);
            assert.equal(result.session.status, 'ready');
            assert.equal(result.session.reason, 'recheck-ready');
            assert.deepEqual(result.session.checks.map(check => [check.loaded, check.blocked]), [[0, 1], [1, 0]]);
            assert.deepEqual(settings.importFixtures[0].resources,
                [{ path: 'VMS_Data', scope: 'project-parent', kind: 'directory' }]);
            const preview = JSON.parse(fs.readFileSync(path.join(result.directory, '1', 'setup_proposal.json'), 'utf8'));
            assert.equal(preview.evidence[0].resourceScope, 'project-parent');
            assert.equal(preview.evidence[0].resourcePath, 'VMS_Data');
            assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.source);
            assert.deepEqual(fs.readdirSync(original), ['original.txt']);
            assert.equal(fs.readFileSync(path.join(original, 'original.txt'), 'utf8'), 'original data');
            assert.equal(fs.existsSync(path.join(root, 'VMS_Data')), false);
            fixture.controller.dispose();
        });
        for (const { scope, outcome } of (['external-exact', 'unc-virtual'] as const).flatMap(scope =>
            (['confirm', 'decline', 'source-changed', 'cancel'] as const).map(outcome => ({ scope, outcome })))) {
            if (scope === 'unc-virtual' && process.platform !== 'win32') { continue; }
            await t.test(`${scope} initialization requires an unchanged confirmed proposal: ${outcome}`, async () => {
                const external = scope === 'unc-virtual' ? canonicalUncResourcePath('//fixture-host/test-share/' + outcome)
                    : canonicalExternalResourcePath(path.join(base, 'external', outcome));
                const fixture = createFixture(scope + '-' + outcome, 'from pathlib import Path\n'
                    + `DATA = Path(${JSON.stringify(external)})\n`
                    + 'DATA.mkdir(parents=True, exist_ok=True)\ndef target(): return DATA.is_dir()\n');
                const language = getLanguage();
                if (outcome === 'decline') { approve = false; setLanguage('en'); }
                if (outcome === 'source-changed') { duringConfirmation = () => fs.appendFileSync(fixture.file, '# changed after preview\n'); }
                if (outcome === 'cancel') { duringConfirmation = () => fixture.controller.dispose(); }
                try {
                    const result = await withoutUncFileSystem(() => run(fixture));
                    assert.equal(confirmations, 1); assert.equal(updates, outcome === 'confirm' ? 2 : 0);
                    assert.equal(result.session.applied, outcome === 'confirm');
                    assert.equal(result.session.status, { confirm: 'ready', decline: 'blocked', 'source-changed': 'incomplete', cancel: 'cancelled' }[outcome]);
                    assert.equal(result.session.reason, { confirm: 'recheck-ready', decline: 'proposal-declined', 'source-changed': 'error', cancel: 'interrupted' }[outcome]);
                    assert.deepEqual(result.session.checks.map(check => [check.loaded, check.blocked]),
                        outcome === 'confirm' ? [[0, 1], [1, 0]] : [[0, 1]]);
                    assert.ok(confirmationMessages[0].includes(external));
                    assert.ok(confirmationMessages[0].includes(scope === 'unc-virtual'
                        ? outcome === 'decline' ? 'does not grant network access' : '不授予網路存取權限'
                        : outcome === 'decline' ? 'neither read nor written' : '不讀取或寫入原位置'));
                    if (outcome === 'decline') { assert.doesNotMatch(confirmationMessages[0].replaceAll(external, ''), /[\u3400-\u9fff]/); }
                    const preview = JSON.parse(fs.readFileSync(path.join(result.directory, '1', 'setup_proposal.json'), 'utf8'));
                    assert.equal(preview.evidence[0].resourceScope, scope);
                    assert.equal(preview.evidence[0].resourcePath, external);
                    if (outcome === 'confirm') {
                        assert.deepEqual(settings.importFixtures[0].resources, [{ path: external, scope, kind: 'directory' }]);
                    } else { assert.deepEqual(settings.importFixtures, []); assert.equal(fs.existsSync(path.join(result.directory, '2')), false); }
                    if (scope === 'external-exact') { assert.equal(fs.existsSync(external), false, 'even confirmed initialization only creates temporary resources'); }
                    if (outcome !== 'source-changed') { assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.source); }
                } finally { fixture.controller.dispose(); setLanguage(language); }
            });
        }
        await t.test('a second hidden startup call needs a separate manual action, even when the blocked count is unchanged', async () => {
            const fixture = createFixture('successive', 'import neutral_runtime as rt\nrt.launch()\nrt.launch()\ndef target(): return 4\n');
            const first = await run(fixture);
            assert.equal(confirmations, 1, 'a discovered next blocker must not reopen the approval dialog');
            assert.equal(updates, 2);
            assert.equal(first.session.status, 'blocked');
            assert.equal(first.session.reason, 'recheck-new-blockers');
            assert.equal(first.session.applied, true);
            assert.equal(first.session.nextSetupAvailable, true);
            assert.deepEqual(first.session.checks.map(check => [check.loaded, check.blocked]), [[0, 1], [0, 1]]);
            const next = JSON.parse(fs.readFileSync(path.join(first.directory, '2', 'setup_proposal.json'), 'utf8'));
            assert.equal(next.evidence[0].line, 3, 'the newly exposed source location stays available for diagnosis');
            assert.deepEqual(settings.importFixtures[0].entryPointLines, { 'neutral_runtime.launch': [2] });
            const second = await run(fixture);
            assert.equal(confirmations, 2, 'the second manual action can confirm the remaining initialization');
            assert.equal(updates, 4);
            assert.equal(second.session.status, 'ready');
            assert.equal(second.session.reason, 'recheck-ready');
            assert.equal(second.session.nextSetupAvailable, false);
            assert.deepEqual(second.session.checks.map(check => [check.loaded, check.blocked]), [[0, 1], [1, 0]]);
            assert.deepEqual(settings.importFixtures[0].entryPointLines, { 'neutral_runtime.launch': [2, 3] });
            assert.equal(messages.filter(message => message.command === 'environmentPreparationFinished').length, 2);
            assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.source);
            assert.equal(fs.existsSync(path.join(root, 'must_not_exist')), false);

            const check1: ImportCheck = { ...JSON.parse(fs.readFileSync(path.join(first.directory, '1', 'import_check.json'), 'utf8')),
                directory: path.join(first.directory, '1'), proposedRules: [], proposedPlan: null, proposals: [] };
            const unchanged: ImportCheck = { ...check1, directory: path.join(first.directory, 'another-check'),
                rows: structuredClone(check1.rows) };
            assert.equal(recheckReason(check1, unchanged), 'recheck-unchanged', 'a different check directory is not progress');
            const firstWithOutput: ImportCheck = { ...check1, rows: check1.rows.map(row => ({ ...row,
                diagnostic: { exceptionType: 'TraceSafetyError', message: `Blocked write: ${check1.directory}/pending.ini` } })) };
            const nextWithOutput: ImportCheck = { ...unchanged, rows: unchanged.rows.map(row => ({ ...row,
                diagnostic: { exceptionType: 'TraceSafetyError', message: `Blocked write: ${unchanged.directory}/pending.ini` } })) };
            assert.equal(recheckReason(firstWithOutput, nextWithOutput), 'recheck-unchanged',
                'the current output directory in a diagnostic must not turn an unchanged blocker into progress');
            const check2: ImportCheck = { ...check1,
                rows: JSON.parse(fs.readFileSync(path.join(first.directory, '2', 'import_check.json'), 'utf8')).rows };
            assert.equal(recheckReason(check1, check2), 'recheck-new-blockers', 'equal counts do not hide a new source location');
            fixture.controller.dispose();
        });
        await t.test('all terminal summaries and their report keep the chosen language', () => {
            const originalLanguage = getLanguage();
            const directory = path.join(base, 'language'); fs.mkdirSync(directory);
            const check: ImportCheck = { root, python, directory: path.join(directory, '1'),
                rows: [{ file: 'sample.py', status: 'loaded' }], proposedRules: [], proposedPlan: null, proposals: [] };
            const reasons: ImportSetupReason[] = ['initial-check', 'recheck-ready', 'recheck-unchanged',
                'recheck-new-blockers', 'recheck-diagnostic-incomplete', 'configuration-pending', 'proposal-declined', 'no-targets', 'interrupted', 'error'];
            try {
                for (const language of ['en', 'zh-tw']) {
                    setLanguage(language);
                    for (const reason of reasons) {
                        const message = importSetupMessage(reason, check);
                        const report = saveImportSetupSession(directory, [check], false, reason, message);
                        const markdown = fs.readFileSync(report, 'utf8');
                        if (language === 'en') {
                            assert.doesNotMatch(message, /\p{Script=Han}/u, reason);
                            assert.doesNotMatch(markdown, /\p{Script=Han}/u, reason);
                        } else {
                            assert.match(message, /\p{Script=Han}/u, reason);
                            assert.match(markdown, /\p{Script=Han}/u, reason);
                        }
                    }
                }
            } finally { setLanguage(originalLanguage); }
        });
        await t.test('setup invoked from a selected batch keeps that scope instead of scanning unrelated source', async () => {
            const fixture = createFixture('selected', 'def target(): return 4\n');
            fs.writeFileSync(path.join(root, 'unrelated.py'), 'import neutral_runtime as rt\nrt.launch()\ndef target(): return 8\n');
            const result = await run(fixture, [{ file: fixture.file, target: 'target' }]);
            assert.equal(confirmations, 0);
            assert.equal(updates, 0);
            assert.equal(result.session.status, 'ready');
            assert.equal(result.session.reason, 'initial-check');
            assert.deepEqual(result.session.checks.map(check => [check.loaded, check.blocked]), [[1, 0]]);
            const check = JSON.parse(fs.readFileSync(path.join(result.directory, '1', 'import_check.json'), 'utf8'));
            assert.deepEqual(check.rows.map((row: { file: string }) => row.file), ['sample.py']);
            fixture.controller.dispose();
        });
        await t.test('declining initialization retains the blocker and ends without saving or rechecking', async () => {
            const fixture = createFixture('declined', 'import neutral_runtime as rt\nrt.launch()\ndef target(): return 4\n');
            approve = false;
            const result = await run(fixture);
            assert.equal(confirmations, 1);
            assert.equal(updates, 0);
            assert.equal(result.session.status, 'blocked');
            assert.equal(result.session.reason, 'proposal-declined');
            assert.equal(result.session.applied, false);
            assert.deepEqual(result.session.checks.map(check => [check.loaded, check.blocked]), [[0, 1]]);
            assert.equal(messages.filter(message => message.command === 'environmentPreparationFinished').length, 1);
            fixture.controller.dispose();
        });
        await t.test('declining removal of expired approvals cannot report readiness from temporary refreshed settings', async () => {
            const fixture = createFixture('expired-declined', 'import neutral_runtime as rt\nrt.launch()\ndef target(): return 4\n');
            settings.importFixtureRoot = root;
            settings.importFixtures = [{ file: 'sample.py', entryPoints: ['neutral_runtime.launch'],
                entryPointLines: { 'neutral_runtime.launch': [2] },
                entryPointSourceHash: createHash('sha256').update(fixture.source).digest('hex') }];
            const changedSource = 'def target(): return 4\n';
            fs.writeFileSync(fixture.file, changedSource);
            const savedSettings = JSON.stringify(settings);
            assert.throws(() => createImportFixturePlan(root, settings.importFixtures, root), /來源已變更/);
            approve = false;
            const result = await run(fixture);
            assert.equal(confirmations, 1);
            assert.equal(updates, 0);
            assert.equal(result.session.status, 'incomplete',
                'loading with temporary refreshed rules does not make stale persisted rules ready for a real test');
            assert.equal(result.session.reason, 'proposal-declined');
            assert.equal(result.session.applied, false);
            assert.deepEqual(result.session.checks.map(check => [check.loaded, check.blocked]), [[1, 0]]);
            const proposal = JSON.parse(fs.readFileSync(path.join(result.directory, '1', 'setup_proposal.json'), 'utf8'));
            assert.deepEqual(proposal.expiredEntryPointSources, ['sample.py']);
            assert.equal(JSON.stringify(settings), savedSettings, 'declining cleanup must preserve the user settings');
            assert.throws(() => createImportFixturePlan(root, settings.importFixtures, root), /來源已變更/);
            assert.equal(fs.readFileSync(fixture.file, 'utf8'), changedSource);
            fixture.controller.dispose();
        });
        await t.test('cancellation while confirming prevents writes and rechecks even when the dialog returns apply', async () => {
            const fixture = createFixture('cancelled-confirmation', 'import neutral_runtime as rt\nrt.launch()\ndef target(): return 4\n');
            duringConfirmation = () => fixture.controller.dispose();
            const result = await run(fixture);
            assert.equal(confirmations, 1);
            assert.equal(updates, 0);
            assert.equal(result.session.status, 'cancelled');
            assert.equal(result.session.reason, 'interrupted');
            assert.equal(result.session.applied, false);
            assert.equal(result.session.nextSetupAvailable, false);
            assert.deepEqual(result.session.checks.map(check => [check.loaded, check.blocked]), [[0, 1]]);
            assert.deepEqual(settings.importFixtures, []);
            assert.equal(fs.existsSync(path.join(result.directory, '2')), false);
            assert.equal(messages.filter(message => message.command === 'environmentPreparationFinished').length, 1);
            assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.source);
            duringConfirmation = undefined;
        });
        await t.test('an explicitly empty selection is incomplete and never falls back to the whole project', async () => {
            const fixture = createFixture('empty', 'import neutral_runtime as rt\nrt.launch()\ndef target(): return 4\n');
            const result = await run(fixture, []);
            assert.equal(confirmations, 0);
            assert.equal(updates, 0);
            assert.equal(result.session.status, 'incomplete');
            assert.equal(result.session.reason, 'no-targets');
            assert.equal(result.session.applied, false);
            assert.deepEqual(result.session.checks.map(check => [check.loaded, check.blocked]), [[0, 0]]);
            fixture.controller.dispose();
        });
        assert.equal(modelCalls, 0);
    } finally {
        Module._load = originalLoad; globalThis.fetch = originalFetch;
        fs.rmSync(base, { recursive: true, force: true });
    }
});
