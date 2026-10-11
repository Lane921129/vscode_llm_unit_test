import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { requalifyLocalRuntime, LocalRequalificationRole } from '../llm/localRuntimeRequalification';
import { LOCAL_RUNTIME_QUALIFICATION_VERSION, QUALIFICATION_VERSION, qualificationAppliesToRequest } from '../llm/modelQualification';
import { runIsolatedProbe } from '../llm/modelProbeExecution';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';

const writer = ['import unittest', 'class TestIncrement(unittest.TestCase):',
    '    def test_positive(self):', '        self.assertEqual(increment(1), 2)',
    '    def test_negative(self):', '        self.assertEqual(increment(-1), 0)'].join('\n');
const fixer = '```python\ndef test_increment(self):\n    self.assertEqual(increment(1), 2)\n```';
const responseFor = (role: LocalRequalificationRole) => role === 'writer' ? writer
    : role === 'reviewer' ? '{"findings":[]}' : fixer;

test('new runtime qualifications require independent Writer and Reviewer probes plus real isolated execution', async () => {
    const calls: Array<{ role: LocalRequalificationRole; format: string }> = [];
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    let executions = 0;
    const profile = await requalifyLocalRuntime({ numCtx: 16384, includeBugFixer: true,
        request: async (role, system, prompt, format) => {
            calls.push({ role, format });
            assert.equal(system, '');
            assert.ok(role === 'writer' ? prompt.includes('A safe runtime already provides increment(value)')
                : role === 'reviewer' ? prompt.includes('Review this exact TEST_FILE')
                : prompt.includes('Repair only the named failing method test_increment'));
            return responseFor(role);
        }, executor: async code => { executions++; return runIsolatedProbe(code, 5000, python); }
    });
    assert.deepEqual(calls, [{ role: 'writer', format: 'text' }, { role: 'reviewer', format: 'json' },
        { role: 'bug-fixer', format: 'text' }]);
    assert.equal(executions, 2);
    assert.deepEqual(profile.qualificationRuntime, { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 16384 });
    assert.equal(profile.qualificationVersion, QUALIFICATION_VERSION);
    assert.equal(profile.testGenerationMode, 'plain');
    assert.equal(profile.testGenerationReady, true);
    assert.ok(Object.values(profile.roleQualification).every(role => role.state === 'verified'));
    const identified = { ...profile, envType: 'local' as const, modelName: 'fixture-model', endpointKey: 'fixture-endpoint' };
    assert.equal(qualificationAppliesToRequest(identified, { envType: 'local', modelName: 'fixture-model',
        endpointKey: 'fixture-endpoint', runtimeContextTokens: 16384 }), true);
    assert.equal(qualificationAppliesToRequest(identified, { envType: 'local', modelName: 'fixture-model',
        endpointKey: 'fixture-endpoint', runtimeContextTokens: 8192 }), false);
    assert.equal(JSON.stringify(profile).includes('responsePreview'), false);
    assert.equal(JSON.stringify(profile).includes(writer), false);
});

test('a context change never borrows Bug Fixer evidence when that probe was not requested', async () => {
    const roles: LocalRequalificationRole[] = [];
    const profile = await requalifyLocalRuntime({ numCtx: 12288,
        request: async role => { roles.push(role); return responseFor(role); }, executor: async () => true });
    assert.deepEqual(roles, ['writer', 'reviewer']);
    assert.equal(profile.roleQualification.bugFixer.state, 'not-run');
});

test('invalid or non-executable Writer replies and invalid Reviewer contracts cannot certify full roles', async () => {
    for (const [reply, executionPassed] of [[writer.replace('increment(-1), 0', '0, 0'), true],
        [writer + '\nopen("forbidden", "w")', true], [writer, false]] as const) {
        let executions = 0;
        const profile = await requalifyLocalRuntime({ numCtx: 16384,
            request: async role => role === 'writer' ? reply : '{"findings":[]}',
            executor: async () => { executions++; return executionPassed; } });
        assert.equal(profile.testGenerationReady, false);
        assert.equal(profile.roleQualification.writer.state, 'unverified');
        assert.equal(executions, reply === writer ? 1 : 0);
    }
    const profile = await requalifyLocalRuntime({ numCtx: 16384,
        request: async role => role === 'reviewer' ? 'approved without a review contract' : responseFor(role),
        executor: async () => true });
    assert.equal(profile.roleQualification.writer.state, 'verified');
    assert.equal(profile.roleQualification.reviewer.state, 'unverified');
});

test('Bug Fixer renewal rejects weakened and changed-input replies before isolated execution', async () => {
    let executions = 0;
    const profile = await requalifyLocalRuntime({ numCtx: 16384, includeBugFixer: true,
        request: async role => role === 'bug-fixer' ? fixer.replace('increment(1), 2', 'increment(-1), 0') : responseFor(role),
        executor: async () => { executions++; return true; } });
    assert.equal(executions, 1);
    assert.equal(profile.roleQualification.bugFixer.state, 'unverified');
});

test('qualification requests and isolated executors propagate control-flow exceptions unchanged', async () => {
    for (const failedRole of ['writer', 'reviewer', 'bug-fixer'] as const) {
        const failure = new Error('target-budget-or-cancellation');
        const calls: LocalRequalificationRole[] = [];
        await assert.rejects(requalifyLocalRuntime({ numCtx: 16384, includeBugFixer: true,
            request: async role => { calls.push(role); if (role === failedRole) { throw failure; } return responseFor(role); },
            executor: async () => true }), error => error === failure);
        assert.equal(calls.at(-1), failedRole);
    }
    const failure = new Error('isolated-execution-deadline');
    await assert.rejects(requalifyLocalRuntime({ numCtx: 16384, request: async role => responseFor(role),
        executor: async () => { throw failure; } }), error => error === failure);
});

test('invalid runtime capacities fail before any model request or Python execution', async () => {
    for (const numCtx of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(requalifyLocalRuntime({ numCtx,
            request: async () => { assert.fail('invalid capacity must not request a model'); },
            executor: async () => { assert.fail('invalid capacity must not execute code'); } }), /invalid-runtime-context/);
    }
});
