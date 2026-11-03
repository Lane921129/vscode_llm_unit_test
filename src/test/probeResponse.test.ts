import * as assert from 'assert';
import { test } from 'node:test';
import { requireSuccessfulProbeResponse } from '../llm/probeResponse';

test('failed plain retry reports its own status after the first body was consumed', async () => {
    const first = new Response('{"invalid":true}', { status: 200 });
    await first.json();
    const retry = new Response('quota exhausted', { status: 429 });
    await assert.rejects(requireSuccessfulProbeResponse(retry), /HTTP 429 - quota exhausted/);
});

test('successful probe keeps its body available for qualification', async () => {
    const response = new Response('{"code":"fixture"}');
    await requireSuccessfulProbeResponse(response);
    assert.deepStrictEqual(await response.json(), { code: 'fixture' });
});
