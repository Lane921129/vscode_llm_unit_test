import * as assert from 'assert';
import { test } from 'node:test';
import { buildSupplementalProbeInputs, parseSafeProbeScalar } from '../tier/supplementalProbeInputs';

const strategy = (input_hints: Array<{ param_name: string; boundary_inputs: string[]; invalid_inputs: string[] }>) => ({
    test_strategy: {
        approach: 'source-derived candidates',
        input_hints: input_hints.map(hint => ({ ...hint, strategy: 'boundary', notes: '' })),
        assertion_style: 'mixed' as const,
        mock_needed: false,
        key_rules: []
    }
});

test('accepts only bounded non-executable scalar suggestions', () => {
    assert.strictEqual(parseSafeProbeScalar('None'), null);
    assert.strictEqual(parseSafeProbeScalar('-1.5'), -1.5);
    assert.strictEqual(parseSafeProbeScalar('"ready"'), 'ready');
    assert.strictEqual(parseSafeProbeScalar("'ready'"), 'ready');
    assert.strictEqual(parseSafeProbeScalar('[1, 2]'), undefined);
    assert.strictEqual(parseSafeProbeScalar('factory()'), undefined);
    assert.strictEqual(parseSafeProbeScalar("'a\\nb'"), undefined);
});

test('builds complete, bounded calls from semantic candidates and AST defaults', () => {
    const candidates = buildSupplementalProbeInputs(strategy([
        { param_name: 'value', boundary_inputs: ['0', '10', '10'], invalid_inputs: ['None'] }
    ]), [
        { name: 'value', kind: 'positional_or_keyword', required: true, default: null },
        { name: 'mode', kind: 'keyword_only', required: false, default: "'draft'" }
    ]);

    assert.deepStrictEqual(candidates, [
        { args: [], kwargs: { value: 0, mode: 'draft' } },
        { args: [], kwargs: { value: 10, mode: 'draft' } },
        { args: [], kwargs: { value: null, mode: 'draft' } }
    ]);
});

test('does not invent a value when a required AST parameter lacks a safe candidate', () => {
    assert.deepStrictEqual(buildSupplementalProbeInputs(strategy([
        { param_name: 'known', boundary_inputs: ['1'], invalid_inputs: [] }
    ]), [
        { name: 'known', kind: 'positional_only', required: true, default: null },
        { name: 'missing', kind: 'positional_or_keyword', required: true, default: null }
    ]), []);
});
