import * as assert from 'assert';
import { test } from 'node:test';
import { canUseDeterministicTierOne, canUseModelAuthoredRepair, canUseTierOneLlmGeneration, resolveTier, resolveTier1GenerationMode } from '../tier/tierRouter';

test('preserves a manual Tier selection even when a model is unqualified', () => {
    assert.strictEqual(resolveTier(70, 90, 'tier4', false), 4);
    assert.strictEqual(resolveTier(30, 20, 'tier3', false), 3);
});

test('uses Tier 1 only for unprobed Auto routing', () => {
    assert.strictEqual(resolveTier(70, 20, 'tier4'), 4);
    assert.strictEqual(resolveTier(30, 20, 'auto', undefined), 1);
    assert.strictEqual(resolveTier(30, 20, 'auto', false), 1);
});

test('preserves an explicitly requested Tier after the selected model is qualified', () => {
    assert.strictEqual(resolveTier(3, 90, 'tier4', true), 4);
    assert.strictEqual(resolveTier(3, 90, 'tier2', true), 2);
});

test('continues to use model size and complexity for automatic routing', () => {
    assert.strictEqual(resolveTier(3, 10, 'auto', true), 1);
    assert.strictEqual(resolveTier(30, 80, 'auto', true), 3);
    assert.strictEqual(resolveTier(Number.NaN, 80, 'auto', true), 4);
    assert.strictEqual(resolveTier(Number.NaN, 20, 'auto', true), 2);
    assert.strictEqual(resolveTier(Number.NaN, 50, 'auto', true), 3);
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
    assert.strictEqual(canUseDeterministicTierOne({
        examples: [{ result_assertable: false }], errors: []
    }), false);
    assert.strictEqual(canUseDeterministicTierOne({
        examples: [], errors: [{ call_assertable: false, exception: 'ValueError' }]
    }), false);
    assert.strictEqual(canUseDeterministicTierOne({
        examples: [null], errors: []
    }), false);
});

test('permits evidence-bound LLM Tier 1 after a probe or an explicit Tier choice', () => {
    assert.strictEqual(canUseTierOneLlmGeneration(true), true);
    assert.strictEqual(canUseTierOneLlmGeneration(false), false);
    assert.strictEqual(canUseTierOneLlmGeneration(undefined), false);
    assert.strictEqual(canUseTierOneLlmGeneration(false, 'tier2'), true);
    assert.strictEqual(canUseTierOneLlmGeneration(undefined, 'tier4'), true);
});

test('does not let an unqualified Auto fallback invoke a model-authored repair', () => {
    assert.strictEqual(canUseModelAuthoredRepair(false, 'auto'), false);
    assert.strictEqual(canUseModelAuthoredRepair(undefined, 'auto'), false);
    assert.strictEqual(canUseModelAuthoredRepair(true, 'auto'), true);
    assert.strictEqual(canUseModelAuthoredRepair(false, 'tier1'), true);
    assert.strictEqual(canUseModelAuthoredRepair(undefined, 'tier3'), true);
});

test('labels deterministic output as fallback instead of an LLM result', () => {
    assert.strictEqual(resolveTier1GenerationMode(false), 'deterministic-fallback');
    assert.strictEqual(resolveTier1GenerationMode(undefined), 'deterministic-fallback');
    assert.strictEqual(resolveTier1GenerationMode(true), 'llm-evidence-bound');
    assert.strictEqual(resolveTier1GenerationMode(false, 'tier1'), 'llm-evidence-bound');
});
