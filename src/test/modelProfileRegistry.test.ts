import { LOCAL_RUNTIME_QUALIFICATION_VERSION, QUALIFICATION_VERSION } from '../llm/modelQualification';
import * as assert from 'assert';
import { test } from 'node:test';
import { findModelProfile, modelProfileKey, qualificationForSelectedProfile, restoreModelProfiles, upsertModelProfile } from '../llm/modelProfileRegistry';
import { selectAnalysisResponseFormat, selectTestGenerationResponseFormat } from '../llm/modelQualification';

const localProfile = {
    envType: 'local' as const,
    modelName: 'reliable-instruct',
    paramSize: '8B',
    contextLength: 8192,
    contextLengthKnown: true,
    qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 8192 } as const,
    qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true,
    testGenerationReason: '模型已通過行為 assertion 驗證。',
    testGenerationMode: '結構化 JSON unittest'
};

test('keeps qualification metadata for multiple provider/model pairs', () => {
    const profiles = upsertModelProfile([localProfile], {
        envType: 'cloud',
        modelName: 'models/gemma-4-31b-it',
        paramSize: 'Cloud',
        contextLength: 1000000,
        qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true
    });

    assert.strictEqual(findModelProfile(profiles, {
        envType: 'local', modelName: 'reliable-instruct'
    })?.testGenerationReady, true);
    assert.strictEqual(findModelProfile(profiles, {
        envType: 'local', modelName: 'reliable-instruct'
    })?.testGenerationMode, '結構化 JSON unittest');
    assert.strictEqual(findModelProfile(profiles, {
        envType: 'cloud', modelName: 'gemma-4-31b-it'
    })?.testGenerationReady, true);
});

test('replaces only the probe result for the same model', () => {
    const first = upsertModelProfile([], localProfile);
    const updated = upsertModelProfile(first, { ...localProfile, qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: false });
    assert.strictEqual(updated.length, 1);
    assert.strictEqual(updated[0].testGenerationReady, false);
});

test('restores only valid non-secret model metadata', () => {
    const restored = restoreModelProfiles([
        localProfile,
        { envType: 'local', modelName: '', paramSize: '8B', contextLength: 8192 },
        { envType: 'cloud', modelName: 'bad', paramSize: 'Cloud', contextLength: 'many' }
    ]);
    assert.deepStrictEqual(restored, [localProfile]);
    assert.strictEqual(modelProfileKey({ envType: 'cloud', modelName: 'models/GEMMA-4-31B-IT' }),
        modelProfileKey({ envType: 'cloud', modelName: 'gemma-4-31b-it' }));
});

test('expires pre-provenance qualification results while retaining the saved model selection', () => {
    const old = { ...localProfile, qualificationVersion: 'python-unittest-v6' };
    const restored = restoreModelProfiles([old]);
    assert.strictEqual(restored[0].testGenerationReady, false);
    assert.strictEqual(restored[0].modelName, localProfile.modelName);
    assert.strictEqual(restored[0].contextLength, localProfile.contextLength);
    assert.strictEqual(findModelProfile([old], old)?.testGenerationReady, false);
    assert.strictEqual(qualificationForSelectedProfile([old], old, false), false);
    assert.strictEqual(qualificationForSelectedProfile([localProfile], { ...localProfile, runtimeContextTokens: 8192 }, false), true);
});

test('persists a local runtime binding without changing model metadata identity', () => {
    const restored = restoreModelProfiles(JSON.parse(JSON.stringify(upsertModelProfile([], localProfile))));
    assert.deepStrictEqual(restored, [localProfile]);
    const request = { ...localProfile, runtimeContextTokens: 8192 };
    assert.strictEqual(qualificationForSelectedProfile(restored, request, false), true);
    assert.strictEqual(qualificationForSelectedProfile(restored, { ...request, runtimeContextTokens: 5000 }, false), false);
    assert.strictEqual(findModelProfile(restored, { ...request, runtimeContextTokens: 5000 })?.contextLength, 8192);
    assert.strictEqual(modelProfileKey(request), modelProfileKey({ ...request, runtimeContextTokens: 5000 }));
});

test('restoring unbound local roles preserves metadata and expires every claimed role', () => {
    const role = { state: 'verified' as const, reason: 'fixed probe passed' };
    for (const qualificationRuntime of [undefined, { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: '8192' }]) {
        const [restored] = restoreModelProfiles([{ ...localProfile, qualificationRuntime,
            roleQualification: { writer: role, reviewer: role, bugFixer: role } }]);
        assert.strictEqual(restored.contextLength, localProfile.contextLength);
        assert.strictEqual(restored.contextLengthKnown, true);
        assert.strictEqual(restored.modelName, localProfile.modelName);
        assert.strictEqual(restored.testGenerationReady, false);
        assert.strictEqual(restored.qualificationRuntime, undefined);
        assert.deepStrictEqual(Object.values(restored.roleQualification!).map(value => value.state), ['unverified', 'unverified', 'unverified']);
    }
});

test('runtime migration leaves unprobed local and existing remote profiles neutral or unchanged', () => {
    const unprobed = { envType: 'local' as const, modelName: 'neutral-model', paramSize: '3B', contextLength: 4096 };
    const remotes = ['cloud', 'custom'].map(envType => ({ ...localProfile, envType, qualificationRuntime: undefined }));
    const restored = restoreModelProfiles([unprobed, ...remotes]);
    assert.deepStrictEqual(restored, [unprobed, ...remotes]);
    assert.strictEqual(restored[0].contextLengthKnown, undefined, 'legacy fallback is not advertised metadata');
    assert.strictEqual(qualificationForSelectedProfile([restored[0]], { ...unprobed, runtimeContextTokens: 4096 }, false), undefined);
});

test('does not let an unprobed model inherit another model\'s qualification', () => {
    assert.strictEqual(qualificationForSelectedProfile([localProfile], {
        envType: 'local', modelName: 'unprobed-model'
    }, true), false);
    assert.strictEqual(qualificationForSelectedProfile([], {
        envType: 'local', modelName: 'first-model'
    }, false), undefined);
});

test('applies a Cloud qualification when Google changes only the models/ prefix', () => {
    assert.strictEqual(qualificationForSelectedProfile([{
        envType: 'cloud',
        modelName: 'models/gemma-4-31b-it',
        paramSize: 'Cloud',
        contextLength: 1000000,
        qualificationVersion: QUALIFICATION_VERSION, testGenerationReady: true,
        testGenerationMode: '純 Python unittest'
    }], {
        envType: 'cloud', modelName: 'gemma-4-31b-it'
    }, true), true);
});

test('always requests complete unittest files as plain Python across model capabilities', () => {
    assert.strictEqual(selectTestGenerationResponseFormat({
        testGenerationReady: true,
        testGenerationMode: '純 Python unittest'
    }), 'text');
    assert.strictEqual(selectTestGenerationResponseFormat({
        testGenerationReady: true,
        testGenerationMode: '結構化 JSON unittest'
    }), 'text');
    assert.strictEqual(selectTestGenerationResponseFormat({
        testGenerationReady: false,
        testGenerationMode: '純 Python unittest'
    }), 'text');
    assert.strictEqual(selectAnalysisResponseFormat({
        testGenerationReady: true,
        testGenerationMode: '純 Python unittest'
    }), 'text');
    assert.strictEqual(selectAnalysisResponseFormat({
        testGenerationReady: true,
        testGenerationMode: '結構化 JSON unittest'
    }), 'json');
    assert.strictEqual(selectAnalysisResponseFormat({
        testGenerationReady: false,
        testGenerationMode: '純 Python unittest'
    }), 'json');
});
