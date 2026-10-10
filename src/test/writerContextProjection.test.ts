import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactWriterContext, buildWriterRevisionContext, selectWriterScenario } from '../prompts/compactWriterContext';
import { formatDependencyTopology, relevantSourceImports } from '../prompts/dependencyMockContract';
import { BehaviorObservations, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { getSystemPrompt, getUserPrompt } from '../roles/unittestWriter';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { dispatchTestRules } from '../pipeline/testRuleDispatcher';

const evidence: WriterEvidenceBundleV3 = {
    schemaVersion: 'writer-evidence-v3', sourceHash: 'bound-source-hash', semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'bound-source-hash', ids: [], selectedRules: [],
        guidance: '', provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance']
};
const source = 'def load(value):\n    return client.fetch(value)';
const imports = [
    { kind: 'import', module: 'neutral_transport', alias: 'client', bound_name: 'client' },
    { kind: 'from', module: 'neutral_constructor', name: 'Builder', bound_name: 'Builder' },
    { kind: 'import', module: 'neutral_defaults', bound_name: 'neutral_defaults' },
    ...Array.from({ length: 60 }, (_, i) => ({ kind: 'import', module: `unrelated_library_${i}`, bound_name: `unrelated_library_${i}` }))
];
const trace: BehaviorObservations = { schema_version: 'behavior-observations-v2', func_name: 'load', args: ['value'],
    load_error: null, complete: true, blocked_operations: ['network'],
    examples: [
        { case_id: 'A', args: ['1'], result: '7', constructor_args: ['factory_A'], result_assertable: true },
        { case_id: 'B', args: ['2'], result: '9', constructor_args: ['factory_B'], result_assertable: false,
            oracle_reason: 'uncontrolled-ambient-read', non_deterministic_operations: ['clock'] }
    ], errors: [{ case_id: 'C', args: ['3'], exception: 'ValueError', call_assertable: false, oracle_reason: 'unreplayable-input' }] };

test('compact import projection keeps exact aliases and setup bindings without unrelated module imports', () => {
    const context = { code: source, calls: ['client.fetch'], file_imports: imports, args: ['value'],
        class_context: { init: { code: 'def __init__(self, builder=Builder): self.builder = builder' } },
        referenced_globals: [{ name: 'DEFAULT', code: 'DEFAULT = neutral_defaults.value' }], traceResult: trace };
    const prompt = buildCompactWriterContext({ module: 'sample', name: 'load', source, context, evidence, budgetTokens: 6000 });
    for (const binding of ['import neutral_transport as client', 'from neutral_constructor import Builder', 'import neutral_defaults']) {
        assert.equal(prompt.split(binding).length - 1, 1, binding);
    }
    assert.doesNotMatch(prompt, /unrelated_library_/);
    assert.ok(prompt.includes(source));
    assert.match(prompt, /bound-source-hash/);
    for (const fact of ['factory_A', 'factory_B', '"result_assertable":false', '"call_assertable":false', 'uncontrolled-ambient-read', 'unreplayable-input']) {
        assert.ok(prompt.includes(fact), fact);
    }
    assert.deepEqual(relevantSourceImports({ file_imports: imports }), imports, 'missing source must not discard bindings');
    assert.equal(relevantSourceImports({ code: 'def f(): return "dynamic_binding"', file_imports: [
        { module: 'neutral', alias: 'dynamic_binding' }, { module: 'unknown', name: '*' }, { kind: 'unknown' }
    ] }).length, 3, 'string-based and unresolved bindings remain conservative');
});

test('whole explicit scenario selection retains setup and safety, while revisions retain all cases', () => {
    const context = { code: source, traceResult: trace, file_imports: imports };
    const prompt = buildCompactWriterContext({ module: 'sample', name: 'load', source, context, evidence,
        budgetTokens: 6000, scenarioCaseIds: ['B'] });
    assert.ok(prompt.includes(source));
    assert.match(prompt, /factory_B|"result_assertable":false/);
    assert.doesNotMatch(prompt, /factory_A|"exception":"ValueError"/);
    assert.match(prompt, /Other cases remain in the artifact/);
    assert.match(prompt, /"blocked_operations":\["network"\]/);
    const handedOff = getUserPrompt('sample.py', 'load', source, 'small', { ...context, writerScenarioCaseIds: ['B'] }, '', 6000, '', evidence);
    assert.match(handedOff, /factory_B/); assert.doesNotMatch(handedOff, /factory_A/);
    const revision = buildWriterRevisionContext({ module: 'sample', name: 'load', source, context, evidence, scenarioCaseIds: ['B'] });
    for (const fact of ['factory_A', 'factory_B', 'ValueError', 'unreplayable-input']) { assert.ok(revision.includes(fact), fact); }
    assert.equal(selectWriterScenario(trace, ['missing']).observations, trace, 'an unknown ID cannot silently select empty evidence');
    assert.equal(selectWriterScenario(trace, []).observations, trace);
});

test('mock consumption topology remains complete and source-bound without generic fabricated chain examples', () => {
    const topology = { schemaVersion: 'dependency-fixture-contract-v1', sourceHash: 'bound-source-hash',
        target: 'load', facts: [{ line: 2, parameter: 'client', method: 'fetch', awaits: false }], unknown: ['dynamic return shape'] };
    const prompt = buildCompactWriterContext({ module: 'sample', name: 'load', source,
        context: { args: ['client'], code: source, calls: ['client.fetch'], dependency_fixture_contract: topology },
        evidence, budgetTokens: 6000 });
    assert.ok(prompt.includes(JSON.stringify(topology)));
    assert.match(prompt, /Unknown steps remain unknown/);
    assert.match(prompt, /context-enter = source-proven with only/);
    assert.match(prompt, /never add a return_value or __enter__ layer/);
    assert.doesNotMatch(prompt, /factory_mock\.return_value\.finish|connection\.cursor/);
    assert.ok(promptFits(getSystemPrompt(1, 'small'), prompt, 6000));
});

test('generation omits a whole optional topology without dropping source, observations, imports or implying no dependencies', () => {
    const topology = { schemaVersion: 'dependency-fixture-contract-v1', target: 'load', targetSourceHash: 'bound-source-hash',
        authority: 'fixture-shape-only', assertionOracle: false, patchAuthorization: false,
        flows: Array.from({ length: 80 }, (_, i) => ({ root: { kind: 'parameter', name: 'client' },
            steps: [{ kind: 'member', name: `complete_receiver_${i}` }, { kind: 'return_value' }], method: 'fetch', line: 2 })),
        diagnostics: [{ code: 'unknown-shape', name: 'all_diagnostics_retained' }] };
    const context = { code: source, calls: ['client.fetch'], file_imports: imports, args: ['value'],
        traceResult: trace, dependency_fixture_contract: topology,
        dependencyContexts: [{ name: 'helper', code: 'def helper(value):\n    return value' }] };
    const prompt = buildCompactWriterContext({ module: 'sample', name: 'load', source, context, evidence, budgetTokens: 6000 });
    assert.ok(prompt.includes(source));
    for (const fact of ['factory_A', 'factory_B', '"result_assertable":false', '"call_assertable":false',
        'import neutral_transport as client', 'client.fetch', 'bound-source-hash']) { assert.ok(prompt.includes(fact), fact); }
    assert.match(prompt, /Topology\/legend omitted whole for budget/);
    assert.match(prompt, /not absence of dependencies/);
    assert.match(prompt, /Use complete TARGET SOURCE/);
    assert.doesNotMatch(prompt, /complete_receiver_|all_diagnostics_retained|sourceConsumption steps/);
    assert.ok(promptFits(getSystemPrompt(1, 'small'), prompt, 6000));
    const revision = buildWriterRevisionContext({ module: 'sample', name: 'load', source, context, evidence });
    assert.ok(revision.includes(JSON.stringify(topology)), 'repairs require the entire identity, graph and diagnostics');
    assert.match(revision, /context-enter = source-proven with only/);
    assert.match(revision, /Unknown steps remain unknown/);
    assert.ok(revision.includes(context.dependencyContexts[0].code), 'repair helpers cannot be dropped to fit');
    assert.ok(revision.includes(source));
    assert.doesNotMatch(revision, /Topology\/legend omitted/);
});

test('whole topology receives generation budget before optional retrieved helpers', () => {
    const topology = { schemaVersion: 'dependency-fixture-contract-v1', target: 'load', targetSourceHash: 'bound-source-hash',
        assertionOracle: false, patchAuthorization: false,
        flows: [{ root: { kind: 'parameter', name: 'client' }, steps: [], method: 'fetch', line: 2 }] };
    const context = { code: source, calls: ['client.fetch'], dependency_fixture_contract: topology,
        dependencyContexts: [{ name: 'helper', code: 'def helper(value):\n    return value' }] };
    const prompt = buildCompactWriterContext({ module: 'sample', name: 'load', source, context, evidence, budgetTokens: 6000 });
    const graph = prompt.indexOf(formatDependencyTopology(context)), helper = prompt.indexOf('RETRIEVED DEPENDENCY helper');
    assert.ok(graph >= 0 && helper > graph, 'complete topology is considered and displayed before optional helper code');
    assert.equal(prompt.split(JSON.stringify(topology)).length - 1, 1);
});

test('required long source and unique rules survive low budgets; exact duplicate rules appear once', () => {
    const longSource = 'def load(value):\n' + '    # complete source line\n'.repeat(900) + '    return value';
    const rules = { ...evidence, ruleSelection: { ...evidence.ruleSelection, ids: ['a', 'b'], selectedRules: [
        { ruleId: 'a', title: 'A', guidance: ['SHARED_FULL_CONSTRAINT', 'UNIQUE_A'], triggerFacts: [], relatedAnalystHints: [] },
        { ruleId: 'b', title: 'B', guidance: ['SHARED_FULL_CONSTRAINT', 'UNIQUE_B'], triggerFacts: [], relatedAnalystHints: [] }
    ] } };
    const prompt = buildCompactWriterContext({ module: 'sample', name: 'load', source: longSource, evidence: rules, budgetTokens: 1800 });
    assert.ok(prompt.includes(longSource));
    assert.equal(prompt.split('SHARED_FULL_CONSTRAINT').length - 1, 1);
    assert.match(prompt, /UNIQUE_A/); assert.match(prompt, /UNIQUE_B/);
    assert.match(prompt, /Identical guidance above: a/);
    assert.equal(promptFits(getSystemPrompt(1, 'small'), prompt, 1800), false);
});

test('small pure formatting target leaves room for repair even inside a module with many unrelated imports', () => {
    const code = 'def render(value):\n    parsed = Moment.strptime(value, "%Y-%m-%d")\n    return parsed.strftime("%m/%d")';
    const context = { code, args: ['value'], calls: ['Moment.strptime', 'parsed.strftime'], dependencies: [{ name: 'Moment' }],
        file_imports: [...imports, { module: 'datetime', name: 'datetime', bound_name: 'Moment', alias: 'Moment' }],
        traceResult: { func_name: 'render', args: ['value'], load_error: null, examples: [{ args: ['"2001-02-03"'], result: '"02/03"' }], errors: [] } };
    const rules = dispatchTestRules(code, context);
    const prompt = buildCompactWriterContext({ module: 'sample', name: 'render', source: code, context,
        evidence: { ...evidence, ruleSelection: rules }, budgetTokens: 6000 });
    assert.ok(prompt.includes(code));
    assert.match(prompt, /2001-02-03/);
    assert.doesNotMatch(prompt, /unrelated_library_|datetime_freezing|mock_external_dependency/);
    assert.ok(estimatePromptTokens(getSystemPrompt(1, 'small') + prompt) < 1800, 'small targets should not fill the advertised context with optional examples');
});
