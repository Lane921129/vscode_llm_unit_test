import * as assert from 'node:assert/strict';
import { createServer, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { fetchModelResponse } from '../llm/modelTransport';
import { Agent } from 'undici';

type NativeTestAgent = Agent;

function createNativeTestAgent(options?: { headersTimeout?: number; bodyTimeout?: number }): NativeTestAgent {
    return new Agent(options);
}

// The host chooses its own Agent after async policy resolution. Production
// fetchModelResponse must not supply a caller dispatcher that bypasses it.
function hostFetch(agent: Agent): typeof fetch {
    return async (input, init) => {
        assert.equal('dispatcher' in (init || {}), false);
        await Promise.resolve();
        return fetch(input, { ...init, dispatcher: agent } as RequestInit);
    };
}

async function fixture(handler: (response: ServerResponse) => void): Promise<{ server: Server; url: string }> {
    const server = createServer((_request, response) => handler(response));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return { server, url: `http://127.0.0.1:${address.port}/generate` };
}

async function close(server: Server, agent: NativeTestAgent): Promise<void> {
    await agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('native HTTP transport tolerates delayed headers within the caller deadline', { timeout: 5000 }, async () => {
    let delayed: NodeJS.Timeout | undefined;
    const { server, url } = await fixture(response => {
        delayed = setTimeout(() => response.end('{"fixture":"headers"}'), 700);
    });
    const agent = createNativeTestAgent({ headersTimeout: 30, bodyTimeout: 30 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
        const response = await fetchModelResponse(url, { method: 'POST', body: '{}', signal: controller.signal }, {
            deadlineAt: Date.now() + 3000, fetcher: hostFetch(agent),
        });
        assert.deepEqual(await response.json(), { fixture: 'headers' });
    } finally {
        clearTimeout(timer);
        clearTimeout(delayed);
        await close(server, agent);
    }
});

test('native HTTP transport also keeps the allowance through a delayed complete response body', { timeout: 5000 }, async () => {
    let delayed: NodeJS.Timeout | undefined;
    const { server, url } = await fixture(response => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"fixture":');
        delayed = setTimeout(() => response.end('"body"}'), 700);
    });
    const agent = createNativeTestAgent({ headersTimeout: 30, bodyTimeout: 30 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
        const response = await fetchModelResponse(url, { signal: controller.signal }, {
            deadlineAt: Date.now() + 3000, fetcher: hostFetch(agent),
        });
        assert.deepEqual(await response.json(), { fixture: 'body' });
    } finally {
        clearTimeout(timer);
        clearTimeout(delayed);
        await close(server, agent);
    }
});

test('cancelling a native request waiting for headers closes the active connection', { timeout: 5000 }, async () => {
    let received!: () => void;
    let disconnected!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const { server, url } = await fixture(response => {
        response.once('close', disconnected);
        received();
    });
    const agent = createNativeTestAgent();
    const controller = new AbortController();
    try {
        const request = fetchModelResponse(url, { signal: controller.signal }, {
            deadlineAt: Date.now() + 30_000, fetcher: hostFetch(agent),
        });
        await started;
        controller.abort();
        await assert.rejects(request, { name: 'AbortError' });
        await closed;
    } finally { await close(server, agent); }
});

test('caller deadline still aborts a response body which keeps streaming', { timeout: 5000 }, async () => {
    let interval: NodeJS.Timeout | undefined;
    const { server, url } = await fixture(response => {
        response.write('start');
        interval = setInterval(() => response.write('chunk'), 10);
        response.once('close', () => clearInterval(interval));
    });
    const agent = createNativeTestAgent();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
        const response = await fetchModelResponse(url, { signal: controller.signal }, {
            deadlineAt: Date.now() + 200, fetcher: hostFetch(agent),
        });
        await assert.rejects(response.text(), { name: 'AbortError' });
    } finally {
        clearTimeout(timer);
        clearInterval(interval);
        await close(server, agent);
    }
});
