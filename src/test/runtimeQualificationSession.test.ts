import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    RuntimeQualificationIdentity, RuntimeQualificationSession, runtimeRoleAuthorization
} from '../llm/runtimeQualificationSession';
import { requalifyLocalRuntime, LocalRuntimeRequalificationResult } from '../llm/localRuntimeRequalification';
import { QUALIFICATION_VERSION } from '../llm/modelQualification';

const writer = ['import unittest', 'class TestIncrement(unittest.TestCase):',
    '    def test_positive(self):', '        self.assertEqual(increment(1), 2)',
    '    def test_negative(self):', '        self.assertEqual(increment(-1), 0)'].join('\n');
const identity: RuntimeQualificationIdentity = { endpointKey: 'endpoint-digest', modelName: 'fixture-model', numCtx: 9216,
    qualificationVersion: QUALIFICATION_VERSION, pythonIdentity: 'interpreter-env-digest', scopeIdentity: 'scope-fixture-digest' };
async function fixture(reviewer = '{"findings":[]}'): Promise<LocalRuntimeRequalificationResult> {
    return requalifyLocalRuntime({ numCtx: identity.numCtx,
        request: async role => role === 'reviewer' ? reviewer : writer, executor: async () => true });
}

test('same exact batch/runtime reuses successful or completed failed contracts with detached copies', async () => {
    for (const reviewer of ['{"findings":[]}', '{"findings":[{"category":"unrecognized"}]}']) {
        const session = new RuntimeQualificationSession('batch-one');
        const result = await fixture(reviewer);
        assert.equal(session.set(identity, result), true);
        result.roleQualification.writer.state = 'not-run';
        const cached = session.get(identity)!;
        assert.equal(cached.roleQualification.writer.state, 'verified');
        cached.roleQualification.reviewer.state = 'not-run';
        assert.equal(session.get(identity)!.roleQualification.reviewer.state,
            reviewer === '{"findings":[]}' ? 'verified' : 'unverified');
        assert.equal(session.get(identity, true), undefined, 'an unexecuted Bug Fixer probe cannot be borrowed');
        assert.equal(new RuntimeQualificationSession('batch-two').get(identity), undefined);
    }
});

test('all endpoint/model/capacity/version/Python/scope identity changes are misses, never normalized aliases', async () => {
    const session = new RuntimeQualificationSession('batch-one');
    assert.equal(session.set(identity, await fixture()), true);
    for (const key of ['endpointKey', 'modelName', 'qualificationVersion', 'pythonIdentity', 'scopeIdentity'] as const) {
        assert.equal(session.get({ ...identity, [key]: identity[key] + '-changed' }), undefined, key);
    }
    assert.equal(session.get({ ...identity, numCtx: 10240 }), undefined);
    assert.equal(session.get({ ...identity, modelName: identity.modelName.toUpperCase() }), undefined);
    assert.equal(session.get({ ...identity, pythonIdentity: '' }), undefined);
    assert.equal(session.set({ ...identity, numCtx: 10240 }, await fixture()), false);
    session.clear();
    assert.equal(session.size, 0);
});

test('transport/cancellation and execution unavailability never become reusable capability failures', async () => {
    const session = new RuntimeQualificationSession('batch-one');
    const interrupted = new Error('cancelled-or-transport');
    await assert.rejects(requalifyLocalRuntime({ numCtx: identity.numCtx, request: async () => { throw interrupted; } }),
        error => error === interrupted);
    assert.equal(session.size, 0);
    for (const execution of [false, { state: 'unavailable', reasonCode: 'probe-timeout' },
        { state: 'unavailable', reasonCode: 'probe-environment-unavailable' }] as const) {
        const result = await requalifyLocalRuntime({ numCtx: identity.numCtx,
            request: async role => role === 'reviewer' ? '{"findings":[]}' : writer, executor: async () => execution });
        assert.equal(result.roleQualification.writer.state, 'not-run');
        assert.equal(result.roleQualification.writer.diagnostics?.failureKind, 'unavailable');
        assert.equal(session.set(identity, result), false);
        assert.equal(session.get(identity), undefined);
        assert.equal(runtimeRoleAuthorization({ policy: 'manual', role: 'writer',
            qualification: result.roleQualification, currentIdentity: true }).allowed, false);
    }
});

