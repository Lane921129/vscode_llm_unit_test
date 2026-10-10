import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { inspectProjectImports, verifyImportProposal } from '../environment/projectImportCheck';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { getLanguage, setLanguage } from '../i18n/core';
import { currentImportFixtures } from '../pipeline/importFixtures';

function fixture(mixedCase = false) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-before-load-'));
    const root = path.join(base, mixedCase ? 'MiXeD' : 'app'); fs.mkdirSync(root);
    const configModule = mixedCase ? 'Config' : 'config';
    const config = path.join(root, configModule + '.py'), file = path.join(root, mixedCase ? 'Sample.py' : 'sample.py');
    fs.writeFileSync(config, 'from pathlib import Path\nDATA = Path(__file__).parent / "owned_data"\nDATA.mkdir(parents=True, exist_ok=True)\n');
    fs.writeFileSync(file, `import ${configModule}\nimport neutral_runtime as rt\ndef ui():\n    return 3\nrt.launch(target=ui)\ndef target():\n    return ${configModule}.DATA.is_dir()\n`);
    fs.writeFileSync(path.join(base, 'neutral_runtime.py'), 'def launch(target):\n    raise RuntimeError("Startup must not execute")\n');
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    return { base, root, config, file, python, targets: [{ file, target: 'target' }] };
}

