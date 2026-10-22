import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifyLocalConnection, QualificationRequestError, ConnectionProbeEvent, unprobedLocalQualification } from '../llm/connectionQualification';
import { runtimeRoleAuthorization } from '../llm/runtimeQualificationSession';
import { buildOllamaRoleQualificationProbe, requestOllamaQualification } from '../llm/ollamaCapability';
import { getWebviewContent } from '../ui/webviewContent';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatModelQualificationLog } from '../llm/modelQualification';
import { getLanguage, setLanguage } from '../i18n/core';

const writer = 'import unittest\nclass Tests(unittest.TestCase):\n    def test_positive(self):\n        self.assertEqual(increment(1), 2)\n    def test_negative(self):\n        self.assertEqual(increment(-1), 0)\n';
const passed = async () => ({ state: 'passed' as const, reasonCode: 'probe-passed' as const });

test('qualification is off by default in settings and the sidebar can explicitly opt in', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    assert.equal(manifest.contributes.configuration.properties['llmUnitTest.requireRoleQualification'].default, false);
    for (const required of [false, true]) {
        const html = getWebviewContent(key => key, 'en', 'full', undefined, 'full', 'builtin', 2, required);
        const checkbox = html.match(/<input[^>]*id="require-role-qualification"[^>]*>/)![0];
        assert.equal(checkbox.includes('checked'), required);
    }
});

test('an incomplete probe is undetermined rather than a failed model capability', () => {
    const result = unprobedLocalQualification(8192);
    const language = getLanguage();
    try {
        setLanguage('en');
        const log = formatModelQualificationLog({ ...result, envType: 'local', modelName: 'neutral' });
        assert.match(log, /probe did not complete/);
        assert.match(log, /capability is undetermined/);
        assert.doesNotMatch(log, /failed|plain-python|未完成/);
    } finally { setLanguage(language); }
});

test('connection probes keep separate role and execution evidence without exposing responses', async () => {
    const events: ConnectionProbeEvent[] = [], calls: string[] = [];
    let executions = 0;
    const result = await qualifyLocalConnection({ numCtx: 8192, timeoutMs: 300000,
        request: async role => { calls.push(role); return role === 'writer' ? writer : role === 'reviewer'
            ? '{"findings":[]}' : '```python\ndef test_increment(self):\n    self.assertEqual(increment(1), 2)\n```'; },
        execute: async () => { executions++; return passed(); }, onEvent: event => events.push(event) });
    assert.deepEqual(calls, ['writer', 'reviewer', 'bugFixer']);
    assert.equal(executions, 2);
    assert.ok(Object.values(result.roleQualification).every(role => role.state === 'verified'));
    assert.ok(events.every(event => event.timeoutMs === 300000 && event.elapsedMs >= 0));
    assert.equal(events.filter(event => event.status === 'completed').length, 3);
    assert.doesNotMatch(JSON.stringify(events), /assertEqual|findings|PRIVATE_PROVIDER/);
});

test('timeout and output truncation stop remaining probes and never mark unexecuted roles as failures', async () => {
    for (const reason of ['timeout', 'output-limit', 'cancelled'] as const) {
        let calls = 0, executions = 0;
        const result = await qualifyLocalConnection({ numCtx: 8192, timeoutMs: 600000,
            request: async () => { calls++; throw new QualificationRequestError(reason); },
            execute: async () => { executions++; return passed(); } });
        assert.equal(calls, 1); assert.equal(executions, 0);
        assert.equal(result.testGenerationReady, false);
        assert.equal(result.roleQualification.writer.diagnostics?.reasonCode, reason);
        assert.deepEqual(Object.values(result.roleQualification).map(role => role.state), ['not-run', 'not-run', 'not-run']);
    }
});

test('a Reviewer transport failure preserves a completed Writer and leaves the Fixer untested', async () => {
    const events: ConnectionProbeEvent[] = [];
    const result = await qualifyLocalConnection({ numCtx: 8192, timeoutMs: 180000,
        request: async role => { if (role === 'writer') { return writer; } throw new QualificationRequestError('http', 503); },
        execute: passed, onEvent: event => events.push(event) });
    assert.equal(result.roleQualification.writer.state, 'verified');
    assert.equal(result.roleQualification.reviewer.state, 'not-run');
    assert.equal(result.roleQualification.bugFixer.state, 'not-run');
    assert.equal(events.at(-1)?.httpStatus, 503);
});

test('a contract failure explains the rejection and stops additional role requests', async () => {
    let requests = 0;
    const events: ConnectionProbeEvent[] = [];
    const result = await qualifyLocalConnection({ numCtx: 8192, timeoutMs: 60000,
        request: async () => { requests++; return 'not a test'; }, execute: passed, onEvent: event => events.push(event) });
    assert.equal(requests, 1);
    assert.equal(result.roleQualification.writer.state, 'unverified');
    assert.equal(result.roleQualification.reviewer.state, 'not-run');
    assert.equal(events.at(-1)?.reasonCode, 'writer-generation-contract');
    assert.ok(events.at(-1)?.reason);
});

test('optional policy permits an unqualified attempt without creating verified evidence or bypassing identity', () => {
    const qualification = unprobedLocalQualification(16384).roleQualification;
    assert.equal(runtimeRoleAuthorization({ policy: 'optional', role: 'reviewer', qualification, currentIdentity: true }).allowed, true);
    assert.equal(runtimeRoleAuthorization({ policy: 'auto', role: 'reviewer', qualification, currentIdentity: true }).allowed, false);
    assert.equal(runtimeRoleAuthorization({ policy: 'optional', role: 'reviewer', qualification, currentIdentity: false }).allowed, false);
    assert.equal(qualification.reviewer.state, 'not-run');
});

test('all Ollama role probes have a fixed output cap, distinguish HTTP rejection and bound abort-ignoring transports', async () => {
    const body = buildOllamaRoleQualificationProbe('neutral', 'fixed sample', 'text', 8192);
    assert.equal(body.options.num_predict, 1024);
    await assert.rejects(requestOllamaQualification('http://localhost:11434', body, 1000,
        async () => new Response('PRIVATE_PROVIDER_RESPONSE', { status: 500 })),
    (error: unknown) => error instanceof QualificationRequestError && error.reasonCode === 'http'
        && error.httpStatus === 500 && !JSON.stringify(error).includes('PRIVATE_PROVIDER_RESPONSE'));
    await assert.rejects(requestOllamaQualification('http://localhost:11434', body, 20,
        async () => new Promise<Response>(() => {})),
    (error: unknown) => error instanceof QualificationRequestError && error.reasonCode === 'timeout');
    const abort = new AbortController(); abort.abort();
    let requests = 0;
    await assert.rejects(requestOllamaQualification('http://localhost:11434', body, 1000,
        async () => { requests++; return Response.json({ response: 'ignored' }); }, abort.signal),
    (error: unknown) => error instanceof QualificationRequestError && error.reasonCode === 'cancelled');
    assert.equal(requests, 0);
});
