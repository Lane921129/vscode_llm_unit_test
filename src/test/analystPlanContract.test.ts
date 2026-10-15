import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectAnalysisResponseFormat, selectTestGenerationResponseFormat } from '../llm/modelQualification';
import { boundedRoleStageDeadline } from '../llm/requestTiming';
import { TargetBudget, runWithTargetBudget } from '../pipeline/targetBudget';
import { SEMANTIC_PLAN_LIMITS, SEMANTIC_PLAN_RESPONSE_SCHEMA, getSemanticAnalyzerSystemPrompt,
    getSemanticAnalyzerUserPrompt, parseSemanticAnalysis } from '../roles/semanticAnalyzer';
import { semanticWithContractRepair } from '../roles/semanticContractRepair';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const shortPlan = JSON.stringify({ test_strategy: {
    approach: 'Call the selected target with its exact observed setup and compare the observed result.',
    input_hints: [], assertion_style: 'assertEqual', mock_needed: false, key_rules: []
} });

test('semantic callbacks carry their original attempt and stage deadlines independently through format correction', async () => {
    let clock = 0;
    const deadlines: Array<{ initial: number; stage: number }> = [];
    const result = await semanticWithContractRepair({ prompt: 'Complete unchanged evidence', deadlineAt: 120000,
        attemptTimeoutSeconds: 60, now: () => clock, checkCurrent: () => {}, event: () => {},
        request: async (_prompt, initial, _reserve, stage) => {
            deadlines.push({ initial, stage });
            clock += deadlines.length === 1 ? 45000 : 1000;
            return deadlines.length === 1 ? '{}' : shortPlan;
        } });
    assert.ok(result);
    assert.deepEqual(deadlines, [{ initial: 60000, stage: 120000 }, { initial: 105000, stage: 120000 }]);
});

test('semantic dual deadlines preserve a tighter original target and propagate cancellation unchanged', async () => {
    let clock = 0;
    const budget = new TargetBudget({ now: () => clock, timeoutMs: 90000 });
    const cancellation = new Error('owned-cancellation');
    let requests = 0;
    await assert.rejects(runWithTargetBudget(budget, () => semanticWithContractRepair({
        prompt: 'Complete unchanged evidence', deadlineAt: 120000, attemptTimeoutSeconds: 60,
        now: () => clock, checkCurrent: () => {}, event: () => assert.fail('cancelled transport must not request format correction'),
        request: async (_prompt, initial, _reserve, stage) => {
            requests++;
            assert.equal(initial, 60000);
            assert.equal(stage, 90000);
            clock += 10000;
            throw cancellation;
        } })), error => error === cancellation);
    assert.equal(requests, 1);
    assert.equal(budget.deadlineAt, 90000);
});

test('Writer Python compatibility never turns Analyst structured output into general text', () => {
    for (const testGenerationReady of [undefined, false, true]) {
        for (const testGenerationMode of [undefined, 'python', 'plain-python', '純 Python unittest', '結構化 JSON unittest']) {
            const profile = { testGenerationReady, testGenerationMode };
            assert.equal(selectAnalysisResponseFormat(profile), 'json');
            assert.equal(selectTestGenerationResponseFormat(profile), 'text');
        }
    }
});

test('short Analyst schema requires a plan while dependency and path summaries are optional and bounded', () => {
    const schema = SEMANTIC_PLAN_RESPONSE_SCHEMA as any;
    assert.deepEqual(schema.required, ['test_strategy']);
    assert.equal(schema.additionalProperties, false);
    const strategy = schema.properties.test_strategy;
    assert.equal(strategy.properties.approach.maxLength, 240);
    assert.equal(strategy.properties.input_hints.maxItems, 2);
    assert.equal(strategy.properties.key_rules.maxItems, 3);
    assert.equal(schema.properties.dependency_behaviors.maxItems, 1);
    assert.equal(schema.properties.unreachable_paths.maxItems, 1);
    assert.equal(schema.properties.mock_required_for.maxItems, 2);
    assert.equal(strategy.properties.input_hints.items.properties.boundary_inputs.maxItems, 2);
    assert.equal(strategy.properties.input_hints.items.properties.invalid_inputs.maxItems, 2);
    const parsed = parseSemanticAnalysis(shortPlan);
    assert.ok(parsed);
    assert.deepEqual(parsed.dependency_behaviors, []);
    assert.deepEqual(parsed.unreachable_paths, []);
    assert.deepEqual(parsed.mock_required_for, []);
    assert.deepEqual(parsed.test_strategy.input_hints, []);
});

