import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { getWebviewContent } from '../ui/webviewContent';
import { setLanguage, t } from '../i18n/core';
import { normalizeExecutionSettings, DEFAULT_MAX_LOOPS, DEFAULT_MUTATION_TIMEOUT_SECONDS } from '../pipeline/executionSettings';

test('all folder pickers restore independent selections after provider recreation and cancellation preserves history', async () => {
    const Module = require('module');
    const originalLoad = Module._load;
    const stored = new Map<string, unknown>();
    const settings = new Map<string, unknown>([['projectPath', '/old-project'], ['outputPath', '/old-output']]);
    const settingScopes = new Map<string, 'workspaceValue' | 'workspaceFolderValue'>();
    const settingUpdates: Array<{ key: string; value: unknown; target: unknown }> = [];
    const dialogs: any[] = [], executed: any[] = [];
    const choices: Array<Array<{ fsPath: string }> | undefined> = [];
    const state = { get: (key: string) => stored.get(key), update: async (key: string, value: unknown) => { stored.set(key, value); } };
    const vscode = {
        commands: { executeCommand: async (...args: any[]) => { executed.push(args); } },
        workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings.get(key) ?? fallback,
            inspect: (key: string) => settingScopes.has(key) ? { [settingScopes.get(key)!]: settings.get(key) } : {},
            update: async (key: string, value: unknown, target: unknown) => { settings.set(key, value); settingUpdates.push({ key, value, target }); } }) },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        env: { language: 'zh-tw' }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: { showOpenDialog: async (options: unknown) => { dialogs.push(options); return choices.shift(); },
            showInformationMessage: () => {}, showWarningMessage: () => {} }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    try {
        const { MutationViewProvider } = require('../ui/SidebarProvider');
        const attach = () => {
            const provider = new MutationViewProvider({ get: async () => undefined }, state);
            const messages: any[] = [];
            const scans: string[] = [];
            let receive!: (message: unknown) => Promise<void>;
            provider.findPythonFiles = async (folder: string) => { scans.push(folder); return []; };
            provider.fetchLocalModels = async () => [];
            const webview = { options: {}, html: '',
                postMessage: (message: unknown) => { messages.push(message); },
                onDidReceiveMessage: (handler: typeof receive) => { receive = handler; } };
            provider.resolveWebviewView({ webview });
            return { receive, messages, scans, provider, webview };
        };
        let view = attach();
        await view.receive({ command: 'prepareProjectEnvironment', projectRoot: '/selected-project', filePath: '/stale.py' });
        assert.deepEqual(executed.at(-1), ['llm-unit-test.preparePythonEnvironment', { filePath: '/selected-project', projectRoot: '/selected-project' }]);
        await view.receive({ command: 'preparePythonEnvironment', projectRoot: '/selected-project', filePath: '/selected-project/module.py' });
        assert.deepEqual(executed.at(-1), ['llm-unit-test.preparePythonEnvironment', { filePath: '/selected-project/module.py', projectRoot: '/selected-project' }]);
        await view.receive({ command: 'getInitialData' });
        assert.equal(view.messages.find(item => item.command === 'setProjectPath').path, '/old-project');
        assert.equal(view.messages.find(item => item.command === 'setOutputPath').path, '/old-output');
        const commands = [
            ['browseProjectFolder', 'project', '/projects/new'],
            ['browseFolder', 'output', '/results/new'],
            ['browseBatchFolder', 'batch', '/batches/new']
        ];
        for (const [command, kind, folder] of commands) {
            choices.push([{ fsPath: folder }]);
            await view.receive({ command });
            assert.equal(stored.get(`llmUnitTest.lastFolders.v1.${kind}`), folder);
        }
        assert.equal(dialogs[0].defaultUri.fsPath, '/old-project');
        assert.equal(dialogs[1].defaultUri.fsPath, '/old-output');
        assert.equal(dialogs[2].defaultUri.fsPath, '/projects/new');
        // A workspace setting can shadow global configuration; explicit picker
        // history must still recover the last actual choice.
        settings.set('projectPath', '/shadowed-project');
        settings.set('outputPath', '/shadowed-output');
        view = attach();
        await view.receive({ command: 'getInitialData' });
        for (const [command, expected] of [['setProjectPath', '/projects/new'], ['setOutputPath', '/results/new'], ['setBatchPath', '/batches/new']]) {
            assert.equal(view.messages.find(item => item.command === command).path, expected);
        }
        assert.equal(view.scans[0], '/projects/new');
        assert.ok(view.messages.findIndex(item => item.command === 'setBatchPath') < view.messages.findIndex(item => item.command === 'setProjectPath'));
        const previous = new Map(stored);
        for (const [command, , folder] of commands) {
            choices.push(undefined);
            await view.receive({ command });
            assert.equal(dialogs.at(-1).defaultUri.fsPath, folder);
            assert.deepEqual(stored, previous);
        }
        await view.receive({ command: 'setLanguage', lang: 'en' });
        await view.receive({ command: 'setPromptStrategy', strategy: 'small' });
        await view.receive({ command: 'getInitialData' });
        assert.deepEqual(stored, previous);
        choices.push([{ fsPath: '/projects/another' }]);
        await view.receive({ command: 'browseProjectFolder' });
        assert.equal(stored.get('llmUnitTest.lastFolders.v1.batch'), '/batches/new');
        assert.equal(stored.get('llmUnitTest.lastFolders.v1.output'), '/results/new');

        await view.receive({ command: 'setMutationEngine', engine: 'mutatest' });
        assert.deepEqual(settingUpdates.at(-1), { key: 'mutationEngine', value: 'mutatest', target: true });
        settings.set('mutationWorkers', 2);
        settingScopes.set('mutationWorkers', 'workspaceValue');
        await view.receive({ command: 'setMutationWorkers', workers: 3 });
        assert.deepEqual(settingUpdates.at(-1), { key: 'mutationWorkers', value: 3, target: 2 });
        settingScopes.set('mutationEngine', 'workspaceFolderValue');
        await view.receive({ command: 'setMutationEngine', engine: 'builtin' });
        assert.deepEqual(settingUpdates.at(-1), { key: 'mutationEngine', value: 'builtin', target: 3 });
        await view.receive({ command: 'setMutationEngine', engine: 'mutatest' });
        view = attach();
        assert.match(view.webview.html, /value="mutatest" selected/);
        assert.match(view.webview.html, /id="mutation-workers" value="3"/);
        for (const message of [{ command: 'setMutationEngine', engine: 'unknown' },
            ...[0, 5, 1.5, '3', NaN].map(workers => ({ command: 'setMutationWorkers', workers }))]) {
            const count = settingUpdates.length;
            await view.receive(message);
            assert.equal(settingUpdates.length, count);
        }
        view.provider.beginAnalysis('active');
        const count = settingUpdates.length;
        await view.receive({ command: 'setMutationEngine', engine: 'builtin' });
        await view.receive({ command: 'setMutationWorkers', workers: 1 });
        assert.equal(settingUpdates.length, count, 'active analysis cannot change persisted mutation settings');
        view.provider.endAnalysis('active');
        for (const command of ['startAnalysis', 'startBatchAnalysis']) {
            await view.receive({ command, envType: 'local', mutationEngine: 'mutatest', mutationWorkers: 3 });
            assert.equal(executed.at(-1)[1].mutationEngine, 'mutatest');
            assert.equal(executed.at(-1)[1].mutationWorkers, 3);
        }
    } finally {
        Module._load = originalLoad;
    }
});