test('one pre-import plan includes transitive directory and later external startup without loading the app', async () => {
    const f = fixture(), language = getLanguage();
    try {
        setLanguage('en');
        const before = fs.readFileSync(f.file), config = fs.readFileSync(f.config);
        const first = await inspectProjectImports(f.root, f.python, f.targets, path.join(f.base, 'plan'), [], undefined, '', true);
        assert.equal(first.rows[0].stage, 'initialization-plan');
        assert.equal(first.rows[0].diagnostic, undefined, 'static planning must not fabricate a runtime exception');
        assert.deepEqual(first.proposals.map(p => p.kind).sort(), ['entry-point', 'mkdir']);
        assert.ok(first.proposals.every(p => p.evidence === 'static-direct-module-call'));
        assert.equal(first.planningSources?.length, 2, 'dependency without functions belongs to the preview identity');
        assert.equal(fs.existsSync(path.join(f.root, 'owned_data')), false);
        const report = fs.readFileSync(path.join(first.directory, 'import_check.md'), 'utf8');
        assert.match(report, /module loading has not started/);
        assert.doesNotMatch(report, /[\u3400-\u9fff]/);
        const saved = JSON.parse(fs.readFileSync(path.join(first.directory, 'import_check.json'), 'utf8'));
        assert.equal(saved.importsExecuted, false);
        assert.equal(saved.fixtureId, null, 'proposed plan is not an applied fixture');
        assert.doesNotThrow(() => verifyImportProposal(first));
        fs.appendFileSync(f.config, '# changed\n');
        assert.throws(() => verifyImportProposal(first), /來源|changed/i);
        fs.writeFileSync(f.config, config);
        const after = await inspectProjectImports(f.root, f.python, f.targets, path.join(f.base, 'checked'), first.proposedRules, undefined, f.root, true);
        assert.deepEqual(after.rows.map(row => row.status), ['loaded']);
        assert.equal(after.proposedPlan, null);
        assert.equal(after.fixtureId, first.proposedPlan!.id);
        assert.deepEqual(fs.readFileSync(f.file), before);
        assert.deepEqual(fs.readFileSync(f.config), config);
        assert.equal(fs.existsSync(path.join(f.root, 'owned_data')), false);
    } finally { setLanguage(language); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('mixed-case project and module paths retain their real source identity through planning and loading', async () => {
    const f = fixture(true);
    try {
        const identity = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
        const expectedSources = ['Config.py', 'Sample.py'].map(identity).sort();
        const before = [fs.readFileSync(f.config), fs.readFileSync(f.file)];
        const planned = await inspectProjectImports(f.root, f.python, f.targets, path.join(f.base, 'plan'), [], undefined, '', true);
        assert.deepEqual(planned.proposals.map(item => identity(item.file)).sort(), expectedSources);
        assert.doesNotThrow(() => verifyImportProposal(planned));
        const loaded = await inspectProjectImports(f.root, f.python, f.targets, path.join(f.base, 'checked'),
            planned.proposedRules, undefined, f.root, true);
        assert.deepEqual(loaded.rows, [{ file: 'Sample.py', status: 'loaded' }]);
        assert.equal(loaded.fixtureId, planned.proposedPlan!.id);
        assert.deepEqual(loaded.initializationSources?.map(item => identity(item.file)).sort(), expectedSources);
        for (const source of loaded.initializationSources!) {
            assert.equal(source.sourceHash, createHash('sha256').update(fs.readFileSync(path.join(f.root, source.file))).digest('hex'));
        }
        assert.deepEqual([fs.readFileSync(f.config), fs.readFileSync(f.file)], before);
        assert.equal(fs.existsSync(path.join(f.root, 'owned_data')), false);
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('controller confirms a combined static plan once and then performs the actual guarded load', async t => {
    const f = fixture(), settings: Record<string, any> = { pythonPath: f.python, importFixtures: [], importFixtureRoot: f.root };
    const Module = require('module'), original = Module._load;
    let approve = false, approvals = 0, updates = 0;
    let duringApproval: (() => void) | undefined;
    let duringReport: (() => void) | undefined;
    const previews: any[] = [];
    const vscode = {
        ConfigurationTarget: { Global: 1 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: f.root } }], getConfiguration: () => ({
            get: (key: string, fallback: unknown) => settings[key] ?? fallback,
            update: async (key: string, value: unknown) => { updates++; settings[key] = value; }
        }), openTextDocument: async (file: string) => {
            if (path.basename(file) === 'setup_proposal.json') { previews.push(JSON.parse(fs.readFileSync(file, 'utf8'))); }
            return { file };
        } },
        window: { showTextDocument: async (document: { file: string }) => {
            if (path.basename(document.file) === 'import_setup.md') { duringReport?.(); }
        }, showInformationMessage: async () => {},
            showWarningMessage: async (_message: string, _options: unknown, action: string) => {
                if (action) { approvals++; duringApproval?.(); }
                return approve ? action : undefined;
            } }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
    try {
        const { ImportSetupController } = require('../environment/importSetupController');
        const controller = new ImportSetupController(() => {});
        const declined = await controller.prepare(f.root, path.join(f.base, 'results'), f.targets);
        assert.equal(declined.status, 'declined');
        assert.equal(updates, 0);
        assert.equal(approvals, 1);
        assert.equal(previews[0].evidence.length, 2);
        approve = true; approvals = 0;
        const ready = await controller.prepare(f.root, path.join(f.base, 'results'), f.targets);
        assert.equal(ready.status, 'ready');
        assert.equal(ready.reason, 'recheck-ready');
        assert.equal(approvals, 1, 'one confirmation, with no repeated initialization prompt');
        assert.equal(updates, 2);
        assert.equal(fs.existsSync(path.join(ready.directory, '3')), false);
        assert.equal(fs.existsSync(path.join(f.root, 'owned_data')), false);

        await t.test('one guarded observation combines a dynamic helper directory with the later callback before approval', async () => {
            const language = getLanguage();
            const runner = require('../utils/processRunner'), originalRunSpawn = runner.runSpawn;
            const observations: Array<{ approved: boolean; fixtureId: string | null }> = [];
            let confirmationReturned = false;
            const originalDirectory = path.join(f.root, 'owned_data');
            fs.mkdirSync(originalDirectory);
            const marker = path.join(originalDirectory, 'original-only.txt');
            fs.writeFileSync(marker, 'original resource must remain untouched');
            const configSource = 'from pathlib import Path\ndef app_directory():\n    return Path(__file__).parent\n'
                + 'DATA = app_directory() / "owned_data"\nDATA.mkdir(parents=True, exist_ok=True)\n'
                + 'if (DATA / "original-only.txt").exists():\n    raise RuntimeError("original resource was exposed")\n';
            const source = 'import config\nimport neutral_runtime as rt\ndef ui():\n'
                + '    raise RuntimeError("callback must not execute")\nrt.launch(target=ui)\n'
                + 'def target():\n    return config.DATA.is_dir()\n';
            fs.writeFileSync(f.config, configSource); fs.writeFileSync(f.file, source);
            settings.importFixtures = []; approvals = updates = 0; previews.length = 0;
            runner.runSpawn = async (command: string, args: string[], ...rest: any[]) => {
                if (args.some(arg => path.basename(arg) === 'module_preflight.py')) {
                    observations.push({ approved: confirmationReturned, fixtureId: currentImportFixtures()?.id || null });
                }
                return originalRunSpawn(command, args, ...rest);
            };
            duringApproval = () => {
                assert.equal(approvals, 1);
                assert.deepEqual(observations, [{ approved: false, fixtureId: null }],
                    'one guarded observation uses only the previously approved plan, before new settings are confirmed');
                assert.equal(updates, 0);
                assert.equal(previews.length, 1, 'directory and callback share one preview');
                assert.deepEqual(previews[0].evidence.map((item: any) => [item.kind, item.evidence]).sort(), [
                    ['entry-point', 'static-direct-module-call'], ['mkdir', 'blocked-direct-module-call']
                ]);
                assert.deepEqual(previews[0].planningSources.map((item: any) => item.file).sort(), ['config.py', 'sample.py']);
                assert.equal(fs.readFileSync(marker, 'utf8'), 'original resource must remain untouched');
                confirmationReturned = true;
            };
            try {
                setLanguage('en');
                const combined = await controller.prepare(f.root, path.join(f.base, 'results'), f.targets);
                assert.equal(combined.status, 'ready'); assert.equal(combined.reason, 'recheck-ready');
                assert.equal(approvals, 1); assert.equal(updates, 2);
                assert.deepEqual(observations, [
                    { approved: false, fixtureId: null }, { approved: true, fixtureId: combined.fixtureId }
                ], 'confirmation permits exactly one new guarded load');
                assert.ok(combined.fixtureId);
                assert.deepEqual(combined.rows, [{ file: 'sample.py', status: 'loaded' }]);
                const read = (name: string) => JSON.parse(fs.readFileSync(path.join(combined.directory, name), 'utf8'));
                const plan = read('1/initialization_plan.json'), preview = read('1/import_check.json');
                assert.equal(plan.guardedObservation, true);
                assert.ok(plan.diagnostics.some((item: any) => item.reason === 'dynamic-directory'));
                assert.equal(preview.phase, 'planning'); assert.equal(preview.importsExecuted, true);
                assert.equal(preview.observationReport, 'observed_import_check.json');
                const observed = read('1/observed_import_check.json');
                assert.equal(observed.rows[0].status, 'blocked'); assert.equal(observed.rows[0].stage, 'module-import');
                assert.equal(observed.rows[0].suggestion.kind, 'mkdir');
                assert.equal(observed.rows[0].suggestion.resourcePath, 'owned_data');
                const session = read('import_setup.json');
                assert.deepEqual(session.checks, [
                    { directory: '1', phase: 'planning', planned: 1, blocked: 0, loaded: 0 },
                    { directory: '2', blocked: 0, loaded: 1 }
                ]);
                assert.deepEqual(session.comparisons[0].rows, [{ file: 'sample.py', change: 'loaded' }]);
                const planningReport = fs.readFileSync(path.join(combined.directory, '1/import_check.md'), 'utf8');
                assert.match(planningReport, /One guarded diagnostic has completed/);
                assert.doesNotMatch(planningReport, /module loading has not started|[\u3400-\u9fff]/);
                const sessionReport = fs.readFileSync(path.join(combined.directory, 'import_setup.md'), 'utf8');
                assert.match(sessionReport, /Planning 1: 1 modules await initialization approval/);
                assert.doesNotMatch(sessionReport, /[\u3400-\u9fff]/);
                assert.equal(fs.existsSync(path.join(combined.directory, '3')), false);
                assert.deepEqual(fs.readdirSync(originalDirectory), ['original-only.txt']);
                assert.equal(fs.readFileSync(marker, 'utf8'), 'original resource must remain untouched');
                assert.equal(fs.readFileSync(f.config, 'utf8'), configSource);
                assert.equal(fs.readFileSync(f.file, 'utf8'), source);
            } finally {
                duringApproval = undefined; runner.runSpawn = originalRunSpawn; setLanguage(language);
            }
        });

        await t.test('a no-proposal dependency changed while the ready report is open invalidates the approved rescan', async () => {
            const helper = path.join(f.root, 'helper.py');
            fs.writeFileSync(helper, 'VALUE = 1\n');
            fs.writeFileSync(f.config, 'import helper\n' + fs.readFileSync(f.config, 'utf8'));
            settings.importFixtures = []; approvals = updates = 0; previews.length = 0;
            let reportOpened = 0;
            duringReport = () => {
                reportOpened++;
                assert.equal(approvals, 1); assert.equal(updates, 2);
                assert.ok(previews[0].planningSources.some((item: any) => item.file === 'helper.py'));
                assert.ok(!previews[0].evidence.some((item: any) => item.file === 'helper.py'),
                    'the changed helper has no initialization candidate or fixture rule');
                fs.appendFileSync(helper, 'VALUE = 2\n');
            };
            try {
                const changed = await controller.prepare(f.root, path.join(f.base, 'results'), f.targets);
                assert.equal(reportOpened, 1);
                assert.equal(changed.status, 'failed'); assert.equal(changed.reason, 'error');
                assert.equal(changed.applied, true, 'the first approval succeeded before the unrelated source drift');
                assert.equal(approvals, 1); assert.equal(updates, 2);
                const session = JSON.parse(fs.readFileSync(path.join(changed.directory, 'import_setup.json'), 'utf8'));
                assert.equal(session.status, 'incomplete'); assert.equal(session.reason, 'error');
                assert.equal(session.checks.length, 2, 'the final source check must not start another import or approval');
                assert.deepEqual(fs.readdirSync(path.join(f.root, 'owned_data')), ['original-only.txt']);
            } finally { duringReport = undefined; }
        });
        controller.dispose();
    } finally { Module._load = original; fs.rmSync(f.base, { recursive: true, force: true }); }
});
