import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRuntimeContextPreference, restoreRuntimeContextPreferences, upsertRuntimeContextPreference } from '../llm/runtimeContextPreferences';

test('context preferences isolate model and endpoint, replace one choice and clear only its identity', () => {
    const a = { endpointKey: 'endpoint-a', modelName: 'neutral-a' };
    const b = { endpointKey: 'endpoint-a', modelName: 'neutral-b' };
    const c = { endpointKey: 'endpoint-b', modelName: 'neutral-a' };
    let stored = upsertRuntimeContextPreference([], a, 4096, 'captured-runtime');
    stored = upsertRuntimeContextPreference(stored, b, 8192, 'user-choice');
    stored = upsertRuntimeContextPreference(stored, c, 16384, 'user-choice');
    stored = upsertRuntimeContextPreference(stored, { ...a, modelName: ' NEUTRAL-A ' }, 6144, 'user-choice');
    assert.equal(stored.length, 3);
    assert.equal(getRuntimeContextPreference(JSON.parse(JSON.stringify(stored)), a)?.tokens, 6144);
    assert.equal(getRuntimeContextPreference(stored, b)?.tokens, 8192);
    assert.equal(getRuntimeContextPreference(stored, c)?.tokens, 16384);
    stored = upsertRuntimeContextPreference(stored, a, 0, 'user-choice');
    assert.equal(getRuntimeContextPreference(stored, a), undefined);
    assert.deepEqual(stored.map(entry => entry.tokens), [8192, 16384]);
});

test('invalid persisted preferences cannot become choices and bounded history preserves recent models', () => {
    const identity = { endpointKey: 'endpoint-a', modelName: 'neutral-a' };
    const good = { ...identity, tokens: 4096, source: 'captured-runtime' as const };
    assert.deepEqual(restoreRuntimeContextPreferences([good, null, { ...good, tokens: '8192' },
        { ...good, tokens: 0 }, { ...good, tokens: 1.5 }, { ...good, source: 'unknown' }, { ...good, endpointKey: '' }]), [good]);
    for (const tokens of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => upsertRuntimeContextPreference([], identity, tokens, 'user-choice'));
    }
    let stored = [good];
    for (let i = 0; i < 60; i++) {
        stored = upsertRuntimeContextPreference(stored, { ...identity, modelName: `neutral-${i}` }, 4096, 'captured-runtime') as typeof stored;
    }
    assert.equal(stored.length, 50);
    assert.equal(stored[0].modelName, 'neutral-10');
    assert.equal(stored.at(-1)?.modelName, 'neutral-59');
});
