import * as assert from 'node:assert/strict';
import { test } from 'node:test';

test('Sidebar discovery and each non-local qualification keep a deadline through JSON decoding', async t => {
    const Module = require('module');
    const originalLoad = Module._load, originalFetch = globalThis.fetch, originalWarn = console.warn;
    const errors: string[] = [], information: string[] = [], profiles: any[] = [];
    const vscode = {
        commands: { executeCommand: async (name: string, profile: unknown) => {
            if (name === 'llm-unit-test.updateModelProfile') { profiles.push(profile); }
        } },
        workspace: { getConfiguration: () => ({ get: (name: string, fallback: unknown) =>
            name === 'language' ? 'en' : name === 'ollamaBaseUrl' ? 'http://fixture.invalid' : fallback }) },
        env: { language: 'en' }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        ProgressLocation: { Notification: 1 },
        window: { withProgress: async (_options: unknown, run: () => Promise<void>) => run(),
            showInformationMessage: (message: string) => { information.push(message); },
            showWarningMessage: () => undefined,
            showErrorMessage: (message: string) => { errors.push(message); } }
    };
    Module._load = function (name: string, ...args: any[]) {
        if (name === 'vscode') { return vscode; }
        const value = originalLoad.call(this, name, ...args);
        if (name.endsWith('/connectionTimeout')) {
            return { ...value, CONNECTION_DISCOVERY_TIMEOUT_MS: 100, MODEL_QUALIFICATION_TIMEOUT_MS: 100 };
        }
        if (name.endsWith('/modelProbeExecution') || name === './modelProbeExecution') {
            return { ...value, runIsolatedProbe: async () => true };
        }
        return value;
    };
    console.warn = () => undefined;
    try {
        const { MutationViewProvider } = require('../ui/SidebarProvider');
        let receive!: (message: unknown) => Promise<void>;
        const provider = new MutationViewProvider({ get: async () => JSON.stringify({ fixture:
            { model: 'neutral-cloud', key: 'fixture-only-credential' } }) },
        { get: () => undefined, update: async () => undefined });
        provider.resolveWebviewView({ webview: { options: {}, html: '', postMessage: () => undefined,
            onDidReceiveMessage: (handler: typeof receive) => { receive = handler; } } });
        const request = (envType: 'local' | 'custom' | 'cloud') => receive({ command: 'testConnection', envType,
            modelName: 'neutral-model', cloudKeyName: 'fixture', customUrl: 'https://fixture.invalid/chat/completions' });
        const reset = () => { errors.length = information.length = profiles.length = 0; };
        const hanging = () => {
            let cancellations = 0, decoded = 0;
            return { response: { ok: true, status: 200,
                json: () => { decoded++; return new Promise(() => undefined); },
                body: { cancel: () => { cancellations++; return new Promise(() => undefined); } } } as unknown as Response,
            cancelled: () => cancellations, decoded: () => decoded };
        };

        await t.test('Custom Writer body stall exits without certifying a profile', async () => {
            reset(); const stalled = hanging(); let requests = 0;
            globalThis.fetch = async () => { requests++; return stalled.response; };
            await request('custom');
            assert.equal(requests, 1); assert.equal(stalled.cancelled(), 1); assert.equal(stalled.decoded(), 1);
            assert.equal(profiles.length, 0); assert.equal(information.length, 0);
            assert.equal(errors.length, 1); assert.match(errors[0], /deadline/);
        });

        await t.test('Custom Reviewer and Bug Fixer stalled bodies become unavailable after the completed Writer probe', async () => {
            reset(); const stalled = hanging(); let requests = 0;
            const writer = `import unittest
class TestCases(unittest.TestCase):
    def test_one(self):
        self.assertEqual(increment(1), 2)
    def test_two(self):
        self.assertEqual(increment(-1), 0)
`;
            const completeWriter = Response.json({ choices: [{ message: { content: writer } }] });
            globalThis.fetch = async () => ++requests === 1 ? completeWriter : stalled.response;
            await request('custom');
            assert.equal(requests, 3); assert.equal(stalled.cancelled(), 2);
            assert.equal(profiles.at(-1).roleQualification.writer.state, 'verified');
            for (const role of ['reviewer', 'bugFixer']) {
                assert.equal(profiles.at(-1).roleQualification[role].state, 'not-run');
                assert.equal(profiles.at(-1).roleQualification[role].diagnostics.failureKind, 'unavailable');
            }
        });

        await t.test('Cloud model-list body stall stops before any qualification request', async () => {
            reset(); const stalled = hanging(); let requests = 0;
            globalThis.fetch = async () => { requests++; return stalled.response; };
            await request('cloud');
            assert.equal(requests, 1); assert.equal(stalled.cancelled(), 1);
            assert.equal(profiles.length, 0); assert.equal(errors.length, 1); assert.match(errors[0], /deadline/);
        });

        await t.test('Cloud qualification bounds an abort-ignoring body after a valid model list', async () => {
            reset(); const stalled = hanging(); let requests = 0;
            globalThis.fetch = async (_url, init) => {
                requests++;
                return init?.body ? stalled.response : Response.json({ models: [{ name: 'models/neutral-cloud',
                    supportedGenerationMethods: ['generateContent'], inputTokenLimit: 8192 }] });
            };
            await request('cloud');
            assert.equal(requests, 2); assert.equal(stalled.cancelled(), 1);
            assert.equal(profiles.length, 0); assert.equal(errors.length, 1); assert.match(errors[0], /deadline/);
        });

        await t.test('Ollama model listing and initial discovery do not hang on a pending JSON body', async () => {
            reset(); const stalled = hanging(); let requests = 0;
            globalThis.fetch = async () => { requests++; return stalled.response; };
            assert.deepEqual(await (provider as any).fetchLocalModels(), []);
            await request('local');
            assert.equal(requests, 2); assert.equal(stalled.cancelled(), 2);
            assert.equal(profiles.length, 0); assert.equal(errors.length, 1); assert.match(errors[0], /deadline/);
        });
    } finally {
        Module._load = originalLoad; globalThis.fetch = originalFetch; console.warn = originalWarn;
    }
});
