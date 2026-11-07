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
        { args: [0], kwargs: { mode: 'draft' } },
        { args: [10], kwargs: { mode: 'draft' } },
        { args: [null], kwargs: { mode: 'draft' } }
    ]);
});

test('an omitted middle parameter makes following positional-or-keyword values keywords', () => {
    assert.deepStrictEqual(buildSupplementalProbeInputs(strategy([
        { param_name: 'first', boundary_inputs: ['1'], invalid_inputs: [] },
        { param_name: 'last', boundary_inputs: ['3'], invalid_inputs: [] }
    ]), [
        { name: 'first', kind: 'positional_or_keyword', required: true, default: null },
        { name: 'middle', kind: 'positional_or_keyword', required: false, default: 'factory()' },
        { name: 'last', kind: 'positional_or_keyword', required: false, default: '0' }
    ]), [{ args: [1], kwargs: { last: 3 } }]);
});

test('positional-only values stay in args and keyword-only values always stay in kwargs', () => {
    assert.deepStrictEqual(buildSupplementalProbeInputs(strategy([
        { param_name: 'position', boundary_inputs: ['1'], invalid_inputs: [] },
        { param_name: 'keyword', boundary_inputs: ['2'], invalid_inputs: [] }
    ]), [
        { name: 'position', kind: 'positional_only', required: true, default: null },
        { name: 'keyword', kind: 'keyword_only', required: true, default: null }
    ]), [{ args: [1], kwargs: { keyword: 2 } }]);
});

test('does not invent a value when a required AST parameter lacks a safe candidate', () => {
    assert.deepStrictEqual(buildSupplementalProbeInputs(strategy([
        { param_name: 'known', boundary_inputs: ['1'], invalid_inputs: [] }
    ]), [
        { name: 'known', kind: 'positional_only', required: true, default: null },
        { name: 'missing', kind: 'positional_or_keyword', required: true, default: null }
    ]), []);
});