test('rendered Webview sends 5 loops and 60 seconds for both run modes, including empty input fallback', () => {
    setLanguage('zh-tw');
    const html = getWebviewContent(t);
    const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)![1];
    const elements = new Map<string, any>();
    for (const match of html.matchAll(/<(?:input|select|button|textarea|p)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        elements.set(match[1], { value: match[0].match(/\bvalue="([^"]*)"/)?.[1] || '', style: {}, addEventListener: () => {} });
    }
    const modeOptions = html.match(/<select id="validation-mode">([\s\S]*?)<\/select>/)![1];
    elements.get('validation-mode').value = modeOptions.match(/value="([^"]+)" selected/)![1];
    const engineOptions = html.match(/<select id="mutation-engine">([\s\S]*?)<\/select>/)![1];
    elements.get('mutation-engine').value = engineOptions.match(/value="([^"]+)" selected/)![1];
    assert.match(engineOptions, /value="mutmut"[^>]*disabled/);
    const messages: any[] = [];
    let receive!: (event: unknown) => void;
    const context = vm.createContext({
        document: { getElementById: (id: string) => elements.get(id) },
        window: { addEventListener: (event: string, handler: typeof receive) => { if (event === 'message') { receive = handler; } } },
        acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { messages.push(message); } })
    });
    vm.runInContext(script, context);
    assert.equal(elements.get('validation-mode').value, 'full');
    assert.match(elements.get('validation-scope').textContent, /包含突變測試/);
    assert.equal(elements.get('mutpy-timeout').disabled, false);
    assert.equal(elements.get('mutation-engine').value, 'builtin');
    assert.equal(elements.get('mutation-engine').disabled, false);
    assert.equal(elements.get('mutation-workers').value, '2');
    elements.get('mutation-engine').value = 'mutatest';
    elements.get('mutation-engine').onchange({ target: { value: 'mutatest' } });
    assert.equal(messages.at(-1).command, 'setMutationEngine');
    assert.equal(messages.at(-1).engine, 'mutatest');
    for (const value of ['', '0', '5', '1.5', 'NaN']) {
        elements.get('mutation-workers').value = value;
        elements.get('mutation-workers').onchange();
        assert.equal(messages.at(-1).workers, 2);
        assert.equal(elements.get('mutation-workers').value, '2');
    }
    elements.get('mutation-workers').value = '3';
    elements.get('mutation-workers').onchange();
    assert.equal(messages.at(-1).command, 'setMutationWorkers');
    assert.equal(messages.at(-1).workers, 3);
    assert.equal(elements.get('max-loop').value, String(DEFAULT_MAX_LOOPS));
    assert.equal(elements.get('mutpy-timeout').value, String(DEFAULT_MUTATION_TIMEOUT_SECONDS));
    elements.get('env-type').value = 'local';
    elements.get('model-select').value = 'fixture-model';
    // The legacy batch history must not override the selected project for all.
    receive({ data: { command: 'setBatchPath', path: '/batch' } });
    receive({ data: { command: 'setProjectPath', path: '/project' } });
    assert.equal(elements.has('batch-path'), false);
    assert.equal(elements.get('file-select').value, '');
    assert.equal(elements.get('func-select').disabled, true);
    elements.get('btn-batch-scope').onclick();
    assert.equal(messages.at(-1).command, 'previewBatchScope');
    assert.equal(messages.at(-1).projectRoot, '/project');
    receive({ data: { command: 'batchScopeSelected', projectRoot: '/project', text: '2 / 3 selected' } });
    assert.equal(elements.get('batch-scope-status').textContent, '2 / 3 selected');
    receive({ data: { command: 'batchScopeSelected', projectRoot: '/old-project', text: 'stale selection' } });
    assert.equal(elements.get('batch-scope-status').textContent, '2 / 3 selected');
    elements.get('file-select').value = '/project/target.py';
    elements.get('btn-prepare-env').onclick();
    assert.equal(messages.at(-1).command, 'prepareProjectEnvironment');
    assert.equal(messages.at(-1).filePath, undefined);
    assert.equal(messages.at(-1).projectRoot, '/project');
    elements.get('btn-prepare-env-scope').onclick();
    assert.equal(messages.at(-1).command, 'preparePythonEnvironment');
    assert.equal(messages.at(-1).filePath, '/project/target.py');
    assert.equal(messages.at(-1).projectRoot, '/project');
    elements.get('project-path').value = '';
    elements.get('btn-prepare-env').onclick();
    assert.equal(messages.at(-1).command, 'browseProjectFolder');
    elements.get('project-path').value = '/project';
    receive({ data: { command: 'environmentPreparation', busy: true, text: 'Checking environment' } });
    assert.equal(elements.get('btn-run').disabled, true);
    assert.equal(elements.get('btn-prepare-env').disabled, true);
    assert.equal(elements.get('btn-prepare-env-scope').disabled, true);
    assert.equal(elements.get('btn-batch-scope').disabled, true);
    assert.equal(elements.get('python-environment-status').value, 'Checking environment');
    receive({ data: { command: 'analysisFinished' } });
    assert.equal(elements.get('btn-run').disabled, true);
    receive({ data: { command: 'environmentPreparationFinished' } });
    assert.equal(elements.get('btn-run').disabled, false);
    elements.get('func-select').value = 'stale_function';
    elements.get('file-select').onchange({ target: { value: '/project/target.py' } });
    assert.equal(elements.get('func-select').value, '');
    assert.equal(messages.at(-1).command, 'getFunctions');
    receive({ data: { command: 'setFunctions', filePath: '/old/target.py', funcs: ['wrong'] } });
    assert.equal(elements.get('func-select').disabled, true);
    receive({ data: { command: 'setFunctions', filePath: '/project/target.py', funcs: ['target'] } });
    assert.equal(elements.get('func-select').disabled, false);
    for (const empty of [false, true]) {
        const mode = empty ? 'execution' : 'full';
        elements.get('validation-mode').value = mode;
        elements.get('validation-mode').onchange({ target: { value: mode } });
        assert.equal(messages.at(-1).mode, mode);
        assert.match(elements.get('validation-scope').textContent, mode === 'full' ? /包含突變測試/ : /不執行突變/);
        assert.equal(elements.get('mutpy-timeout').disabled, mode === 'execution');
        assert.equal(elements.get('max-loop').disabled, mode === 'execution');
        assert.equal(elements.get('mutation-engine').disabled, mode === 'execution');
        assert.equal(elements.get('mutation-workers').disabled, mode === 'execution');
        if (empty) { elements.get('max-loop').value = ''; elements.get('mutpy-timeout').value = ''; }
        for (const file of ['/project/target.py', '']) {
            elements.get('file-select').value = file;
            elements.get('file-select').onchange({ target: { value: file } });
            elements.get('btn-run').onclick();
            const message = messages.at(-1);
            assert.equal(message.command, file ? 'startAnalysis' : 'startBatchAnalysis');
            if (!file) {
                assert.equal(message.batchPath, '/project');
                assert.equal(message.filePath, undefined);
                assert.equal(message.funcName, undefined);
            } else { assert.equal(message.filePath, file); }
            assert.equal(message.maxLoops, DEFAULT_MAX_LOOPS);
            assert.equal(message.mutpyTimeout, DEFAULT_MUTATION_TIMEOUT_SECONDS);
            assert.equal(message.timeoutSeconds, 60);
            assert.equal(message.validationMode, mode, 'both single-file and batch requests carry the displayed mode');
            assert.equal(message.mutationEngine, 'mutatest');
            assert.equal(message.mutationWorkers, 3);
            assert.equal(elements.get('validation-mode').disabled, true, 'the active run cannot change modes');
            assert.equal(elements.get('mutation-engine').disabled, true);
            assert.equal(elements.get('mutation-workers').disabled, true);
            assert.equal(elements.get('btn-batch-scope').disabled, true);
            const count = messages.length;
            elements.get('mutation-engine').onchange({ target: { value: 'builtin' } });
            elements.get('mutation-workers').onchange();
            elements.get('btn-run').onclick();
            assert.equal(messages.length, count, 'running analysis prevents duplicate start');
            receive({ data: { command: 'analysisFinished' } });
            assert.equal(elements.get('validation-mode').disabled, false);
            assert.equal(elements.get('mutation-engine').disabled, mode === 'execution');
            assert.equal(elements.get('mutation-workers').disabled, mode === 'execution');
        }
    }
    elements.get('file-select').value = '/project/target.py';
    receive({ data: { command: 'setFiles', projectPath: '/previous-project', files: [] } });
    assert.equal(elements.get('file-select').value, '/project/target.py', 'stale project scans cannot replace the selected scope');
    receive({ data: { command: 'setFiles', projectPath: '/project', files: [{ path: '/project/a.py', name: 'a.py' }] } });
    assert.equal(elements.get('file-select').value, '');
    assert.equal(elements.get('func-select').disabled, true);
    elements.get('mutpy-timeout').value = '20';
    elements.get('btn-run').onclick();
    assert.equal(messages.at(-1).mutpyTimeout, 20, 'an explicit mutation timeout is not replaced by the new default');
    receive({ data: { command: 'analysisFinished' } });
    elements.get('project-path').value = '';
    elements.get('btn-run').onclick();
    assert.equal(messages.at(-1).command, 'appendLog');
});

test('backend commands use the same defaults for missing/invalid limits and preserve explicit overrides', () => {
    assert.deepEqual(normalizeExecutionSettings({}), { maxLoops: 5, mutpyTimeout: 60 });
    for (const invalid of [undefined, null, 0, -1, NaN, Infinity, '20', 1.5]) {
        assert.deepEqual(normalizeExecutionSettings({ maxLoops: invalid, mutpyTimeout: invalid }), { maxLoops: 5, mutpyTimeout: 60 });
    }
    assert.deepEqual(normalizeExecutionSettings({ maxLoops: 9, mutpyTimeout: 40 }), { maxLoops: 9, mutpyTimeout: 40 });
    assert.deepEqual(normalizeExecutionSettings({ maxLoops: 1, mutpyTimeout: 10 }), { maxLoops: 1, mutpyTimeout: 10 });
    assert.deepEqual(normalizeExecutionSettings({ mutpyTimeout: 20 }), { maxLoops: 5, mutpyTimeout: 20 });
});
