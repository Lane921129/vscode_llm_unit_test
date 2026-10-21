import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_TIMEOUT_PREFERENCE_KEY } from '../pipeline/executionTimingSettings';

test('Sidebar timing saves merge limits and keep startup snapshots safe across asynchronous changes', async t => {
    const Module = require('module');
    const originalLoad = Module._load;
    const savedBudget = { timeoutMs: 1501, logicalRequests: 31, transportAttempts: 57, candidateAttempts: 0 };
    const settings = new Map<string, unknown>([['language', 'en'], ['targetBudget', savedBudget]]);
    const stored = new Map<string, unknown>([[API_TIMEOUT_PREFERENCE_KEY, 1800]]);
    const calls: any[][] = [], messages: any[] = [], updates: any[][] = [], warnings: string[] = [], errors: string[] = [];
    let saveWait: Promise<void> | undefined;
    let credentialWait: Promise<void> | undefined;
    const config = {
        get: (key: string, fallback: unknown) => settings.has(key) ? settings.get(key) : fallback,
        inspect: () => ({ workspaceValue: savedBudget }),
        update: async (key: string, value: unknown, target: unknown) => {
            updates.push([key, value, target]);
            await saveWait;
            settings.set(key, value);
        }
    };
    const vscode = {
        env: { language: 'en' },
        ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
        commands: { executeCommand: async (...args: any[]) => { calls.push(args); } },
        workspace: { getConfiguration: () => config },
        Uri: { file: (fsPath: string) => ({ fsPath }) },
        window: {
            showWarningMessage: (value: string) => { warnings.push(value); },
            showErrorMessage: (value: string) => { errors.push(value); },
            showOpenDialog: async () => [{ fsPath: '/different-selection' }]
        }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    try {
        const { MutationViewProvider } = require('../ui/SidebarProvider');
        const provider = new MutationViewProvider({ get: async () => undefined },
            { get: (key: string, fallback: unknown) => stored.has(key) ? stored.get(key) : fallback,
                update: async (key: string, value: unknown) => { stored.set(key, value); } });
        provider.findPythonFiles = async () => [];
        provider.fetchLocalModels = async () => [];
        provider.getStoredCloudCredentials = async () => { await credentialWait; return {}; };
        let receive!: (message: unknown) => Promise<void>;
        provider.resolveWebviewView({ webview: { html: '', options: {},
            postMessage: (value: unknown) => { messages.push(value); },
            onDidReceiveMessage: (handler: typeof receive) => { receive = handler; } } });
        const start = (extra: Record<string, unknown> = {}) => receive({ command: 'startBatchAnalysis', envType: 'local',
            modelName: 'neutral-model', batchPath: '/fixture', timeoutSeconds: 1800, targetTimeoutSeconds: 3600, ...extra });
        const reset = () => {
            calls.length = messages.length = updates.length = warnings.length = errors.length = 0;
            saveWait = credentialWait = undefined;
        };
        await t.test('initial values show the actual saved total and exact units', async () => {
            await receive({ command: 'getInitialData' });
            assert.deepEqual(messages.find(item => item.command === 'executionTimingSettings'), {
                command: 'executionTimingSettings', timeoutSeconds: 1800, targetTimeoutSeconds: 1.501
            });
        });
        await t.test('a long wait saves at the original setting scope without overwriting counters', async () => {
            reset();
            await start();
            assert.deepEqual(updates, [['targetBudget', { ...savedBudget, timeoutMs: 3600000 }, 2]]);
            assert.equal(stored.get(API_TIMEOUT_PREFERENCE_KEY), 1800);
            assert.equal(savedBudget.timeoutMs, 1501, 'source settings are never mutated');
            assert.equal(calls.length, 1);
            assert.equal(calls[0][0], 'llm-unit-test.runBatchAnalysis');
            assert.equal(calls[0][1].timeoutSeconds, 1800);
            assert.deepEqual(calls[0][1].targetBudget, { ...savedBudget, timeoutMs: 3600000 });
            assert.equal(Object.isFrozen(calls[0][1].targetBudget), true);
        });
        await t.test('a unit mistake is rejected before any save or launch', async () => {
            reset();
            await start({ timeoutSeconds: 60000000 });
            assert.equal(calls.length, 0);
            assert.equal(updates.length, 0);
            assert.equal(warnings.length, 1);
            assert.doesNotMatch(warnings[0], /[\u3400-\u9fff]/);
            assert.equal(messages.at(-1).command, 'analysisFinished');
        });
        await t.test('a pending save cannot start after another analysis takes ownership', async () => {
            reset();
            let release!: () => void;
            saveWait = new Promise<void>(resolve => { release = resolve; });
            const pending = start();
            provider.beginAnalysis('other-run');
            release();
            await pending;
            assert.equal(calls.length, 0);
            assert.equal(messages.some(item => item.command === 'analysisFinished'), false, 'never unlock the active owner');
            provider.endAnalysis('other-run');
        });
        await t.test('changing selection during save discards the old pending start', async () => {
            reset();
            let release!: () => void;
            saveWait = new Promise<void>(resolve => { release = resolve; });
            const pending = start();
            await receive({ command: 'browseBatchFolder' });
            release();
            await pending;
            assert.equal(calls.length, 0);
            assert.equal(messages.at(-1).command, 'analysisFinished');
        });
        await t.test('abort during save prevents dispatch and duplicate starts are ignored', async () => {
            reset();
            let release!: () => void;
            saveWait = new Promise<void>(resolve => { release = resolve; });
            const pending = start();
            await start({ targetTimeoutSeconds: 7200 });
            await receive({ command: 'abortTest' });
            release();
            await pending;
            assert.deepEqual(calls.map(item => item[0]), ['llm-unit-test.abortTest']);
            assert.equal(messages.filter(item => item.command === 'analysisFinished').length, 1);
            assert.equal(updates.length, 1);
        });
        await t.test('settings persistence failure does not block starting analysis and appendLog warns visibly', async () => {
            reset();
            saveWait = Promise.reject(new Error('Unable to write to User Settings because llmUnitTest.targetBudget is not a registered configuration.'));
            saveWait.catch(() => undefined);
            await start();
            assert.equal(calls.length, 1);
            assert.equal(calls[0][0], 'llm-unit-test.runBatchAnalysis');
            assert.equal(warnings.length, 0);
            await receive({ command: 'appendLog', text: 'Please select Env, Model, and Project or File.' });
            assert.equal(warnings.at(-1), 'Please select Env, Model, and Project or File.');
            assert.deepEqual(messages.at(-1), { command: 'appendLog', text: 'Please select Env, Model, and Project or File.' });
        });
        await t.test('late missing credentials cannot finish another active owner', async () => {
            reset();
            let release!: () => void;
            credentialWait = new Promise<void>(resolve => { release = resolve; });
            const pending = start({ envType: 'cloud', cloudKeyName: 'removed-setting' });
            provider.beginAnalysis('credential-owner');
            release();
            await pending;
            try {
                assert.equal(calls.length, 0);
                assert.equal(messages.some(item => item.command === 'analysisFinished'), false);
                assert.equal(errors.length, 0);
            } finally { provider.endAnalysis('credential-owner'); }
        });
        await t.test('changing selection during credentials lookup discards the stale missing-key error', async () => {
            reset();
            let release!: () => void;
            credentialWait = new Promise<void>(resolve => { release = resolve; });
            const pending = start({ envType: 'cloud', cloudKeyName: 'removed-setting' });
            await receive({ command: 'browseBatchFolder' });
            release();
            await pending;
            assert.equal(calls.length, 0);
            assert.equal(errors.length, 0);
            assert.equal(messages.filter(item => item.command === 'analysisFinished').length, 1);
        });
        await t.test('abort during credentials lookup finishes once without reporting a missing key', async () => {
            reset();
            let release!: () => void;
            credentialWait = new Promise<void>(resolve => { release = resolve; });
            const pending = start({ envType: 'cloud', cloudKeyName: 'removed-setting' });
            await receive({ command: 'abortTest' });
            release();
            await pending;
            assert.deepEqual(calls.map(item => item[0]), ['llm-unit-test.abortTest']);
            assert.equal(errors.length, 0);
            assert.equal(messages.filter(item => item.command === 'analysisFinished').length, 1);
        });
        await t.test('a current missing credential still fails visibly before dispatch', async () => {
            reset();
            await start({ envType: 'cloud', cloudKeyName: 'removed-setting' });
            assert.equal(calls.length, 0);
            assert.equal(errors.length, 1);
            assert.equal(messages.filter(item => item.command === 'analysisFinished').length, 1);
        });
    } finally { Module._load = originalLoad; }
});
