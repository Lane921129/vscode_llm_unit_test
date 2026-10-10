import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { qualificationAppliesToRequest, qualificationEndpointKey } from '../llm/modelQualification';
import { BUG_FIXER_QUALIFICATION_PROMPT, REVIEWER_QUALIFICATION_PROMPT } from '../llm/roleQualification';
import { PLAIN_TEST_GENERATION_PROBE_PROMPT } from '../llm/testGenerationQualification';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const writerResponse = `import unittest
class TestCases(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(increment(1), 2)
    def test_negative(self):
        self.assertEqual(increment(-1), 0)
`;
const fixerResponse = '```python\ndef test_increment(self):\n    self.assertEqual(increment(1), 2)\n```';
const metadata = { details: { parameter_size: '3B' },
    model_info: { 'general.architecture': 'neutral', 'neutral.context_length': 32768 } };

test('Sidebar connection binds actual role probes to one local runtime snapshot', async t => {
    const Module = require('module');
    const originalLoad = Module._load;
    const originalFetch = globalThis.fetch;
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const settings = new Map<string, unknown>([['language', 'zh-tw'], ['pythonPath', python],
        ['ollamaBaseUrl', 'http://127.0.0.1:11434'], ['runtimeContextTokens', 0]]);
    const executed: any[][] = [], messages: any[] = [], information: string[] = [], warnings: string[] = [], errors: string[] = [];
    const vscode = {
        commands: { executeCommand: async (...args: any[]) => { executed.push(args); } },
        workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings.has(key) ? settings.get(key) : fallback }) },
        env: { language: 'zh-tw' }, Uri: { file: (fsPath: string) => ({ fsPath }) },
        ProgressLocation: { Notification: 1 },
        window: {
            withProgress: async (_options: unknown, run: () => Promise<void>) => run(),
            showInformationMessage: (message: string) => { information.push(message); },
            showWarningMessage: (message: string) => { warnings.push(message); },
            showErrorMessage: (message: string) => { errors.push(message); }
        }
    };
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    try {
        const { MutationViewProvider } = require('../ui/SidebarProvider');
        let receive!: (message: unknown) => Promise<void>;
        const provider = new MutationViewProvider({ get: async (key: string) => key === 'llm_api_keys'
            ? JSON.stringify({ neutral: { model: 'neutral-cloud', key: 'fixture-only-credential' } }) : undefined }, { get: () => undefined });
        provider.resolveWebviewView({ webview: { options: {}, html: '',
            postMessage: (message: unknown) => { messages.push(message); },
            onDidReceiveMessage: (handler: typeof receive) => { receive = handler; } } });
        const reset = () => { executed.length = messages.length = information.length = warnings.length = errors.length = 0; };
        const finalProfile = () => executed.filter(item => item[0] === 'llm-unit-test.updateModelProfile').at(-1)?.[1];
        const request = () => receive({ command: 'testConnection', envType: 'local', modelName: 'neutral-model' });
        const installTransport = (show: () => Response = () => Response.json(metadata), onWriter?: () => void) => {
            const probes: any[] = [];
            globalThis.fetch = async (url, init) => {
                const endpoint = String(url);
                if (endpoint.endsWith('/api/tags')) { return Response.json({ models: [{ name: 'neutral-model' }] }); }
                if (endpoint.endsWith('/api/show')) { return show(); }
                assert.ok(endpoint.endsWith('/api/generate'), 'only normal connection endpoints are used');
                const body = JSON.parse(String(init?.body));
                probes.push(body);
                assert.equal(body.system, ' ');
                assert.equal(body.options.temperature, 0);
                let response: string;
                if (body.prompt === '\n' + PLAIN_TEST_GENERATION_PROBE_PROMPT) {
                    assert.equal(body.format, undefined);
                    onWriter?.();
                    response = writerResponse;
                } else if (body.prompt === '\n' + REVIEWER_QUALIFICATION_PROMPT) {
                    assert.equal(body.format, 'json'); response = '{"findings":[]}';
                } else {
                    assert.equal(body.prompt, '\n' + BUG_FIXER_QUALIFICATION_PROMPT);
                    assert.equal(body.format, undefined); response = fixerResponse;
                }
                return Response.json({ response });
            };
            return probes;
        };
        const assertVerified = (numCtx: number, known: boolean) => {
            const profile = finalProfile();
            assert.equal(profile.testGenerationReady, true, 'the real fixed Python fixture must execute successfully');
            assert.deepEqual(Object.values(profile.roleQualification).map((role: any) => role.state), ['verified', 'verified', 'verified']);
            assert.equal(profile.contextLengthKnown, known);
            assert.deepEqual(profile.qualificationRuntime, { version: 'ollama-context-v1', numCtx });
            assert.equal(profile.endpointKey, qualificationEndpointKey('local', 'http://127.0.0.1:11434'));
            assert.equal(qualificationAppliesToRequest(profile, { envType: 'local', modelName: 'neutral-model',
                endpointKey: profile.endpointKey, runtimeContextTokens: numCtx }), true);
            assert.deepEqual(messages.filter(item => item.command === 'modelProbeResult').at(-1).profile, profile);
            assert.equal(errors.length, 0);
        };

        await t.test('automatic mode sends the same measured num_ctx to Writer, Reviewer and Bug Fixer', async () => {
            reset(); settings.set('runtimeContextTokens', 0);
            const probes = installTransport();
            await request();
            assert.deepEqual(probes.map(body => body.options.num_ctx), [5000, 5000, 5000]);
            assertVerified(5000, true);
            assert.equal(information.length, 1);
        });

        await t.test('configuration changes during generation cannot relabel the old probes as the new context', async () => {
            reset(); settings.set('runtimeContextTokens', 8192);
            const probes = installTransport(undefined, () => { settings.set('runtimeContextTokens', 16384); });
            await request();
            assert.deepEqual(probes.map(body => body.options.num_ctx), [8192, 8192, 8192]);
            assertVerified(8192, true);
            assert.equal(qualificationAppliesToRequest(finalProfile(), { envType: 'local', modelName: 'neutral-model',
                endpointKey: finalProfile().endpointKey, runtimeContextTokens: 16384 }), false);
            assert.equal(information.length, 0);
            assert.ok(warnings.some(message => message.includes('設定已變更')));
            reset();
            const nextProbes = installTransport();
            await request();
            assert.deepEqual(nextProbes.map(body => body.options.num_ctx), [16384, 16384, 16384]);
            assertVerified(16384, true);
        });

        await t.test('invalid explicit context and unavailable model limits stop before qualification transport', async () => {
            for (const scenario of [
                { setting: -1, show: () => Response.json(metadata) },
                { setting: 1.5, show: () => Response.json(metadata) },
                { setting: '8192', show: () => Response.json(metadata) },
                { setting: 32769, show: () => Response.json(metadata) },
                { setting: 8192, show: () => Response.json({ details: metadata.details }) },
                { setting: 8192, show: () => new Response('PRIVATE_PROVIDER_ERROR', { status: 500 }) },
                { setting: 8192, show: () => new Response('PRIVATE_INVALID_JSON', { status: 200 }) }
            ]) {
                reset(); settings.set('runtimeContextTokens', scenario.setting);
                const probes = installTransport(scenario.show);
                await request();
                assert.equal(probes.length, 0);
                assert.equal(finalProfile().testGenerationReady, false);
                assert.equal(finalProfile().qualificationRuntime, undefined, 'no unexecuted runtime receives qualification evidence');
                assert.ok(Object.values(finalProfile().roleQualification).every((role: any) => role.state !== 'verified'));
                assert.equal(information.length, 0);
                assert.ok(warnings.some(message => message.includes('Context 設定不可用')));
                assert.doesNotMatch(JSON.stringify({ messages, warnings, errors }), /PRIVATE_PROVIDER_ERROR|PRIVATE_INVALID_JSON/);
            }
        });

        await t.test('automatic metadata fallback is qualified by actual role probes, never by show success or failure alone', async () => {
            for (const show of [() => new Response('PRIVATE_PROVIDER_ERROR', { status: 500 }),
                () => new Response('PRIVATE_INVALID_JSON', { status: 200 })]) {
                reset(); settings.set('runtimeContextTokens', 0);
                const probes = installTransport(show);
                await request();
                assert.deepEqual(probes.map(body => body.options.num_ctx), [4096, 4096, 4096]);
                assertVerified(4096, false);
                assert.ok(messages.some(item => item.command === 'appendLog' && item.text.includes('自動保守值')));
                assert.doesNotMatch(JSON.stringify({ messages, warnings, errors }), /PRIVATE_PROVIDER_ERROR|PRIVATE_INVALID_JSON/);
            }
        });

        await t.test('generation transport failure preserves the attempted context without a successful role claim', async () => {
            reset(); settings.set('runtimeContextTokens', 8192);
            const probes = installTransport(undefined, () => { throw new Error('PRIVATE_TRANSPORT_FAILURE'); });
            await request();
            assert.equal(probes.length, 1);
            assert.equal(finalProfile().testGenerationReady, false);
            assert.deepEqual(finalProfile().qualificationRuntime, { version: 'ollama-context-v1', numCtx: 8192 });
            assert.ok(Object.values(finalProfile().roleQualification).every((role: any) => role.state !== 'verified'));
            assert.equal(information.length, 0);
            assert.ok(warnings.some(message => message.includes('角色探針未完成')));
            assert.doesNotMatch(JSON.stringify({ messages, warnings, errors }), /PRIVATE_TRANSPORT_FAILURE/);
        });

        await t.test('Cloud and Custom connection paths ignore an invalid local context setting', async () => {
            for (const envType of ['cloud', 'custom'] as const) {
                reset(); settings.set('runtimeContextTokens', 'invalid-local-only');
                const probes: any[] = [];
                globalThis.fetch = async (_url, init) => {
                    if (!init?.body) {
                        assert.equal(envType, 'cloud');
                        return Response.json({ models: [{ name: 'models/neutral-cloud', inputTokenLimit: 32768,
                            supportedGenerationMethods: ['generateContent'] }] });
                    }
                    const body = JSON.parse(String(init.body));
                    probes.push(body);
                    assert.equal(body.options, undefined, 'non-local transports never receive Ollama runtime options');
                    assert.equal(body.num_ctx, undefined);
                    const prompt = envType === 'cloud' ? body.contents[0].parts[0].text
                        : body.messages.find((item: any) => item.role === 'user').content;
                    const response = prompt === PLAIN_TEST_GENERATION_PROBE_PROMPT ? writerResponse
                        : prompt === REVIEWER_QUALIFICATION_PROMPT ? '{"findings":[]}' : fixerResponse;
                    assert.ok([PLAIN_TEST_GENERATION_PROBE_PROMPT, REVIEWER_QUALIFICATION_PROMPT,
                        BUG_FIXER_QUALIFICATION_PROMPT].includes(prompt));
                    return Response.json(envType === 'cloud'
                        ? { candidates: [{ content: { parts: [{ text: response }] } }] }
                        : { choices: [{ message: { content: response } }] });
                };
                await receive({ command: 'testConnection', envType, modelName: 'neutral-custom',
                    cloudKeyName: 'neutral', customUrl: 'https://fixture.invalid/chat/completions' });
                assert.equal(probes.length, 3);
                assert.equal(finalProfile().envType, envType);
                assert.equal(finalProfile().testGenerationReady, true);
                assert.deepEqual(Object.values(finalProfile().roleQualification).map((role: any) => role.state),
                    ['verified', 'verified', 'verified']);
                assert.equal(finalProfile().qualificationRuntime, undefined);
                assert.equal(errors.length, 0);
                assert.equal(warnings.length, 0);
                assert.equal(information.length, 1);
            }
        });
    } finally {
        Module._load = originalLoad;
        globalThis.fetch = originalFetch;
    }
});
