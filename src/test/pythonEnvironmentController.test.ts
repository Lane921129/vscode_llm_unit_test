import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as setup from '../environment/pythonEnvironmentSetup';
import { createPythonInstallationPlan } from '../environment/pythonInstallationPlan';

test('environment preparation uses the target workspace setting, remembers selections and preserves configuration on failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-controller-'));
    const file = path.join(root, 'sample.py'); fs.writeFileSync(file, 'def target():\n    return 1\n');
    const originalLoad = require('module')._load;
    const setupModule = require('../environment/pythonEnvironmentSetup');
    const originalPrepare = setupModule.preparePythonEnvironment;
    const states = new Map<string, unknown>();
    const settings = new Map<string, unknown>([['pythonPath', '/old/python']]);
    const updates: any[] = [], messages: any[] = [], dialogs: any[] = [];
    const folder = { uri: { fsPath: root } };
    let cancelPicker = false, fail = false, cancel = false;
    let prepared: any;
    const vscode = {
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        ProgressLocation: { Notification: 15 }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: '/unrelated-first-workspace' } }, folder],
            getWorkspaceFolder: (resource: any) => resource.fsPath.startsWith(root) ? folder : undefined,
            getConfiguration: (_section: string, resource: any) => {
                if (resource) { assert.equal(resource.fsPath, file); }
                return { get: (key: string, fallback: unknown) => settings.get(key) ?? fallback,
                    update: async (key: string, value: unknown, target: number) => { updates.push({ key, value, target }); settings.set(key, value); } };
            } },
        extensions: { getExtension: () => ({ isActive: true, exports: { environments: {
            getActiveEnvironmentPath: () => ({ path: '/active-environment' }),
            resolveEnvironment: async () => ({ executable: { uri: { fsPath: '/active/python' } } }),
            known: [{ path: '/other', executable: { uri: { fsPath: '/known/python' } } }]
        } } }) },
        window: { showInformationMessage: async () => {}, showWarningMessage: async () => {},
            showQuickPick: async (items: any[]) => items.find(item => item.scope === 'file'),
            showOpenDialog: async (options: unknown) => { dialogs.push(options); return cancelPicker ? undefined : [{ fsPath: file }]; },
            withProgress: async (_options: unknown, action: any) => action({ report: () => {} },
                { isCancellationRequested: cancel, onCancellationRequested: () => ({ dispose() {} }) }) }
    };
    require('module')._load = function (name: string, ...args: unknown[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    try {
        delete require.cache[require.resolve('../environment/pythonEnvironmentController')];
        const { PythonEnvironmentController, configuredPythonForResource, discoverPythonCandidates } = require('../environment/pythonEnvironmentController');
        const candidates = await discoverPythonCandidates({ fsPath: file }, root);
        assert.deepEqual(candidates.map((value: any) => value.executable), ['/old/python']);
        settings.delete('pythonPath');
        const workspacePython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        fs.mkdirSync(path.dirname(workspacePython), { recursive: true });
        fs.writeFileSync(workspacePython, '');
        const automatic = await discoverPythonCandidates({ fsPath: file }, root);
        assert.equal(automatic[0].executable, workspacePython);
        assert.equal(configuredPythonForResource(file, root), workspacePython);
        assert.ok(automatic.some((candidate: any) => candidate.executable === '/active/python'));
        settings.set('pythonPath', '/old/python');
        setupModule.preparePythonEnvironment = async (options: any) => {
            prepared = options;
            if (fail || options.signal.aborted) { throw new setup.EnvironmentSetupError('install', 'controlled failure'); }
            return { python: '/verified/python', installed: [], requirements: undefined };
        };
        const state = { get: (key: string) => states.get(key), update: async (key: string, value: unknown) => { states.set(key, value); } };
        const controller = new PythonEnvironmentController(state, (message: unknown) => messages.push(message));
        await controller.prepare();
        assert.equal(prepared.projectRoot, root);
        assert.equal(prepared.file, file);
        assert.equal(await prepared.packageName('undeclared_project_helper'), undefined);
        settings.set('packageMappings', { neutral_import: 'neutral-distribution' });
        assert.equal(await prepared.packageName('neutral_import'), 'neutral-distribution');
        assert.equal(await prepared.packageName('toString'), undefined);
        assert.deepEqual(updates, [{ key: 'pythonPath', value: '/verified/python', target: 3 }]);
        assert.equal(configuredPythonForResource(file), '/verified/python');
        assert.equal(states.get('llmUnitTest.lastEnvironmentFile.v1'), file);
        assert.ok(messages.some(value => value.command === 'environmentPreparation' && value.text.includes('檢查通過')));
        fail = true;
        await new PythonEnvironmentController(state, (message: unknown) => messages.push(message)).prepare();
        assert.equal(dialogs.at(-1).defaultUri.fsPath, file);
        assert.equal(updates.length, 1);
        assert.equal(messages.at(-1).command, 'environmentPreparationFinished');
        assert.ok(messages.some(value => value.text?.includes('controlled failure')));
        fail = false; cancel = true;
        await controller.prepare(file, root);
        assert.equal(updates.length, 1);
        cancelPicker = true; cancel = false;
        await controller.prepare();
        assert.equal(updates.length, 1);
        assert.equal(states.get('llmUnitTest.lastEnvironmentFile.v1'), file);
        const release = setup.pythonEnvironmentActivity.acquire('setup'); assert.ok(release); release();
    } finally {
        setupModule.preparePythonEnvironment = originalPrepare;
        require('module')._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('project and folder scopes retain separate history, publish full diagnostics on failure and never save failed environments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-scope-'));
    const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
    const other = path.join(root, 'other'); fs.mkdirSync(other);
    const originalLoad = require('module')._load;
    const setupModule = require('../environment/pythonEnvironmentSetup');
    const originalPrepare = setupModule.preparePythonEnvironment;
    const states = new Map<string, unknown>();
    const dialogs: any[] = [], choices: any[] = [], calls: any[] = [], reports: string[] = [], updates: any[] = [];
    let scope: string | undefined = 'project', folderChoice: string | undefined = nested, failed = false;
    let selectedProject: string | undefined = root;
    let previewModule: any, originalPreview: any;
    const vscode = {
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }, ProgressLocation: { Notification: 15 },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }, { uri: { fsPath: other } }],
            getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'pythonPath' ? '/selected/python'
                : key === 'outputPath' ? 'results' : fallback,
            update: async (...args: any[]) => { updates.push(args); } }),
            openTextDocument: async (options: any) => { reports.push(options.content); return options; } },
        // VS Code notification promises can remain pending until the user dismisses them.
        window: { showInformationMessage: () => new Promise(() => {}), showWarningMessage: () => new Promise(() => {}), showTextDocument: async () => {},
            showQuickPick: async (items: any[]) => { choices.push(items); return items[0].scope
                ? items.find(item => item.scope === scope) : items.find(item => item.description === selectedProject); },
            showOpenDialog: async (options: any) => { dialogs.push(options); return folderChoice ? [{ fsPath: folderChoice }] : undefined; },
            withProgress: async (_options: unknown, action: any) => action({ report: () => {} },
                { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }) }
    };
    require('module')._load = function (name: string, ...args: unknown[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    try {
        delete require.cache[require.resolve('../environment/pythonEnvironmentController')];
        const { PythonEnvironmentController } = require('../environment/pythonEnvironmentController');
        previewModule = require('../environment/pythonInstallationPreview');
        originalPreview = previewModule.confirmPythonInstallation;
        setupModule.preparePythonEnvironment = async (options: any) => {
            calls.push(options);
            const inventory = { schemaVersion: 'dependency-inventory-v1', filesScanned: 2, excludedDirectories: 1,
                complete: true, dynamicImports: 0, imports: [], issues: [], missing: ['neutral_missing'], optionalMissing: [] };
            options.inventory(inventory);
            if (failed) { throw new setup.EnvironmentSetupError('dependency', 'controlled failure'); }
            inventory.missing = []; options.inventory(inventory);
            return { python: '/selected/python', installed: [], inventory };
        };
        const state = { get: (key: string) => states.get(key), update: async (key: string, value: unknown) => { states.set(key, value); } };
        const controller = new PythonEnvironmentController(state, () => {});
        await controller.prepare(path.join(root, 'selected.py'), root);
        assert.equal(calls[0].file, root); assert.equal(calls[0].scope, 'folder');
        assert.deepEqual(calls[0].excludedPaths, [path.join(root, 'results')]);
        assert.equal(dialogs.length, 0); assert.equal(updates.length, 1);
        assert.match(reports[0], /首次缺少：neutral_missing/); assert.match(reports[0], /目前必要套件缺少：無/);
        assert.equal(states.get('llmUnitTest.lastEnvironmentProject.v1'), root);
        scope = 'folder'; await controller.prepare(undefined, root);
        assert.equal(calls[1].file, nested); assert.equal(calls[1].projectRoot, root);
        assert.equal(dialogs.at(-1).canSelectFolders, true); assert.equal(dialogs.at(-1).canSelectFiles, false);
        assert.equal(states.get('llmUnitTest.lastEnvironmentFolder.v1'), nested);
        failed = true;
        await new PythonEnvironmentController(state, () => {}).prepare(undefined, root);
        assert.equal(dialogs.at(-1).defaultUri.fsPath, nested);
        assert.equal(choices.at(-1)[0].scope, 'folder');
        assert.equal(updates.length, 2); assert.match(reports.at(-1)!, /controlled failure/);
        const priorCalls = calls.length;
        folderChoice = undefined; await controller.prepare(undefined, root);
        scope = undefined; await controller.prepare(undefined, root);
        assert.equal(calls.length, priorCalls); assert.equal(states.get('llmUnitTest.lastEnvironmentFolder.v1'), nested);
        scope = 'project'; failed = false;
        selectedProject = other; await controller.prepare();
        assert.equal(calls.at(-1).file, other); assert.equal(calls.at(-1).projectRoot, other);
        selectedProject = undefined; await controller.prepare();
        assert.equal(choices.at(-1)[0].description, other);
        assert.equal(calls.length, priorCalls + 1);
        const tools = path.join(root, 'tools.txt'); fs.writeFileSync(tools, 'coverage>=7\n');
        let previewed = false;
        previewModule.confirmPythonInstallation = async (plan: any, signal: AbortSignal) => {
            previewed = true; assert.equal(plan.python, '/selected/python'); assert.equal(signal.aborted, false); return false;
        };
        setupModule.preparePythonEnvironment = async (options: any) => {
            const plan = await createPythonInstallationPlan({ python: '/selected/python', virtual: false,
                target: root, projectRoot: root, missing: [], toolRequirements: tools, needsTools: true, previouslyInstalled: [] });
            assert.equal(await options.confirmInstall(plan), false);
            throw new setup.EnvironmentSetupError('install-plan', '未確認安裝清單，本次未安裝任何套件。');
        };
        const saved = updates.length;
        await controller.prepare(undefined, root);
        assert.equal(previewed, true); assert.equal(updates.length, saved);
        assert.match(reports.at(-1)!, /Python 安裝清單/); assert.match(reports.at(-1)!, /未確認.*取消/);
        assert.match(reports.at(-1)!, /coverage/);
        const release = setup.pythonEnvironmentActivity.acquire('setup'); assert.ok(release); release();
    } finally {
        setupModule.preparePythonEnvironment = originalPrepare;
        if (previewModule) { previewModule.confirmPythonInstallation = originalPreview; }
        require('module')._load = originalLoad;
        delete require.cache[require.resolve('../environment/pythonEnvironmentController')];
        fs.rmSync(root, { recursive: true, force: true });
    }
});
