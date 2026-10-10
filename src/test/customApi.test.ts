import * as assert from 'assert';
import { test } from 'node:test';
import { addOutputContract, buildCustomChatCompletionBody, getCustomChatCompletionText, isStructuredResponseUsable, responseSchemaForOutputFormat, shouldRetryStructuredOutputAsText } from '../llm/customApi';
import { buildGoogleGenerateContentRequest } from '../llm/cloudApi';
import { parseSemanticAnalysis, SemanticAnalysis } from '../roles/semanticAnalyzer';

test('custom API requests JSON mode only when the caller needs a structured result', () => {
    const textRequest = buildCustomChatCompletionBody('model-a', 'system', 'user', 'text');
    const jsonRequest = buildCustomChatCompletionBody('model-a', 'system', 'user', 'test-code-json');

    assert.strictEqual(textRequest.response_format, undefined);
    assert.deepStrictEqual(jsonRequest.response_format, { type: 'json_object' });
});

test('structured output contracts are generic and describe the expected envelope', () => {
    const codeContract = addOutputContract('base', 'test-code-json');
    const jsonContract = addOutputContract('base', 'json');

    assert.ok(codeContract.includes('"code"'));
    assert.ok(codeContract.includes('Python unittest'));
    assert.ok(jsonContract.includes('valid JSON object'));
    assert.strictEqual(addOutputContract('base', 'text'), 'base');
});

test('provides schema contracts for semantic analysis, review, and mutant triage', () => {
    const semantic = responseSchemaForOutputFormat('semantic-json');
    const review = responseSchemaForOutputFormat('review-json');
    const repair = responseSchemaForOutputFormat('test-method-json');
    const triage = responseSchemaForOutputFormat('mutant-triage-json');

    assert.deepStrictEqual((semantic as { required: string[] }).required, [
        'dependency_behaviors', 'unreachable_paths', 'mock_required_for', 'test_strategy'
    ]);
    assert.deepStrictEqual((review as { required: string[] }).required, ['findings']);
    assert.strictEqual((review as any).properties.findings.maxItems, 5);
    assert.strictEqual((review as any).properties.findings.items.properties.test_line.pattern, '^L[1-9][0-9]*$');
    assert.strictEqual((review as any).properties.findings.items.additionalProperties, false);
    assert.deepStrictEqual((repair as { required: string[] }).required, ['method', 'replacement', 'imports']);
    assert.deepStrictEqual(
        ((review as any).properties.findings.items as { required: string[] }).required,
        ['category', 'test_line', 'reason', 'action']
    );
    assert.deepStrictEqual((triage as { required: string[] }).required, [
        'verdicts', 'has_killable', 'equivalent_count'
    ]);
    assert.strictEqual(responseSchemaForOutputFormat('json'), undefined);
    assert.ok(isStructuredResponseUsable('{"verdicts":[]}', 'mutant-triage-json'));
    assert.ok(isStructuredResponseUsable('{"findings":[]}', 'review-json'));
    assert.ok(isStructuredResponseUsable(
        '{"method":"test_x","replacement":"def test_x(self): pass","imports":[]}',
        'test-method-json'
    ));
    assert.ok(isStructuredResponseUsable(
        '```json\n{"method":"test_x","replacement":"def test_x(self): pass","imports":[]}\n```',
        'test-method-json'
    ));
});

test('semantic response schema defines every nested object and array element before transport', () => {
    const schema = responseSchemaForOutputFormat('semantic-json');
    const leaves: Record<string, unknown> = {};
    const inspect = (candidate: unknown, path: string): void => {
        assert.ok(candidate && typeof candidate === 'object' && !Array.isArray(candidate), path);
        const node = candidate as Record<string, unknown>;
        if (node.type === 'array') {
            // Gemini rejects an array without items even when the prompt describes them.
            assert.ok(node.items, `${path} requires items`);
            assert.strictEqual(node.minItems, undefined, `${path} may be empty when no facts exist`);
            inspect(node.items, `${path}[]`);
        } else if (node.type === 'object') {
            assert.ok(node.properties && typeof node.properties === 'object', `${path} requires properties`);
            const properties = node.properties as Record<string, unknown>;
            assert.ok(Object.keys(properties).length > 0, `${path} must not be an untyped object`);
            assert.deepStrictEqual([...(node.required as string[])].sort(), Object.keys(properties).sort(), path);
            for (const [name, property] of Object.entries(properties)) {
                inspect(property, path ? `${path}.${name}` : name);
            }
        } else {
            assert.ok(node.type === 'string' || node.type === 'boolean', `${path} has a scalar type`);
            leaves[path] = node.type;
        }
    };
    inspect(schema, '');
    assert.deepStrictEqual(leaves, {
        'dependency_behaviors[].name': 'string',
        'dependency_behaviors[].when_caller_passes': 'string',
        'dependency_behaviors[].always_returns': 'string',
        'dependency_behaviors[].can_raise[]': 'string',
        'unreachable_paths[].condition': 'string',
        'unreachable_paths[].reason': 'string',
        'mock_required_for[].path': 'string',
        'mock_required_for[].mock_target': 'string',
        'mock_required_for[].example': 'string',
        'test_strategy.approach': 'string',
        'test_strategy.input_hints[].param_name': 'string',
        'test_strategy.input_hints[].strategy': 'string',
        'test_strategy.input_hints[].boundary_inputs[]': 'string',
        'test_strategy.input_hints[].invalid_inputs[]': 'string',
        'test_strategy.input_hints[].notes': 'string',
        'test_strategy.assertion_style': 'string',
        'test_strategy.mock_needed': 'boolean',
        'test_strategy.key_rules[]': 'string'
    });
    const strategy = (schema!.properties as Record<string, Record<string, unknown>>).test_strategy;
    const assertionStyle = (strategy.properties as Record<string, Record<string, unknown>>).assertion_style;
    assert.deepStrictEqual(assertionStyle.enum, ['assertEqual', 'assertRaises', 'mixed']);
});

