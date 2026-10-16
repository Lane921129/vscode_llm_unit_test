import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

type Provider = 'local' | 'custom' | 'cloud';
type Format = 'text' | 'semantic-json' | 'review-json' | 'quality-json';
interface RoleCase { role: string; format: Format; reply: string; output: number; rootField?: string }
interface Timing { kind: string; phase?: string; outcome?: string; ollama?: { done: boolean | null; completionReason: string | null } }
interface TestExecution { cancel(): void }
interface MatrixApi {
    request(params: Record<string, unknown>, system: string, user: string, log: (text: string) => void,
        format: Format, deadline?: number, timing?: (event: Timing) => void): Promise<string>;
    execution: new (snapshot: unknown) => TestExecution;
    run<T>(execution: TestExecution, operation: () => T): T;
    language(value: 'en'): void;
}
interface WireRequest { url: string; init: RequestInit; body: Record<string, any> }
const providers: Provider[] = ['local', 'custom', 'cloud'];
const roles: RoleCase[] = [
    { role: 'analyst-planning', format: 'semantic-json', output: 1024, rootField: 'test_strategy',
        reply: JSON.stringify({ test_strategy: { approach: 'Compare exact observed values for the selected target.',
            input_hints: [], assertion_style: 'assertEqual', mock_needed: false, key_rules: [] } }) },
    { role: 'writer', format: 'text', output: 1536,
        reply: 'import unittest\nfrom sample import target\nclass Cases(unittest.TestCase):\n'
            + '    def test_value(self):\n        self.assertEqual(target(1), 2)\n' },
    { role: 'reviewer', format: 'review-json', output: 1024, rootField: 'findings', reply: '{"findings":[]}' },
    { role: 'bug-fixer', format: 'text', output: 2048,
        reply: 'def test_value(self):\n    self.assertEqual(target(1), 2)\n' },
    { role: 'analyst-quality', format: 'quality-json', output: 1024, rootField: 'tasks', reply: '{"tasks":[]}' }
];
const fixtureKey = 'matrix-fixture-key';
const privateMarker = 'PRIVATE_MATRIX_PROVIDER_METADATA';

/** Export a private entry point only in this in-memory test bundle. The real
 * adapter, parsers, queue and AsyncLocalStorage remain one production instance. */
function loadTransport(): MatrixApi {
    const root = path.resolve(process.cwd());
    const filename = path.join(root, 'src/orchestrator.ts');
    const bundle = buildSync({ stdin: { contents: fs.readFileSync(filename, 'utf8')
        + '\nexport { requestLlmApi as __matrixRequest };'
        + '\nexport { ExecutionContext as __matrixExecution, runInExecution as __matrixRun } from "./pipeline/executionContext";'
        + '\nexport { setLanguage as __matrixLanguage } from "./i18n/core";',
    resolveDir: path.dirname(filename), sourcefile: filename, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'], logLevel: 'silent' });
    const Module = require('node:module');
    const originalLoad = Module._load;
    const instance = new Module(path.join(root, 'src/test/.role-transport-memory.cjs'), module);
    instance.paths = Module._nodeModulePaths(root);
    Module._load = function (name: string, ...args: any[]) {
        return name === 'vscode' ? { workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
            key === 'cloudThinkingMode' ? 'provider-default' : fallback }) } } : originalLoad.call(this, name, ...args);
    };
    try { instance._compile(bundle.outputFiles[0].text, filename); }
    finally { Module._load = originalLoad; }
    return { request: instance.exports.__matrixRequest, execution: instance.exports.__matrixExecution,
        run: instance.exports.__matrixRun, language: instance.exports.__matrixLanguage };
}

function params(provider: Provider, role: RoleCase): Record<string, unknown> {
    return { envType: provider, modelName: 'neutral-matrix-model', ollamaUrl: 'http://matrix.invalid:11434',
        customUrl: 'https://matrix.invalid/v1/chat/completions', customKey: fixtureKey, cloudKey: fixtureKey,
        requestContextTokens: 8192, requestOutputTokens: role.output, timeoutSeconds: 30 };
}
const prompts = (role: RoleCase) => ({ system: `SYSTEM_SENTINEL_${role.role}`,
    user: `USER_SENTINEL_${role.role}\nEvidence is complete: 測試.\nKeep this final line.\n` });
