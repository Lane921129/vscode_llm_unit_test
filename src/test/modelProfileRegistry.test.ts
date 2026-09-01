import * as assert from 'assert';
import { test } from 'node:test';
import { findModelProfile, modelProfileKey, qualificationForSelectedProfile, restoreModelProfiles, upsertModelProfile } from '../modelProfileRegistry';

const localProfile = {
    envType: 'local' as const,
    modelName: 'reliable-instruct',
    paramSize: '8B',
    contextLength: 8192,
    testGenerationReady: true,
    testGenerationReason: '模型已通過行為 assertion 驗證。',
    testGenerationMode: '結構化 JSON unittest'
};

test('keeps qualification metadata for multiple provider/model pairs', () => {
    const profiles = upsertModelProfile([localProfile], {
        envType: 'cloud',
        modelName: 'models/gemma-4-31b-it',
        paramSize: 'Cloud',
        contextLength: 1000000,
        testGenerationReady: true
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
    const updated = upsertModelProfile(first, { ...localProfile, testGenerationReady: false });
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

test('does not let an unprobed model inherit another model\'s qualification', () => {
    assert.strictEqual(qualificationForSelectedProfile([localProfile], {
        envType: 'local', modelName: 'unprobed-model'
    }, true), false);
    assert.strictEqual(qualificationForSelectedProfile([], {
        envType: 'local', modelName: 'first-model'
    }, false), undefined);
});
