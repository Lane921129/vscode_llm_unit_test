import * as assert from 'assert';
import { test } from 'node:test';
import { qualificationForRequest } from '../modelQualification';

test('uses a generation qualification only for the exact probed model', () => {
    const profile = {
        envType: 'local' as const,
        modelName: 'reliable-instruct',
        testGenerationReady: true
    };

    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'local', modelName: 'reliable-instruct' }),
        true
    );
    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'local', modelName: 'different-model' }),
        false
    );
    assert.strictEqual(
        qualificationForRequest(profile, { envType: 'cloud', modelName: 'reliable-instruct' }),
        false
    );
});

test('keeps unprobed profiles neutral until a probe result exists', () => {
    assert.strictEqual(
        qualificationForRequest(
            { envType: 'local', modelName: 'pending-model' },
            { envType: 'local', modelName: 'pending-model' }
        ),
        undefined
    );
});