function successfulResponse(provider: Provider, reply: string, finish = 'stop'): Response {
    if (provider === 'local') {
        const middle = Math.floor(reply.length / 2);
        const records = [{ response: reply.slice(0, middle), done: false, thinking: privateMarker },
            { response: reply.slice(middle), done: false },
            { response: '', done: true, done_reason: finish, eval_count: 10, prompt_eval_count: 20,
                eval_duration: 30_000_000, total_duration: 40_000_000, model: privateMarker }];
        const bytes = new TextEncoder().encode(records.map(record => JSON.stringify(record)).join('\n') + '\n');
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            // Split a UTF-8 character when available, not just an NDJSON record.
            const unicode = bytes.findIndex(byte => byte >= 0x80);
            const cut = unicode >= 0 ? unicode + 1 : Math.floor(bytes.length / 3);
            controller.enqueue(bytes.slice(0, cut)); controller.enqueue(bytes.slice(cut)); controller.close();
        } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    return Response.json(provider === 'custom'
        ? { choices: [{ finish_reason: finish, message: { content: reply } }], private_metadata: privateMarker }
        : { candidates: [{ finishReason: finish === 'stop' ? 'STOP' : 'MAX_TOKENS',
            content: { parts: [{ text: privateMarker, thought: true }, { text: reply }] } }] });
}
function inspectWire(provider: Provider, role: RoleCase, wire: WireRequest, structured = true): void {
    const prompt = prompts(role), body = wire.body;
    assert.equal(wire.init.method, 'POST');
    assert.ok(wire.init.signal instanceof AbortSignal, 'the adapter owns a cancellation signal');
    if (provider === 'local') {
        assert.equal(wire.url, 'http://matrix.invalid:11434/api/generate');
        assert.equal(body.model, 'neutral-matrix-model');
        assert.equal(body.stream, true);
        assert.equal(body.system, ' ', 'Modelfile SYSTEM must not duplicate or replace the role instructions');
        assert.equal(body.options.num_ctx, 8192);
        assert.equal(body.options.num_predict, role.output);
        assert.equal(body.options.temperature, 0);
        assert.ok(body.prompt.startsWith(prompt.system));
        assert.ok(body.prompt.endsWith('\n' + prompt.user));
        assert.equal(body.prompt.split(prompt.system).length - 1, 1);
        if (structured && role.rootField) {
            assert.equal(body.format.type, 'object');
            assert.ok(body.format.required.includes(role.rootField));
        } else { assert.equal(body.format, undefined); }
    } else if (provider === 'custom') {
        assert.equal(wire.url, 'https://matrix.invalid/v1/chat/completions');
        assert.equal(body.model, 'neutral-matrix-model');
        assert.equal(body.messages.length, 2);
        assert.equal(body.messages[0].role, 'system'); assert.ok(body.messages[0].content.startsWith(prompt.system));
        assert.deepEqual(body.messages[1], { role: 'user', content: prompt.user });
        assert.equal(new Headers(wire.init.headers).get('Authorization'), `Bearer ${fixtureKey}`);
        assert.deepEqual(body.response_format, structured && role.rootField ? { type: 'json_object' } : undefined);
    } else {
        assert.equal(wire.url, 'https://generativelanguage.googleapis.com/v1beta/models/neutral-matrix-model:generateContent');
        assert.equal(new Headers(wire.init.headers).get('x-goog-api-key'), fixtureKey);
        assert.ok(!wire.url.includes(fixtureKey));
        const text = body.contents[0].parts[0].text;
        assert.ok(text.startsWith(prompt.system)); assert.ok(text.endsWith('\n\n' + prompt.user));
        assert.equal(text.split(prompt.system).length - 1, 1);
        if (structured && role.rootField) {
            assert.equal(body.generationConfig.responseMimeType, 'application/json');
            assert.ok(body.generationConfig.responseSchema.required.includes(role.rootField));
        } else { assert.equal(body.generationConfig?.responseSchema, undefined); }
    }
}

