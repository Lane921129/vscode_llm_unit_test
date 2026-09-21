import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as setup from '../environment/pythonEnvironmentSetup';

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
                assert.equal(resource.fsPath, file);
                return { get: (key: string, fallback: unknown) => settings.get(key) ?? fallback,
                    update: async (key: string, value: unknown, target: number) => { updates.push({ key, value, target }); settings.set(key, value); } };
            } },
        extensions: { getExtension: () => ({ isActive: true, exports: { environments: {
            getActiveEnvironmentPath: () => ({ path: '/active-environment' }),
            resolveEnvironment: async () => ({ executable: { uri: { fsPath: '/active/python' } } }),
            known: [{ path: '/other', executable: { uri: { fsPath: '/known/python' } } }]
        } } }) },
        window: { showInformationMessage: async () => {}, showWarningMessage: async () => {},
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
