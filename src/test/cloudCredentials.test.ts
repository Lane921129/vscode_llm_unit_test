import * as assert from 'assert';
import { test } from 'node:test';
import { normalizeCloudCredentials, toCloudCredentialOptions } from '../cloudCredentials';

test('normalizes legacy named-key credentials without losing them', () => {
    const credentials = normalizeCloudCredentials({ 'gemma-4-31b-it': 'legacy-key' });
    assert.deepStrictEqual(credentials, {
        'gemma-4-31b-it': { model: 'gemma-4-31b-it', key: 'legacy-key' }
    });
});

test('keeps a cloud model separate from its credential label and hides keys from display data', () => {
    const credentials = normalizeCloudCredentials({ personal: { model: 'gemma-4-31b-it', key: 'secret' } });
    assert.deepStrictEqual(toCloudCredentialOptions(credentials), { personal: { model: 'gemma-4-31b-it' } });
    assert.ok(!JSON.stringify(toCloudCredentialOptions(credentials)).includes('secret'));
});