test('all formal roles preserve their complete wire contract across Local, Custom and Cloud', async t => {
    const api = loadTransport(), originalFetch = globalThis.fetch;
    api.language('en');
    try {
        for (const provider of providers) {
            for (const role of roles) {
                await t.test(`${provider}/${role.role}: completed response`, async () => {
                    const wires: WireRequest[] = [], timing: Timing[] = [];
                    globalThis.fetch = async (url, init) => {
                        wires.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
                        return successfulResponse(provider, role.reply);
                    };
                    const prompt = prompts(role);
                    assert.equal(await api.request(params(provider, role), prompt.system, prompt.user, () => {},
                        role.format, undefined, event => timing.push(event)), role.reply);
                    assert.equal(wires.length, 1, 'a role response is not accidentally resent or reinterpreted');
                    inspectWire(provider, role, wires[0]);
                    const completed = timing.filter(event => event.kind === 'transport' && event.outcome === 'completed');
                    assert.equal(completed.length, 1);
                    if (provider === 'local') {
                        assert.equal(completed[0].ollama?.done, true);
                        assert.equal(completed[0].ollama?.completionReason, 'stop');
                    }
                    assert.ok(!JSON.stringify(timing).includes(privateMarker));
                });
                await t.test(`${provider}/${role.role}: output limit is never accepted as completion`, async () => {
                    let calls = 0;
                    globalThis.fetch = async () => { calls++; return successfulResponse(provider, role.reply, 'length'); };
                    const prompt = prompts(role);
                    await assert.rejects(api.request(params(provider, role), prompt.system, prompt.user, () => {}, role.format),
                        (error: any) => error.category === 'model-format' && !error.message.includes(privateMarker));
                    assert.equal(calls, 1, 'unfinished output cannot silently trigger a text retry or become a candidate');
                });
                await t.test(`${provider}/${role.role}: HTTP failure is not parsed as role output`, async () => {
                    let calls = 0, reads = 0, cancellations = 0;
                    globalThis.fetch = async () => {
                        calls++;
                        return { ok: false, status: 401, json: async () => { reads++; throw new Error(privateMarker); },
                            body: { cancel: async () => { cancellations++; } } } as unknown as Response;
                    };
                    const prompt = prompts(role);
                    await assert.rejects(api.request(params(provider, role), prompt.system, prompt.user, () => {}, role.format),
                        (error: any) => error.category === 'model-api' && error.diagnostic.httpStatus === 401
                            && !error.message.includes(privateMarker));
                    assert.equal(calls, 1); assert.equal(reads, 0); assert.equal(cancellations, 1);
                });
            }
        }
        for (const provider of providers) {
            for (const role of roles.filter(item => item.rootField)) {
                await t.test(`${provider}/${role.role}: explicit unsupported-format fallback preserves both prompts`, async () => {
                    const wires: WireRequest[] = [];
                    globalThis.fetch = async (url, init) => {
                        wires.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
                        return wires.length === 1 ? new Response('', { status: 422 }) : successfulResponse(provider, role.reply);
                    };
                    const prompt = prompts(role);
                    assert.equal(await api.request(params(provider, role), prompt.system, prompt.user, () => {}, role.format), role.reply);
                    assert.equal(wires.length, 2);
                    inspectWire(provider, role, wires[0]); inspectWire(provider, role, wires[1], false);
                });
            }
        }
        await t.test('a Local prefix without done cannot satisfy even a valid role JSON contract', async () => {
            globalThis.fetch = async () => new Response(JSON.stringify({ response: roles[2].reply, done: false }) + '\n',
                { headers: { 'Content-Type': 'application/x-ndjson' } });
            const prompt = prompts(roles[2]);
            await assert.rejects(api.request(params('local', roles[2]), prompt.system, prompt.user, () => {}, 'review-json'),
                (error: any) => error.category === 'model-format');
        });
        await t.test('all roles share the queue until the active body reaches terminal and EOF', async () => {
            let firstBody!: ReadableStreamDefaultController<Uint8Array>, ready!: () => void;
            const started = new Promise<void>(resolve => { ready = resolve; });
            let calls = 0;
            globalThis.fetch = async () => {
                calls++;
                if (calls === 1) {
                    return new Response(new ReadableStream<Uint8Array>({ start(controller) { firstBody = controller; ready(); } }),
                        { headers: { 'Content-Type': 'application/x-ndjson' } });
                }
                return successfulResponse('custom', roles[2].reply);
            };
            const writer = prompts(roles[1]), reviewer = prompts(roles[2]);
            const first = api.request(params('local', roles[1]), writer.system, writer.user, () => {}, 'text');
            await started;
            const second = api.request(params('custom', roles[2]), reviewer.system, reviewer.user, () => {}, 'review-json');
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(calls, 1, 'a different provider/role must not bypass the common queue');
            firstBody.enqueue(new TextEncoder().encode(JSON.stringify({ response: roles[1].reply, done: true, done_reason: 'stop' }) + '\n'));
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(calls, 1, 'terminal alone does not release an unread response body');
            firstBody.close();
            assert.deepEqual(await Promise.all([first, second]), [roles[1].reply, roles[2].reply]);
            assert.equal(calls, 2);
        });
        await t.test('queued and active role cancellation stay bound to their execution context', async () => {
            const active = new api.execution({}), queued = new api.execution({});
            let ready!: () => void, calls = 0, aborts = 0;
            const started = new Promise<void>(resolve => { ready = resolve; });
            globalThis.fetch = async (_url, init) => {
                calls++;
                return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                    init!.signal!.addEventListener('abort', () => { aborts++; controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
                    ready();
                } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
            };
            const prompt = prompts(roles[1]);
            const first = api.run(active, () => api.request(params('local', roles[1]), prompt.system, prompt.user, () => {}, 'text'));
            const firstRejected = assert.rejects(first, /cancel|中止/i);
            await started;
            const second = api.run(queued, () => api.request(params('local', roles[2]), prompt.system, prompt.user, () => {}, 'review-json'));
            const secondRejected = assert.rejects(second, /cancel|中止/i);
            queued.cancel(); await secondRejected;
            assert.equal(calls, 1, 'cancelled queue entries cannot send HTTP');
            active.cancel(); await firstRejected;
            assert.equal(aborts, 1);
            globalThis.fetch = async () => { calls++; return successfulResponse('local', roles[2].reply); };
            assert.equal(await api.request(params('local', roles[2]), prompt.system, prompt.user, () => {}, 'review-json'), roles[2].reply);
            assert.equal(calls, 2, 'the queue remains reusable after cancellation drains');
        });
        await t.test('a shared deadline reports its effective response-read allowance instead of the configured request limit', async () => {
            let signal: AbortSignal | null | undefined;
            globalThis.fetch = async (_url, init) => {
                signal = init?.signal;
                return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                    signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
                } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
            };
            const prompt = prompts(roles[2]), start = Date.now(), allowance = 120;
            await assert.rejects(api.request(params('local', roles[2]), prompt.system, prompt.user, () => {}, 'review-json', start + allowance),
                (error: any) => {
                    assert.equal(error.category, 'timeout');
                    assert.equal(error.diagnostic.phase, 'response-read');
                    assert.ok(error.diagnostic.requestAllowanceMs > 0 && error.diagnostic.requestAllowanceMs <= allowance);
                    assert.equal(error.diagnostic.configuredRequestAllowanceMs, 30_000);
                    assert.match(error.message, /effective deadline|有效期限/);
                    assert.doesNotMatch(error.message, /30 (?:seconds? total|秒總時限)/);
                    const effective = (error.diagnostic.requestAllowanceMs / 1000).toFixed(3);
                    assert.ok(error.message.includes(effective));
                    return true;
                });
            assert.equal(signal?.aborted, true);
            assert.ok(Date.now() - start < 2_000, 'the shared deadline must not become a fresh 30 second timer');
        });
    } finally { globalThis.fetch = originalFetch; }
});
