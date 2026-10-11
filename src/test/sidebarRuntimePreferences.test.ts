import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualificationEndpointKey } from '../llm/modelQualification';
import { getRuntimeContextPreference, RUNTIME_CONTEXT_PREFERENCES_KEY, upsertRuntimeContextPreference } from '../llm/runtimeContextPreferences';
import { OLLAMA_ALLOCATION_OBSERVATIONS_KEY } from '../llm/ollamaAllocationObservations';

test('Sidebar defaults to half a known model limit while preserving explicit per-model context choices', async t => {
    const Module = require('module');
    const originalLoad = Module._load, originalFetch = globalThis.fetch;
    const settings = new Map<string, unknown>([['language', 'en'], ['ollamaBaseUrl', 'http://127.0.0.1:11434'], ['runtimeContextTokens', 0]]);
    const stored = new Map<string, unknown>();
    const messages: any[] = [], warnings: string[] = [], updates: any[] = [];
    let running: unknown = { models: [{ name: 'neutral-a', context_length: 8192 }] };
    let shown: unknown = { details: { parameter_size: '3B' }, parameters: 'num_ctx 4096',
        model_info: { 'general.architecture': 'neutral', 'neutral.context_length': 32768 } };
    let fetchCount = 0;
    let onShow: (() => void) | undefined;
    const vscode = { env: { language: 'en' },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        workspace: { getConfiguration: () => ({
            get: (key: string, fallback: unknown) => settings.has(key) ? settings.get(key) : fallback,
            inspect: () => ({ workspaceValue: settings.get('runtimeContextTokens') }),
            update: async (key: string, value: unknown, target: unknown) => { updates.push({ key, value, target }); settings.set(key, value); }
        }) },
        window: { showWarningMessage: (text: string) => { warnings.push(text); } },
        commands: { executeCommand: async () => {} }
    };
    Module._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    globalThis.fetch = async url => {
        fetchCount++;
        if (String(url).endsWith('/api/show')) {
            const callback = onShow; onShow = undefined; callback?.();
            return Response.json(shown);
        }
        assert.ok(String(url).endsWith('/api/ps'));
        return Response.json(running);
    };
    try {
        const { MutationViewProvider } = require('../ui/SidebarProvider');
        const state = { get: (key: string) => stored.get(key), update: async (key: string, value: unknown) => { stored.set(key, value); } };
        const attach = () => {
            const provider = new MutationViewProvider({ get: async () => { throw new Error('Context metadata must not access credentials'); } }, state);
            let receive!: (message: unknown) => Promise<void>;
            provider.resolveWebviewView({ webview: { html: '', options: {}, postMessage: (message: unknown) => { messages.push(message); },
                onDidReceiveMessage: (handler: typeof receive) => { receive = handler; } } });
            return { provider, receive };
        };
        let view = attach();
        const last = () => messages.filter(item => item.command === 'modelRuntimeContext').at(-1);
        const identity = (modelName = 'neutral-a', endpoint = String(settings.get('ollamaBaseUrl'))) =>
            ({ endpointKey: qualificationEndpointKey('local', endpoint), modelName });
        const get = (modelName = 'neutral-a') => view.receive({ command: 'getModelRuntimeContext', modelName, revision: 1 });
        const save = (tokens: number, modelName = 'neutral-a') => view.receive({ command: 'setModelRuntimeContextTokens', modelName, tokens, revision: 2 });
        const reset = () => { stored.clear(); messages.length = warnings.length = updates.length = 0; onShow = undefined; settings.set('runtimeContextTokens', 0);
            settings.set('ollamaBaseUrl', 'http://127.0.0.1:11434'); shown = { details: { parameter_size: '3B' }, parameters: 'num_ctx 4096',
                model_info: { 'general.architecture': 'neutral', 'neutral.context_length': 32768 } }; running = { models: [{ name: 'neutral-a', context_length: 8192 }] }; };

        await t.test('automatic half-limit selection survives recreation independently of the observed allocation', async () => {
            reset(); await get();
            assert.equal(last().requestTokens, 16384);
            assert.equal(last().modelLimit, 32768);
            assert.equal(last().allocatedTokens, 8192);
            assert.equal(last().allocationCurrent, true);
            assert.deepEqual(getRuntimeContextPreference(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY), identity()),
                { ...identity(), tokens: 16384, source: 'captured-runtime' });
            assert.equal(settings.get('runtimeContextTokens'), 0); assert.equal(updates.length, 0);
            running = { models: [{ name: 'neutral-a', context_length: 24576 }] }; view = attach(); await get();
            assert.equal(last().requestTokens, 16384); assert.equal(last().savedTokens, 16384);
            assert.equal(last().allocatedTokens, 24576);
        });

        await t.test('legacy automatic 4096 migrates but a user 4096 choice survives until explicitly reset', async () => {
            reset();
            shown = { details: { parameter_size: '3B' }, parameters: 'num_ctx 4096',
                model_info: { 'general.architecture': 'neutral', 'neutral.context_length': 16384 } };
            running = { models: [{ name: 'neutral-a', context_length: 4096 }] };
            stored.set(RUNTIME_CONTEXT_PREFERENCES_KEY, upsertRuntimeContextPreference([], identity(), 4096, 'captured-runtime'));
            await get();
            assert.equal(last().requestTokens, 8192); assert.equal(last().savedTokens, 8192);
            assert.equal(last().savedSource, 'captured-runtime');
            view = attach(); await get(); assert.equal(last().requestTokens, 8192);
            await save(4096);
            assert.equal(last().requestTokens, 4096); assert.equal(last().savedTokens, 4096);
            assert.equal(last().savedSource, 'user-choice');
            view = attach(); await get(); assert.equal(last().requestTokens, 4096);
            await save(0);
            assert.equal(last().requestTokens, 8192); assert.equal(last().savedTokens, 8192);
            assert.equal(last().savedSource, 'captured-runtime');
            assert.equal(last().allocatedTokens, 4096, 'reset changes the next request, not the reported current allocation');
        });

        await t.test('automatic migration cannot overwrite a manual choice saved while metadata is being fetched', async () => {
            reset();
            stored.set(RUNTIME_CONTEXT_PREFERENCES_KEY, upsertRuntimeContextPreference([], identity(), 4096, 'captured-runtime'));
            onShow = () => {
                stored.set(RUNTIME_CONTEXT_PREFERENCES_KEY,
                    upsertRuntimeContextPreference(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY), identity(), 6144, 'user-choice'));
            };
            await get();
            assert.deepEqual(getRuntimeContextPreference(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY), identity()),
                { ...identity(), tokens: 6144, source: 'user-choice' });
            assert.equal(last().requestTokens, 6144);
            assert.equal(last().savedTokens, 6144);
            view = attach(); await get();
            assert.equal(last().requestTokens, 6144); assert.equal(last().savedTokens, 6144);
            assert.equal(last().savedSource, 'user-choice');
        });

        await t.test('different endpoints and models get independent choices and 0 resets only the selected choice', async () => {
            reset(); await get(); await save(12288);
            assert.equal(last().requestTokens, 12288); assert.equal(last().savedSource, 'user-choice');
            assert.equal(settings.get('runtimeContextTokens'), 0);
            await get('neutral-b'); assert.equal(last().requestTokens, 16384);
            await save(6144, 'neutral-b');
            settings.set('ollamaBaseUrl', 'http://127.0.0.1:21434'); await get(); assert.equal(last().requestTokens, 16384);
            await save(16384);
            settings.set('ollamaBaseUrl', 'http://127.0.0.1:11434'); await get(); assert.equal(last().requestTokens, 12288);
            await save(0); assert.equal(last().savedSource, 'captured-runtime'); assert.equal(last().requestTokens, 16384);
            assert.equal(getRuntimeContextPreference(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY), identity('neutral-b'))?.tokens, 6144);
            assert.equal(getRuntimeContextPreference(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY), identity('neutral-a', 'http://127.0.0.1:21434'))?.tokens, 16384);
        });

        await t.test('unknown upper bounds retain captured fallback after reopening but reject manual unverified capacity', async () => {
            reset(); shown = {}; running = { models: [] }; await get();
            assert.equal(last().requestTokens, 4096); assert.equal(last().modelLimit, undefined);
            view = attach(); await get(); assert.equal(last().requestTokens, 4096); assert.equal(last().reasonCode, undefined);
            const previous = JSON.stringify(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY));
            await save(8192); assert.equal(JSON.stringify(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY)), previous);
            assert.equal(warnings.length, 1); assert.equal(last().requestTokens, 4096);
        });

        await t.test('an unknown model upper bound does not turn its captured ps allocation into an invalid manual choice after reopen', async () => {
            reset(); shown = {}; await get();
            assert.equal(last().requestTokens, 8192); assert.equal(last().modelLimit, undefined);
            assert.equal(last().savedSource, 'captured-runtime');
            running = { models: [] }; view = attach(); await get();
            assert.equal(last().requestTokens, 8192); assert.equal(last().reasonCode, undefined);
            assert.equal(last().allocationCurrent, false); assert.equal(last().allocatedTokens, 8192);
        });

        await t.test('explicit settings keep priority and only direct user saving updates their existing scope', async () => {
            reset(); settings.set('runtimeContextTokens', 16384); await get();
            assert.equal(last().requestTokens, 16384); assert.equal(updates.length, 0);
            assert.equal(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY), undefined);
            await save(12288); assert.deepEqual(updates.at(-1), { key: 'runtimeContextTokens', value: 12288, target: 2 });
            assert.equal(last().requestTokens, 12288);
            await save(0); assert.equal(settings.get('runtimeContextTokens'), 0); assert.equal(last().requestTokens, 16384);
        });

        await t.test('invalid user choices, active analyses and unsaved endpoint messages do not mutate preferences', async () => {
            reset(); await get(); const previous = JSON.stringify(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY));
            for (const tokens of [-1, 1.5, NaN, 32769]) { await save(tokens); }
            assert.equal(JSON.stringify(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY)), previous);
            view.provider.beginAnalysis('active'); const count = fetchCount;
            await get(); await save(16384); assert.equal(fetchCount, count);
            view.provider.endAnalysis('active');
            await view.receive({ command: 'setModelRuntimeContextTokens', modelName: 'neutral-a', tokens: 16384, ollamaUrl: 'http://127.0.0.1:31434' });
            assert.equal(fetchCount, count); assert.equal(JSON.stringify(stored.get(RUNTIME_CONTEXT_PREFERENCES_KEY)), previous);
        });

        await t.test('a Modelfile default does not claim an actual allocation or overwrite the recent ps observation', async () => {
            reset(); running = { models: [] };
            stored.set('llmUnitTest.modelProfiles.v1', [{ envType: 'local', ...identity(), paramSize: '3B', contextLength: 32768,
                contextLengthKnown: true, effectiveRuntimeContextTokens: 8192, runtimeContextSource: 'ollama-ps' }]);
            await get(); assert.equal(last().allocatedTokens, 8192); assert.equal(last().allocationCurrent, false);
            assert.equal(last().defaultTokens, 4096);
            stored.delete('llmUnitTest.modelProfiles.v1'); await get('neutral-b');
            assert.equal(last().allocatedTokens, undefined); assert.equal(last().allocationCurrent, false);
            assert.equal(last().defaultTokens, 4096); assert.equal(last().requestTokens, 16384);
        });

        await t.test('selection alone persists ps observations, with recent labeling after unload and recreation', async () => {
            reset(); await get(); assert.ok(stored.has(OLLAMA_ALLOCATION_OBSERVATIONS_KEY));
            running = { models: [] }; view = attach(); await get();
            assert.equal(last().allocatedTokens, 8192); assert.equal(last().allocationCurrent, false);
            assert.equal(last().defaultTokens, 4096); assert.equal(last().requestTokens, 16384);
        });

        await t.test('an explicit reset ignores old qualification capacity and selects half the verified model limit', async () => {
            reset(); stored.set('llmUnitTest.modelProfiles.v1', [{ envType: 'local', ...identity(), paramSize: '3B', contextLength: 32768,
                contextLengthKnown: true, qualificationRuntime: { version: 'ollama-context-v1', numCtx: 8192 } }]);
            stored.set(RUNTIME_CONTEXT_PREFERENCES_KEY, upsertRuntimeContextPreference([], identity(), 8192, 'user-choice'));
            running = { models: [{ name: 'neutral-a', context_length: 16384 }] };
            await get(); assert.equal(last().requestTokens, 8192);
            await save(0); assert.equal(last().requestTokens, 16384); assert.equal(last().savedTokens, 16384);
            assert.equal(last().savedSource, 'captured-runtime');
        });
    } finally { Module._load = originalLoad; globalThis.fetch = originalFetch; }
});
