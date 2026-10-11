import * as assert from 'assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { formatSemanticContextForPrompt, getSemanticAnalyzerSystemPrompt, parseSemanticAnalysis,
    parseSemanticAnalysisDetailed, restrictSemanticInputHintsToTargetParameters } from '../roles/semanticAnalyzer';

test('the recorded repeated Analyst hash identifies the previous public placeholder template, which stays rejected', () => {
    const template = '{"dependency_behaviors":[],"unreachable_paths":[],"mock_required_for":[],"test_strategy":{"approach":"<concrete plan for this target>","input_hints":[],"assertion_style":"mixed","mock_needed":false,"key_rules":[]}}';
    assert.equal(template.length, 214);
    assert.equal(createHash('sha256').update(template).digest('hex'), '5a6b30d9f53242998e8aa6da656ccb89e9edfccfa3e73f41fee029b83c768076');
    const result = parseSemanticAnalysisDetailed(template);
    assert.equal(result.analysis, null);
    assert.equal(result.diagnostic.reasonCode, 'template-only-strategy');
    assert.equal(result.diagnostic.responseShape.topLevelKeyCount, 4);
    assert.equal(result.diagnostic.responseShape.semanticKeyCount, 4);
    assert.equal(result.diagnostic.responseShape.strategyKeyCount, 5);
    assert.equal(result.diagnostic.responseShape.placeholderStrategyTextCount, 1);
    const system = getSemanticAnalyzerSystemPrompt();
    assert.ok(!system.includes(template));
    assert.doesNotMatch(system, /<concrete plan|\{"dependency_behaviors"|\{"approach"/);
    for (const field of ['dependency_behaviors', 'unreachable_paths', 'mock_required_for', 'test_strategy',
        'approach', 'input_hints', 'assertion_style', 'mock_needed', 'key_rules', 'param_name', 'strategy',
        'boundary_inputs', 'invalid_inputs', 'notes', 'when_caller_passes', 'always_returns', 'can_raise']) {
        assert.ok(system.includes(field), field);
    }
});

test('semantic rejection diagnostics distinguish transport text shape without recording provider keys or content', () => {
    for (const [raw, reasonCode] of [
        ['  ', 'empty-response'], ['PRIVATE_RESPONSE_NOT_JSON', 'invalid-json'],
        ['[]', 'invalid-envelope'], ['null', 'invalid-envelope'],
        ['{"PRIVATE_PROVIDER_KEY":"PRIVATE_PROVIDER_VALUE"}', 'unrelated-json'],
        ['{"type":"object","properties":{"PRIVATE_PROVIDER_KEY":{}}}', 'schema-envelope'],
        ['{"dependency_behaviors":[]}', 'missing-test-strategy'],
        ['{"test_strategy":[]}', 'invalid-test-strategy'], ['{"test_strategy":{}}', 'empty-test-strategy'],
        ['{"test_strategy":{"approach":"<PRIVATE_PROVIDER_VALUE>"}}', 'template-only-strategy'],
        ['{"test_strategy":{"input_hints":[{"param_name":4,"strategy":"Exercise a source branch"}]}}', 'no-usable-strategy']
    ]) {
        const result = parseSemanticAnalysisDetailed(raw);
        assert.equal(result.analysis, null);
        assert.equal(parseSemanticAnalysis(raw), null);
        assert.equal(result.diagnostic.reasonCode, reasonCode);
        assert.doesNotMatch(JSON.stringify(result.diagnostic), /PRIVATE_PROVIDER|PRIVATE_RESPONSE|Exercise a source branch/);
    }
});

test('safe semantic shape counts do not change accepted direct, fenced or embedded analyses', () => {
    const body = '{"test_strategy":{"approach":"Exercise the controlled input"},"PRIVATE_UNKNOWN_KEY":"PRIVATE_VALUE"}';
    for (const [raw, format] of [[body, 'json'], ['```json\n' + body + '\n```', 'json-fence'],
        ['Analysis:\n' + body + '\nDone.', 'embedded-json']]) {
        const result = parseSemanticAnalysisDetailed(raw);
        assert.ok(result.analysis);
        assert.deepEqual(result.analysis, parseSemanticAnalysis(body));
        assert.equal(result.diagnostic.reasonCode, 'accepted');
        assert.equal(result.diagnostic.responseShape.format, format);
        assert.equal(result.diagnostic.responseShape.topLevelKeyCount, 2);
        assert.equal(result.diagnostic.responseShape.semanticKeyCount, 1);
        assert.doesNotMatch(JSON.stringify(result.diagnostic), /PRIVATE_|Exercise the controlled input/);
    }
});

test('drops unfinished semantic placeholders before they reach a Writer prompt', () => {
    const parsed = parseSemanticAnalysis(JSON.stringify({
        dependency_behaviors: [],
        unreachable_paths: [{ condition: '<to be determined>', reason: '<to be determined>' }],
        mock_required_for: [],
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
test('rejects unrelated or legacy rule-selection JSON so orchestration keeps the AST rule baseline', () => {
    assert.strictEqual(parseSemanticAnalysis(JSON.stringify({
        message: 'temporary gateway metadata',
        request_id: 'safe-non-secret-id'
    })), null);

    assert.strictEqual(parseSemanticAnalysis(JSON.stringify({ required_skills: [] })), null);
});

test('keeps semantic input candidates scoped to the selected target signature', () => {
    const parsed = parseSemanticAnalysis(JSON.stringify({
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

test('parses JSON when followed by trailing commentary', () => {
    const raw = '{"test_strategy": {"approach": "boundary candidates"}}\n\nHope this helps!';
    const parsed = parseSemanticAnalysis(raw);
    assert.ok(parsed);
    assert.strictEqual(parsed!.test_strategy.approach, 'boundary candidates');
});

test('empty envelopes, placeholder-only strategies and dependency claims alone are not analysis plans', () => {
    for (const value of [
        {}, { dependency_behaviors: [] }, { test_strategy: {} },
        { dependency_behaviors: [], unreachable_paths: [], mock_required_for: [], test_strategy: { approach: '', input_hints: [], key_rules: [] } },
        { test_strategy: { approach: 'N/A', key_rules: ['TODO', '<source-specific observation>'], input_hints: [] } },
        { test_strategy: { approach: 'Use <parameter name> to cover boundaries', input_hints: [] } },
        { dependency_behaviors: [{ name: 'load', when_caller_passes: '0', always_returns: '1', can_raise: [] }] }
    ]) { assert.equal(parseSemanticAnalysis(JSON.stringify(value)), null); }
});

test('a zero-parameter target still needs a concrete strategy without fabricated input or dependency facts', () => {
    const parsed = parseSemanticAnalysis('{"dependency_behaviors":[],"unreachable_paths":[],"mock_required_for":[],"test_strategy":{"approach":"Call the zero-parameter target and assert its source-supported result after controlled verification.","input_hints":[],"assertion_style":"assertEqual","mock_needed":false,"key_rules":[]}}');
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.test_strategy.input_hints, []);
    assert.deepStrictEqual(parsed!.dependency_behaviors, []);
});

test('strategy placeholder checks do not discard None or quoted scalar evidence', () => {
    const parsed = parseSemanticAnalysis(JSON.stringify({
        dependency_behaviors: [{ name: 'load', when_caller_passes: 'None', always_returns: 'None', can_raise: [] }],
        test_strategy: { input_hints: [{ param_name: 'value', strategy: 'Exercise the optional-value branch.',
            boundary_inputs: ['None', "'TODO'", "'<record>'", 'False', '0'], invalid_inputs: [], notes: '' }] }
    }));
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.test_strategy.input_hints[0].boundary_inputs, ['None', "'TODO'", "'<record>'", 'False', '0']);
    assert.equal(parsed!.dependency_behaviors[0].always_returns, 'None');
});

test('concrete strategies can discuss quoted markup without becoming placeholder-only plans', () => {
    const approach = 'Check the quoted input "<record>" under controlled execution.';
    const strategy = "Exercise the source branch for '<record>' and verify the matching call.";
    const keyRule = 'Preserve the quoted value "<record>" in this target input.';
    for (const test_strategy of [
        { approach }, { input_hints: [{ param_name: 'value', strategy, boundary_inputs: ["'<record>'"] }] },
        { key_rules: [keyRule] }
    ]) {
        const parsed = parseSemanticAnalysis(JSON.stringify({ test_strategy }));
        assert.ok(parsed);
        if ('approach' in test_strategy) { assert.equal(parsed!.test_strategy.approach, approach); }
        if ('input_hints' in test_strategy) { assert.equal(parsed!.test_strategy.input_hints[0].strategy, strategy); }
        if ('key_rules' in test_strategy) { assert.deepStrictEqual(parsed!.test_strategy.key_rules, [keyRule]); }
    }
    assert.equal(parseSemanticAnalysis('{"test_strategy":{"approach":"Use <parameter name> for the boundary"}}'), null);
});
