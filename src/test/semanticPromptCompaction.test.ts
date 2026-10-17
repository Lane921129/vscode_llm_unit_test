import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { addOutputContract, responseSchemaForOutputFormat } from '../llm/customApi';
import { buildOllamaPromptEnvelope } from '../llm/ollamaPrompt';
import { BehaviorObservations } from '../pipeline/evidenceContracts';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { AnalysisEvidenceV2, buildSemanticAnalyzerSystemPrompt, getSemanticAnalyzerUserPrompt,
    SEMANTIC_PLAN_LIMITS, SEMANTIC_PLAN_RESPONSE_SCHEMA } from '../roles/semanticAnalyzer';

const source = '\r\ndef selected(value, suffix="  原樣\\n "):\r\n    return value + suffix\r\n';
const examples = Array.from({ length: 10 }, (_, index) => ({ case_id: `case-${index}`,
    args: [JSON.stringify(`  input ${index}\n原樣  `)], kwargs: { suffix: "'  suffix  '" },
    constructor_args: ["'  owner  '"], constructor_kwargs: { mode: "'  mode  '" },
    result: JSON.stringify(`  result ${index}\n原樣  `), result_type: 'str',
    call_assertable: index !== 9, result_assertable: index !== 9, inputs_mutated: index === 9 }));
const errors = [{ case_id: 'exceptional', args: ['None'], exception: 'TypeError',
    exception_module: 'builtins', exception_qualname: 'TypeError',
    message: '  complete exception\n原樣  ', call_assertable: true }];
const observations: BehaviorObservations = { func_name: 'selected', args: ['value', 'suffix'],
    examples, errors, load_error: null, complete: true, blocked_operations: [] };
const evidence = (): AnalysisEvidenceV2 => ({ schemaVersion: 'analysis-evidence-v2',
    target: { moduleName: 'sample', functionName: 'selected', source, sourceHash: 'a'.repeat(64) },
    astFacts: { code: source, args: ['value', 'suffix'], referenced_globals: [{ name: 'SETTING',
        code: 'SETTING = "  complete setup\\n原樣  "' }] },
    dependencies: [], callSites: [{ caller_func: 'caller', call_expr: 'selected("  caller  ")' }],
    initialTargetObservations: observations });

const wireBody = (input: AnalysisEvidenceV2) => ({
    model: 'selected-runtime-model',
    ...buildOllamaPromptEnvelope(addOutputContract(buildSemanticAnalyzerSystemPrompt(), 'semantic-json'),
        getSemanticAnalyzerUserPrompt(input)),
    stream: true,
    format: responseSchemaForOutputFormat('semantic-json')
});

test('compact Analyst instructions reduce the fixed envelope while preserving each plan field and evidence gate', () => {
    const system = buildSemanticAnalyzerSystemPrompt();
    // Before this compaction the same fixed system used 793 estimated tokens.
    assert.ok(estimatePromptTokens(system) <= 710, `fixed system uses ${estimatePromptTokens(system)} estimated tokens`);
    for (const field of ['test_strategy', 'approach', 'input_hints', 'param_name', 'strategy', 'boundary_inputs',
        'invalid_inputs', 'notes', 'assertion_style', 'mock_needed', 'key_rules', 'dependency_behaviors',
        'name', 'when_caller_passes', 'always_returns', 'can_raise', 'unreachable_paths', 'condition', 'reason',
        'mock_required_for', 'path', 'mock_target', 'example']) {
        assert.match(system, new RegExp(`\\b${field}\\b`), field);
    }
    assert.match(system, /one initial unittest scenario/);
    assert.match(system, /including for zero-parameter functions/);
    assert.match(system, /never truncate or alter evidence/);
    assert.match(system, /invalid_inputs does not prove an exception/);
    assert.match(system, /Without verified dependency observations, leave dependency_behaviors empty/);
    assert.match(system, /never omit tests on that basis or patch the target\/class/);
    assert.match(system, /No direct network, file I\/O, shell, dynamic execution or shared SQLite/);
});

test('the complete serialized Analyst wire retains source, setup, every observation and the unchanged bounded schema', () => {
    const input = evidence(), before = JSON.stringify(input);
    const body = JSON.parse(JSON.stringify(wireBody(input)));
    assert.equal(body.system, ' ');
    assert.equal(body.prompt.split(source).length - 1, 1, 'the exact source is carried once');
    assert.ok(body.prompt.includes(input.astFacts!.referenced_globals![0].code!));
    assert.ok(body.prompt.includes(input.callSites[0].call_expr));
    const facts = JSON.parse(body.prompt.split('=== VERIFIED TARGET EXECUTION OBSERVATIONS ===\n')[1].split('\n')[0]);
    assert.equal(facts.examples.length, 10);
    assert.equal(facts.errors.length, 1);
    assert.deepEqual(facts.examples.slice(0, 9), examples.slice(0, 9).map(({ case_id, ...fact }) => ({ ...fact, case_ids: [case_id] })));
    assert.deepEqual(facts.examples[9], { args: examples[9].args, kwargs: examples[9].kwargs,
        constructor_args: examples[9].constructor_args, constructor_kwargs: examples[9].constructor_kwargs,
        call_assertable: false, result_assertable: false, inputs_mutated: true, case_ids: ['case-9'],
        resultDetails: 'artifact-only; non-assertable return' });
    assert.deepEqual(facts.errors, errors.map(({ case_id, ...fact }) => ({ ...fact, case_ids: [case_id] })));
    assert.equal(facts.complete, true);
    assert.deepEqual(body.format, SEMANTIC_PLAN_RESPONSE_SCHEMA);
    assert.equal(body.format.additionalProperties, false);
    assert.deepEqual(body.format.required, ['test_strategy']);
    assert.equal(body.format.properties.test_strategy.properties.approach.maxLength, SEMANTIC_PLAN_LIMITS.approachCharacters);
    assert.equal(body.format.properties.test_strategy.properties.input_hints.maxItems, SEMANTIC_PLAN_LIMITS.inputHints);
    assert.equal(JSON.stringify(input), before, 'prompt compaction does not mutate artifact evidence');
});

test('compact instructions never make oversized necessary source look small enough for a 2K request', () => {
    const input = evidence();
    input.target.source += '\n# ' + '完整來源與空白  '.repeat(1600) + '\n# source-tail\n';
    const body = wireBody(input);
    assert.ok(body.prompt.includes(input.target.source));
    assert.equal(promptFits('', body.prompt, 2048, 94), false);
    assert.equal(JSON.parse(body.prompt.split('=== VERIFIED TARGET EXECUTION OBSERVATIONS ===\n')[1]
        .split('\n')[0]).examples.length, 10);
});