test('a completed execution failure is reusable, while manual attempts do not approve candidate review or mutation', async () => {
    const session = new RuntimeQualificationSession('batch-one');
    const result = await requalifyLocalRuntime({ numCtx: identity.numCtx,
        request: async role => role === 'reviewer' ? '{"findings":[]}' : writer,
        executor: async () => ({ state: 'failed', reasonCode: 'probe-execution-failed' }) });
    assert.equal(result.roleQualification.writer.state, 'unverified');
    assert.equal(session.set(identity, result), true);
    assert.equal(session.get(identity)!.roleQualification.writer.diagnostics?.failureKind, 'execution');
    assert.equal(runtimeRoleAuthorization({ policy: 'auto', role: 'writer', qualification: result.roleQualification,
        currentIdentity: true }).allowed, false);
    const manual = runtimeRoleAuthorization({ policy: 'manual', role: 'writer', qualification: result.roleQualification,
        currentIdentity: true });
    assert.deepEqual(manual, { allowed: true, reasonCode: 'manual-unverified-attempt', roleState: 'unverified' });
    assert.equal(Object.hasOwn(manual, 'reviewApproved'), false);
    assert.equal(Object.hasOwn(manual, 'mutationAllowed'), false);
    assert.equal(runtimeRoleAuthorization({ policy: 'manual', role: 'writer', qualification: result.roleQualification,
        currentIdentity: false }).allowed, false);
});

test('Auto and manual authorize only their current role instead of unrelated future Reviewer availability', async () => {
    const result = await fixture('not-json');
    assert.equal(runtimeRoleAuthorization({ policy: 'auto', role: 'writer', qualification: result.roleQualification,
        currentIdentity: true }).allowed, true);
    assert.equal(runtimeRoleAuthorization({ policy: 'auto', role: 'reviewer', qualification: result.roleQualification,
        currentIdentity: true }).allowed, false);
    assert.equal(runtimeRoleAuthorization({ policy: 'manual', role: 'reviewer', qualification: result.roleQualification,
        currentIdentity: true }).allowed, true);
});

test('cache copies only safe assessment fields and discards unknown raw provider extensions', async () => {
    const session = new RuntimeQualificationSession('batch-one');
    const result = await fixture();
    const rawMarker = 'private-provider-response-must-not-be-stored';
    Object.assign(result, { responsePreview: rawMarker, rawProvider: rawMarker });
    Object.assign(result.roleQualification.reviewer, { response: rawMarker });
    Object.assign(result.roleQualification.reviewer.diagnostics!.responseShape, { unknownKey: rawMarker });
    assert.equal(session.set(identity, result), true);
    assert.equal(JSON.stringify(session.get(identity)).includes(rawMarker), false);
});

test('optional unavailable Fixer does not repeat completed Writer/Reviewer and cannot overwrite completed Fixer evidence', async () => {
    const session = new RuntimeQualificationSession('batch-one');
    const fixer = '```python\ndef test_increment(self):\n    self.assertEqual(increment(1), 2)\n```';
    const qualify = (unavailable: boolean) => requalifyLocalRuntime({ numCtx: identity.numCtx, includeBugFixer: true,
        request: async role => role === 'writer' ? writer : role === 'reviewer' ? '{"findings":[]}' : fixer,
        executor: async code => unavailable && code.includes('class TestRepair')
            ? { state: 'unavailable', reasonCode: 'probe-timeout' } : { state: 'passed', reasonCode: 'probe-passed' } });
    assert.equal(session.set(identity, await qualify(true)), true);
    assert.equal(session.get(identity)!.roleQualification.writer.state, 'verified');
    assert.equal(session.get(identity)!.roleQualification.reviewer.state, 'verified');
    assert.equal(session.get(identity)!.roleQualification.bugFixer.state, 'not-run');
    assert.equal(session.get(identity)!.roleQualification.bugFixer.diagnostics?.reasonCode, 'bug-fixer-not-run');
    assert.equal(session.get(identity, true), undefined);
    assert.equal(runtimeRoleAuthorization({ policy: 'manual', role: 'bugFixer',
        qualification: session.get(identity)!.roleQualification, currentIdentity: true }).allowed, false);
    assert.equal(session.set(identity, await qualify(false)), true);
    assert.equal(session.get(identity, true)!.roleQualification.bugFixer.state, 'verified');
    assert.equal(session.set(identity, await qualify(true)), true);
    assert.equal(session.get(identity, true)!.roleQualification.bugFixer.state, 'verified');
    assert.equal(session.set(identity, await fixture()), true);
    assert.equal(session.get(identity, true)!.roleQualification.bugFixer.state, 'verified');
});