test('bounded new plans retain the existing rejection gates and do not truncate older valid plans', () => {
    assert.equal(parseSemanticAnalysis('{"test_strategy":{}}'), null);
    assert.equal(parseSemanticAnalysis('{"test_strategy":{"approach":"<APPROACH>"}}'), null);
    const approach = 'Exercise every caller-bound source condition. '.repeat(20);
    const hints = ['one', 'two', 'three', 'four'].map(param_name => ({ param_name,
        strategy: 'Use a source-supported scalar boundary.', boundary_inputs: ['0'], invalid_inputs: [], notes: '' }));
    const legacy = parseSemanticAnalysis(JSON.stringify({ dependency_behaviors: [], unreachable_paths: [],
        test_strategy: { approach, input_hints: hints, key_rules: [], assertion_style: 'mixed', mock_needed: false } }));
    assert.ok(legacy);
    assert.equal(legacy.test_strategy.approach, approach.trim());
    assert.deepEqual(legacy.test_strategy.input_hints, hints);
});

test('short response instructions preserve complete target source and caller evidence', () => {
    const source = 'def selected(value):\n    # ' + 'complete evidence '.repeat(100) + '\n    return value\n';
    const call = 'selected("exact caller spelling")';
    const prompt = getSemanticAnalyzerUserPrompt({ schemaVersion: 'analysis-evidence-v2',
        target: { moduleName: 'neutral', functionName: 'selected', source, sourceHash: 'bound-source' },
        dependencies: [], callSites: [{ caller_func: 'caller', call_expr: call }] });
    assert.ok(prompt.includes(source));
    assert.ok(prompt.includes(call));
    const system = getSemanticAnalyzerSystemPrompt();
    assert.match(system, /one initial unittest scenario/);
    assert.match(system, new RegExp(`at most ${SEMANTIC_PLAN_LIMITS.approachCharacters} characters`));
    assert.match(system, /never truncate or alter evidence/);
    assert.match(system, /invalid_inputs does not prove an exception/);
    assert.match(system, /Without verified dependency observations, leave dependency_behaviors empty/);
});

test('one Analyst format correction gets a full bounded attempt after an invalid first reply', async () => {
    let clock = 0;
    const stageDeadline = boundedRoleStageDeadline(60, 2, undefined, clock);
    const deadlines: number[] = [];
    const events: Array<{ status: string; detail: any }> = [];
    const result = await semanticWithContractRepair({ prompt: 'Complete evidence', deadlineAt: stageDeadline,
        attemptTimeoutSeconds: 60, now: () => clock, targetParameters: [], checkCurrent: () => {},
        event: (status, detail) => events.push({ status, detail }), request: async (_prompt, deadline) => {
            deadlines.push(deadline);
            clock += deadlines.length === 1 ? 40_000 : 50_000;
            return deadlines.length === 1 ? 'PRIVATE_NON_JSON_RESPONSE' : shortPlan;
        } });
    assert.ok(result);
    assert.deepEqual(deadlines, [60_000, 100_000]);
    const repair = events.find(event => event.status === 'repair-requested')!;
    assert.equal(repair.detail.attemptAllowanceMs, 60_000);
    assert.equal(repair.detail.remainingStageMs, 80_000);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_NON_JSON_RESPONSE/);
});

test('fresh Analyst attempt allowances never extend the enclosing target deadline', async () => {
    let clock = 0;
    const budget = new TargetBudget({ now: () => clock, timeoutMs: 70_000 });
    const deadlines: number[] = [];
    const result = await runWithTargetBudget(budget, () => semanticWithContractRepair({
        prompt: 'Complete evidence', deadlineAt: 120_000, attemptTimeoutSeconds: 60, now: () => clock,
        targetParameters: [], checkCurrent: () => {}, event: () => {}, request: async (_prompt, deadline) => {
            deadlines.push(deadline); clock += deadlines.length === 1 ? 40_000 : 20_000;
            return deadlines.length === 1 ? '{}' : shortPlan;
        } }));
    assert.ok(result);
    assert.deepEqual(deadlines, [60_000, 70_000]);
});

test('Analyst transport timeout propagates without a fresh correction or unbounded retry', async () => {
    const failure = new AnalysisStageError('timeout', 'model-request', 'Owned request deadline expired.');
    let calls = 0;
    await assert.rejects(semanticWithContractRepair({ prompt: 'Complete evidence', deadlineAt: 120_000,
        attemptTimeoutSeconds: 60, now: () => 0, checkCurrent: () => {}, event: () => {}, request: async () => {
            calls++; throw failure;
        } }), error => error === failure);
    assert.equal(calls, 1);
});

test('invalid Analyst attempt budgets are rejected before model transport', async () => {
    for (const attemptTimeoutSeconds of [0, -1, Infinity, NaN]) {
        let calls = 0;
        await assert.rejects(semanticWithContractRepair({ prompt: 'Complete evidence', deadlineAt: 120_000,
            attemptTimeoutSeconds, now: () => 0, checkCurrent: () => {}, event: () => {}, request: async () => {
                calls++; return shortPlan;
            } }), TypeError);
        assert.equal(calls, 0);
    }
});