test('Cloud semantic requests retain the complete schema and keep server failures outside format fallback', () => {
    const schema = responseSchemaForOutputFormat('semantic-json');
    const request = buildGoogleGenerateContentRequest('neutral-model', 'test-key', 'Analyse the selected target.', {
        responseMimeType: 'application/json', responseSchema: schema
    });
    const wire = JSON.parse(JSON.stringify(request.body));
    assert.deepStrictEqual(wire.generationConfig.responseSchema, schema);
    assert.strictEqual(wire.generationConfig.responseMimeType, 'application/json');
    assert.strictEqual(wire.generationConfig.responseSchema.properties.test_strategy
        .properties.input_hints.items.properties.boundary_inputs.items.type, 'string');
    assert.strictEqual(shouldRetryStructuredOutputAsText(500, 'semantic-json'), false);
});

test('a complete semantic envelope preserves candidate reprs without accepting an empty strategy', () => {
    const analysis: SemanticAnalysis = {
        dependency_behaviors: [], unreachable_paths: [], mock_required_for: [],
        test_strategy: {
            approach: 'Exercise the selected target with controlled inputs and verify the observed behavior.',
            input_hints: [{
                param_name: 'value', strategy: 'Exercise empty, quoted, and absent scalar inputs.',
                boundary_inputs: ["''", "'<record>'"], invalid_inputs: ['None'], notes: ''
            }],
            assertion_style: 'mixed', mock_needed: false, key_rules: []
        }
    };
    assert.deepStrictEqual(parseSemanticAnalysis(JSON.stringify(analysis)), analysis);
    const zeroParameter = { ...analysis, test_strategy: { ...analysis.test_strategy, input_hints: [] } };
    assert.deepStrictEqual(parseSemanticAnalysis(JSON.stringify(zeroParameter)), zeroParameter);
    const emptyPlan = { ...zeroParameter, test_strategy: { ...zeroParameter.test_strategy, approach: '' } };
    assert.strictEqual(parseSemanticAnalysis(JSON.stringify(emptyPlan)), null);
});

test('detects malformed successful structured responses before they reach a Tier', () => {
    assert.ok(!isStructuredResponseUsable('{', 'json'));
    assert.ok(!isStructuredResponseUsable('{}', 'json'));
    assert.ok(!isStructuredResponseUsable('{}', 'test-code-json'));
    assert.ok(isStructuredResponseUsable('{"test_strategy": {}}', 'json'));
    assert.ok(isStructuredResponseUsable('{"code":"import unittest"}', 'test-code-json'));
    assert.ok(isStructuredResponseUsable('```json\n{"code":"import unittest"}\n```', 'test-code-json'));
    assert.ok(!isStructuredResponseUsable('```json\n{"invalid":true}\n```', 'test-code-json'));
    assert.ok(isStructuredResponseUsable('import unittest', 'test-code-json'));
    assert.ok(!isStructuredResponseUsable('I cannot fulfill this request.', 'test-code-json'));
});

test('retries known structured-output rejections as plain text without hiding account failures', () => {
    for (const status of [400, 415, 422, 501]) {
        assert.ok(shouldRetryStructuredOutputAsText(status, 'json'));
        assert.ok(shouldRetryStructuredOutputAsText(status, 'test-code-json'));
    }
    assert.ok(!shouldRetryStructuredOutputAsText(422, 'text'));
    for (const status of [401, 403, 404, 408, 429, 500, 503]) {
        assert.ok(!shouldRetryStructuredOutputAsText(status, 'json'));
    }
});

test('extracts Custom assistant text without trusting malformed payloads', () => {
    assert.strictEqual(
        getCustomChatCompletionText({ choices: [{ message: { content: '{"ok":true}' } }] }),
        '{"ok":true}'
    );
    assert.strictEqual(getCustomChatCompletionText({ choices: [{ message: {} }] }), undefined);
    assert.strictEqual(getCustomChatCompletionText({ choices: [] }), undefined);
    assert.strictEqual(
        getCustomChatCompletionText({ choices: [{ message: { content: [{ type: 'text', text: '{"code":' }, { type: 'text', text: '"complete"}' }, { type: 'reasoning', summary: 'ignored' }] } }] }),
        '{"code":"complete"}'
    );
});
