import * as assert from 'assert';
import { test } from 'node:test';
import { formatSemanticContextForPrompt, parseSemanticAnalysis, restrictSemanticInputHintsToTargetParameters } from '../roles/semanticAnalyzer';

test('drops unfinished semantic placeholders before they reach a Writer prompt', () => {
    const parsed = parseSemanticAnalysis(JSON.stringify({
        dependency_behaviors: [],
        unreachable_paths: [{ condition: '<to be determined>', reason: '<to be determined>' }],
        equivalent_mutant_candidates: [],
        mock_required_for: [],
        required_skills: ['import_module_name', '<to be determined>'],
        test_strategy: {
            approach: '<to be determined>',
            input_hints: [
                { param_name: '<to be determined>', strategy: '<to be determined>', boundary_inputs: ['<to be determined>'], invalid_inputs: [], notes: '' },
                { param_name: 'value', strategy: 'candidate branch input', boundary_inputs: ['0', '1'], invalid_inputs: ['None'], notes: '<to be determined>' }
            ],
            assertion_style: 'not-a-style', mock_needed: 'yes', key_rules: ['<to be determined>', 'cover a source-supported branch']
        }
    }));

    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.required_skills, ['import_module_name']);
    assert.strictEqual(parsed!.unreachable_paths.length, 0);
    assert.strictEqual(parsed!.test_strategy.approach, '');
    assert.strictEqual(parsed!.test_strategy.input_hints.length, 1);
    assert.deepStrictEqual(parsed!.test_strategy.input_hints[0].boundary_inputs, ['0', '1']);
    assert.strictEqual(parsed!.test_strategy.assertion_style, 'mixed');
    assert.strictEqual(parsed!.test_strategy.mock_needed, false);
    const promptContext = formatSemanticContextForPrompt(parsed!);
    assert.doesNotMatch(promptContext, /to be determined/i);
    assert.match(promptContext, /candidate branch input/);
});

test('rejects unrelated JSON so orchestration keeps the AST skill baseline', () => {
    assert.strictEqual(parseSemanticAnalysis(JSON.stringify({
        message: 'temporary gateway metadata',
        request_id: 'safe-non-secret-id'
    })), null);

    const minimalAnalysis = parseSemanticAnalysis(JSON.stringify({ required_skills: [] }));
    assert.ok(minimalAnalysis);
    assert.deepStrictEqual(minimalAnalysis!.required_skills, []);
});

test('keeps semantic input candidates scoped to the selected target signature', () => {
    const parsed = parseSemanticAnalysis(JSON.stringify({
        required_skills: [],
        test_strategy: {
            approach: 'exercise candidates',
            input_hints: [
                { param_name: 'value', strategy: 'target input', boundary_inputs: ["'x'"], invalid_inputs: [], notes: '' },
                { param_name: 'dependency_flag', strategy: 'dependency-only input', boundary_inputs: ['True'], invalid_inputs: [], notes: '' }
            ],
            assertion_style: 'mixed', mock_needed: false, key_rules: []
        }
    }));

    assert.ok(parsed);
    const restricted = restrictSemanticInputHintsToTargetParameters(parsed!, ['value']);
    assert.deepStrictEqual(restricted.test_strategy.input_hints.map(hint => hint.param_name), ['value']);
    assert.match(formatSemanticContextForPrompt(restricted), /Param "value"/);
    assert.doesNotMatch(formatSemanticContextForPrompt(restricted), /dependency_flag/);
});
