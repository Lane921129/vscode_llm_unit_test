import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BehaviorObservations } from '../pipeline/evidenceContracts';
import { contextInputBudget, estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { AnalysisEvidenceV2, buildSemanticAnalyzerSystemPrompt, getSemanticAnalyzerUserPrompt } from '../roles/semanticAnalyzer';

const evidence = (overrides: Partial<AnalysisEvidenceV2> = {}): AnalysisEvidenceV2 => ({
    schemaVersion: 'analysis-evidence-v2',
    target: { moduleName: 'sample', functionName: 'choose', sourceHash: 'a'.repeat(64),
        source: 'def choose(value):\n    return value\n' },
    callSites: [], dependencies: [], ...overrides
});

const jsonSection = (prompt: string, heading: string) => JSON.parse(prompt.split(heading + '\n')[1].split('\n')[0]);

test('Analyst fixed instructions fit a smaller envelope without dropping evidence or role constraints', () => {
    const system = buildSemanticAnalyzerSystemPrompt();
    // The previous fixed system alone used 1,092 estimated tokens, before its repeated user TASK.
    assert.ok(estimatePromptTokens(system) <= 820, `fixed instructions use ${estimatePromptTokens(system)} tokens`);
    assert.match(system, /test_strategy.*approach/);
    assert.match(system, /meaningful test_strategy is required/);
    assert.match(system, /runner selects rules and executes probes/);
    assert.match(system, /Do not write tests or classify equivalent mutants/);
    assert.match(system, /only their exact call and constructor\/setup/);
    assert.match(system, /diagnostics, not target exceptions or expected values/);
    assert.match(system, /not output\/exception proof/);
    assert.match(system, /never omit tests on that basis or patch the target\/class/);
    assert.match(system, /No direct network, file I\/O, shell, dynamic execution or shared SQLite/);
    assert.match(system, /Return JSON only/);
    const prompt = getSemanticAnalyzerUserPrompt(evidence());
    assert.doesNotMatch(prompt, /TASK:|Array item shapes:|Evidence rules:/);
    assert.match(prompt, /Analyze this evidence using the role contract/);
});

test('source and required setup remain complete beyond old count limits and preserve binding details', () => {
    const source = '\r\n\r\ndef choose(值):\r\n    return 值\r\n\r\n';
    const setup = evidence({ target: { moduleName: 'sample', functionName: 'Choose.choose', sourceHash: 'b'.repeat(64), source },
        astFacts: { args: ['值'], method_kind: 'instance', class_name: 'Choose',
            file_imports: Array.from({ length: 13 }, (_, index) => ({ kind: 'import', module: `helper_${index}` })),
            referenced_globals: Array.from({ length: 9 }, (_, index) => ({ name: `VALUE_${index}`, code: `VALUE_${index} = ${index}` })),
            class_context: { name: 'Choose', bases: ['Base'], class_attrs: [{ name: 'field', code: 'field = "class-tail"' }],
                init: { signature: Array.from({ length: 13 }, (_, index) => ({ name: `arg_${index}`, kind: 'KEYWORD_ONLY', required: true })),
                    assigns: Array.from({ length: 9 }, (_, index) => ({ name: `field_${index}`, code: `self.field_${index} = arg_${index}` })) },
                effective_init: { defined_on: 'Base', signature: [{ name: 'owner', required: true, kind: 'POSITIONAL_ONLY' }],
                    assigns: [{ name: 'owner', code: 'self.owner = owner' }] },
                inherited_context: [{ name: 'Base', class_attrs: [{ name: 'inherited', code: 'inherited = "ancestor-tail"' }] }] },
            property_context: { getter: 'property-tail', setter: null } } });
    const prompt = getSemanticAnalyzerUserPrompt(setup);
    assert.ok(prompt.includes('```python\n' + source + '\n```'));
    assert.match(prompt, /Source hash: b{64}/);
    assert.match(prompt, /Target function parameters: 值\./);
    for (const marker of ['helper_12', 'VALUE_8 = 8', 'arg_12 (required) [KEYWORD_ONLY]', 'self.field_8 = arg_8',
        'owner (required) [POSITIONAL_ONLY]', 'self.owner = owner', 'class-tail', 'ancestor-tail', 'property-tail']) {
        assert.ok(prompt.includes(marker), marker);
    }
    assert.match(prompt, /does not prove a return value, exception, or external side effect/);
});

test('controlled observation projection keeps complete assertion facts while leaving snapshots in artifacts', () => {
    const longRepr = "'" + 'value'.repeat(80) + "-tail'";
    const artifactValue = 'artifact-snapshot-only-' + 'x'.repeat(16000);
    const snapshot = { replayable: true, args: { schema_version: 'trace-value-v1' as const, replayable: true,
        value: { type: 'str', value: artifactValue } } };
    const observations: BehaviorObservations = { func_name: 'choose', args: ['value'], load_error: null, complete: false,
        blocked_operations: ['socket.connect'],
        cases: [{ case_id: 'blocked', status: 'blocked', source: { kind: 'source_guided' }, input_before: snapshot,
            input_after: null, duration_ms: 1, call_assertable: false }],
        examples: Array.from({ length: 6 }, (_, index) => ({ case_id: `case-${index}`, args: [String(index), longRepr],
            kwargs: { suffix: longRepr }, constructor_args: [longRepr], constructor_kwargs: { owner: longRepr },
            result: longRepr, result_type: 'str', result_assertable: index !== 5, result_truncated: index === 5,
            call_assertable: index !== 5, inputs_mutated: index === 5, input_before: snapshot, input_after: snapshot })),
        errors: [{ case_id: 'error', args: [longRepr], constructor_kwargs: { owner: longRepr }, exception: 'CustomError',
            exception_module: 'sample', exception_qualname: 'Owner.CustomError', message: longRepr, call_assertable: true }] };
    const prompt = getSemanticAnalyzerUserPrompt(evidence({ initialTargetObservations: observations }));
    const projected = jsonSection(prompt, '=== VERIFIED TARGET EXECUTION OBSERVATIONS ===');
    assert.equal(projected.examples.length, 6);
    assert.deepEqual(projected.examples[5], { args: ['5', longRepr], kwargs: { suffix: longRepr },
        constructor_args: [longRepr], constructor_kwargs: { owner: longRepr }, result: longRepr, result_type: 'str',
        result_assertable: false, result_truncated: true, call_assertable: false, inputs_mutated: true, case_ids: ['case-5'] });
    assert.deepEqual(projected.errors[0], { args: [longRepr], constructor_kwargs: { owner: longRepr }, exception: 'CustomError',
        exception_module: 'sample', exception_qualname: 'Owner.CustomError', message: longRepr, call_assertable: true, case_ids: ['error'] });
    assert.deepEqual(projected.caseStatuses, { blocked: 1 });
    assert.deepEqual(projected.blocked_operations, ['socket.connect']);
    assert.equal(projected.complete, false);
    assert.match(projected.snapshotDetails, /artifact-only; not state assertions/);
    assert.ok(!prompt.includes(artifactValue));
    assert.match(prompt, /truncated or unassertable records are diagnostics/);
});

test('all supplied dependency sources, source bindings and caller evidence survive the projection', () => {
    const dependencies = Array.from({ length: 5 }, (_, index) => ({ name: `helper_${index}`, sourceHash: `hash-${index}`,
        code: `\n\ndef helper_${index}(value):\n    return value\n\n`,
        observations: { func_name: `helper_${index}`, args: ['value'], examples: [{ args: ['None'], result: 'None' }],
            errors: [], load_error: null } }));
    const callSites = Array.from({ length: 7 }, (_, index) => ({ caller_func: `caller_${index}`, call_expr: `choose(${index})` }));
    const prompt = getSemanticAnalyzerUserPrompt(evidence({ dependencies, callSites }));
    for (const item of dependencies) {
        assert.ok(prompt.includes('\n' + item.code + '\n```'));
        assert.ok(prompt.includes('# Source hash: ' + item.sourceHash));
    }
    const facts = jsonSection(prompt, '=== VERIFIED DEPENDENCY EXECUTION FACTS ===');
    assert.equal(facts.length, 5);
    assert.equal(facts[4].sourceHash, 'hash-4');
    assert.equal(facts[4].observations.examples[0].result, 'None');
    for (const item of callSites) { assert.ok(prompt.includes(`In ${item.caller_func}: ${item.call_expr}`)); }
    assert.match(prompt, /INPUT CANDIDATES ONLY/);
    assert.match(prompt, /Dependency results are not target results/);
});

test('over-budget required evidence stays intact and must fail the existing gate', () => {
    const source = 'def choose(value):\n    text = "' + '資料'.repeat(2000) + 'source-tail"\n    return value\n';
    const prompt = getSemanticAnalyzerUserPrompt(evidence({ target: { moduleName: 'sample', functionName: 'choose',
        sourceHash: 'c'.repeat(64), source } }));
    assert.ok(prompt.includes(source));
    assert.equal(promptFits(buildSemanticAnalyzerSystemPrompt(), prompt, contextInputBudget('3B', 5000)), false);
});
