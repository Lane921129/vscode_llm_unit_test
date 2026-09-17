import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { getWebviewContent } from '../ui/webviewContent';
import { normalizeExecutionSettings, DEFAULT_MAX_LOOPS, DEFAULT_MUTATION_TIMEOUT_SECONDS } from '../pipeline/executionSettings';

test('all folder pickers restore independent selections after provider recreation and cancellation preserves history', async () => {
    const Module = require('module');
    const originalLoad = Module._load;
    const stored = new Map<string, unknown>();
    const settings = new Map<string, unknown>([['projectPath', '/old-project'], ['outputPath', '/old-output']]);
    const dialogs: any[] = [];
    const choices: Array<Array<{ fsPath: string }> | undefined> = [];
    const state = { get: (key: string) => stored.get(key), update: async (key: string, value: unknown) => { stored.set(key, value); } };
    const vscode = {
        workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings.get(key) ?? fallback,
            update: async (key: string, value: unknown) => { settings.set(key, value); } }) },
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
            provider.resolveWebviewView({ webview: { options: {}, html: '',
                postMessage: (message: unknown) => { messages.push(message); },
                onDidReceiveMessage: (handler: typeof receive) => { receive = handler; } } });
            return { receive, messages, scans };
        };
        let view = attach();
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
    } finally {
        Module._load = originalLoad;
    }
});

test('rendered Webview sends 5 loops and 20 seconds for both run modes, including empty input fallback', () => {
    const html = getWebviewContent(key => key);
    const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)![1];
    const elements = new Map<string, any>();
    for (const match of html.matchAll(/<(?:input|select|button|textarea)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        elements.set(match[1], { value: match[0].match(/\bvalue="([^"]*)"/)?.[1] || '', style: {}, addEventListener: () => {} });
    }
    const messages: any[] = [];
    let receive!: (event: unknown) => void;
    const context = vm.createContext({
        document: { getElementById: (id: string) => elements.get(id) },
        window: { addEventListener: (event: string, handler: typeof receive) => { if (event === 'message') { receive = handler; } } },
        acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { messages.push(message); } })
    });
    vm.runInContext(script, context);
    assert.equal(elements.get('max-loop').value, String(DEFAULT_MAX_LOOPS));
    assert.equal(elements.get('mutpy-timeout').value, String(DEFAULT_MUTATION_TIMEOUT_SECONDS));
    elements.get('env-type').value = 'local';
    elements.get('model-select').value = 'fixture-model';
    elements.get('file-select').value = '/project/target.py';
    receive({ data: { command: 'setBatchPath', path: '/batch' } });
    receive({ data: { command: 'setProjectPath', path: '/project' } });
    assert.equal(elements.get('batch-path').value, '/batch');
    // Keep the second run's project identical so this test needs no dashboard DOM.
    elements.get('batch-path').value = '/project';
    for (const empty of [false, true]) {
        if (empty) { elements.get('max-loop').value = ''; elements.get('mutpy-timeout').value = ''; }
        for (const id of ['btn-run', 'btn-batch-run']) {
            elements.get(id).onclick();
            const message = messages.at(-1);
            assert.equal(message.maxLoops, DEFAULT_MAX_LOOPS);
            assert.equal(message.mutpyTimeout, DEFAULT_MUTATION_TIMEOUT_SECONDS);
            assert.equal(message.timeoutSeconds, 60);
        }
    }
});

test('backend commands use the same defaults for missing/invalid limits and preserve explicit overrides', () => {
    assert.deepEqual(normalizeExecutionSettings({}), { maxLoops: 5, mutpyTimeout: 20 });
    for (const invalid of [undefined, null, 0, -1, NaN, Infinity, '20', 1.5]) {
        assert.deepEqual(normalizeExecutionSettings({ maxLoops: invalid, mutpyTimeout: invalid }), { maxLoops: 5, mutpyTimeout: 20 });
    }
    assert.deepEqual(normalizeExecutionSettings({ maxLoops: 9, mutpyTimeout: 40 }), { maxLoops: 9, mutpyTimeout: 40 });
    assert.deepEqual(normalizeExecutionSettings({ maxLoops: 1, mutpyTimeout: 10 }), { maxLoops: 1, mutpyTimeout: 10 });
});
