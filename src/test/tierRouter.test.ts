import * as assert from 'assert';
import { test } from 'node:test';
import { canUseDeterministicTierOne, resolveTier } from '../tierRouter';

test('routes an unqualified model to deterministic Tier 1 even when a higher Tier is requested', () => {
    assert.strictEqual(resolveTier(70, 90, 'tier4', false), 1);
    assert.strictEqual(resolveTier(30, 20, 'tier3', false), 1);
});

test('preserves an explicitly requested Tier after the selected model is qualified', () => {
    assert.strictEqual(resolveTier(3, 90, 'tier4', true), 4);
    assert.strictEqual(resolveTier(3, 90, 'tier2', true), 2);
});

test('continues to use model size and complexity for automatic routing', () => {
    assert.strictEqual(resolveTier(3, 10, 'auto', true), 1);
    assert.strictEqual(resolveTier(30, 80, 'auto', true), 3);
    assert.strictEqual(resolveTier(Number.NaN, 80, 'auto', true), 4);
});

test('requires verified examples or errors before an unqualified model may use Tier 1', () => {
    assert.strictEqual(canUseDeterministicTierOne({
        examples: [{ args: ['1'], result: '1' }],
        errors: []
    }), true);
    assert.strictEqual(canUseDeterministicTierOne({
        examples: [],
        errors: [{ exception: 'ValueError' }]
    }), true);
    assert.strictEqual(canUseDeterministicTierOne({ examples: [], errors: [] }), false);
    assert.strictEqual(canUseDeterministicTierOne({ load_error: 'import failed' }), false);
});
