import * as assert from 'assert';
import { test } from 'node:test';
import { buildSemanticTraceCandidates, parseSafeSemanticScalar } from '../tier/semanticTraceCandidates';

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
    assert.strictEqual(parseSafeSemanticScalar('None'), null);
    assert.strictEqual(parseSafeSemanticScalar('-1.5'), -1.5);
    assert.strictEqual(parseSafeSemanticScalar('"ready"'), 'ready');
    assert.strictEqual(parseSafeSemanticScalar("'ready'"), 'ready');
    assert.strictEqual(parseSafeSemanticScalar('[1, 2]'), undefined);
    assert.strictEqual(parseSafeSemanticScalar('factory()'), undefined);
    assert.strictEqual(parseSafeSemanticScalar("'a\\nb'"), undefined);
});

test('builds complete, bounded calls from semantic candidates and AST defaults', () => {
    const candidates = buildSemanticTraceCandidates(strategy([
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
    assert.deepStrictEqual(buildSemanticTraceCandidates(strategy([
        { param_name: 'known', boundary_inputs: ['1'], invalid_inputs: [] }
    ]), [
        { name: 'known', kind: 'positional_only', required: true, default: null },
        { name: 'missing', kind: 'positional_or_keyword', required: true, default: null }
    ]), []);
});
