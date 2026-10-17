import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactWriterContext, buildWriterRevisionContext, partitionWriterObservations } from '../prompts/compactWriterContext';
import { estimatePromptTokens, promptFits } from '../prompts/promptBudget';
import { BehaviorObservations, dependencyContextsForPrompt, observationsForPrompt, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { getSemanticAnalyzerUserPrompt } from '../roles/semanticAnalyzer';

const evidence: WriterEvidenceBundleV3 = { schemaVersion: 'writer-evidence-v3', sourceHash: 'a'.repeat(64), semanticGuidance: '',
    ruleSelection: { schemaVersion: 'rule-selection-v2', sourceHash: 'a'.repeat(64), ids: [], selectedRules: [], guidance: '',
        provenance: 'deterministic', dispatcherVersion: 'test-rule-dispatcher-v2' },
    evidencePriority: ['executed-observations', 'explicit-source-paths', 'ast-structure', 'analyst-hypotheses-and-rule-guidance'] };
const source = 'def load():\n    return connector(str(DB_PATH))\n';
const render = (context: any, currentSource = source) => buildCompactWriterContext({ module: 'sample', name: 'load',
    source: currentSource, context, evidence, budgetTokens: 6000 });
const setup = (prompt: string) => JSON.parse(prompt.match(/SETUP FACTS[^\n]*\n([^\n]+)/)![1]);
const section = (prompt: string, prefix: string) => JSON.parse(prompt.match(new RegExp(prefix + '[^\\n]*\\n([^\\n]+)'))![1]);
const trace = (): BehaviorObservations => ({ func_name: 'load', args: ['value'], run_id: 'observed-run', complete: true, load_error: null,
    examples: [{ case_id: 'return', args: ['1'], result: '7', call_assertable: true, result_assertable: true },
        { case_id: 'ambient', args: ['2'], result: '<private tool representation>', result_type: 'non_assertable',
            result_assertable: false, call_assertable: false, oracle_reason: 'uncontrolled-ambient-read',
            non_deterministic_operations: ['clock'] }],
    errors: [{ case_id: 'error', args: ['0'], exception: 'ValueError', call_assertable: true },
        { case_id: 'blocked', args: ['3'], exception: 'TraceSafetyError', call_assertable: false, oracle_reason: 'unreplayable-input' }],
    blocked_operations: ['network connection'] });

test('module global declarations remain distinct original source rather than evaluated or renamed expected values', () => {
    const globals = [{ name: 'DB_NAME', code: 'DB_NAME = "neutral.db"\n' },
        { name: 'DB_PATH', code: 'DB_PATH = compute_root() / DB_NAME  # source declaration only\n', resolution: 'unknown' }];
    const context = { referenced_globals: globals, args: [], calls: ['connector', 'str'] };
    const before = JSON.stringify(context), prompt = render(context), facts = setup(prompt);
    assert.match(prompt, /SOURCE SETUP \(read-only declarations, not evaluated values/);
    assert.deepEqual(facts.globals.map((item: any) => item.name), ['DB_NAME', 'DB_PATH']);
    globals.forEach(item => assert.equal(prompt.split(item.code).length - 1, 1));
    assert.equal(facts.globals[1].resolution, 'unknown');
    assert.ok(facts.globals.every((item: any) => Object.hasOwn(item.code, 'same_complete_source_as')));
    assert.match(prompt, /canonical target module/); assert.match(prompt, /do not rename or evaluate/);
    assert.doesNotMatch(prompt, /evaluatedValue|resolvedValue|"expected"/); assert.equal(JSON.stringify(context), before);
});

test('source setup preserves module, relative from-import and aliases exactly once without inventing patch permission', () => {
    const current = 'def load():\n    return connector(DB_PATH) + transport.fetch()\n';
    const file_imports = [{ kind: 'from', module: 'boundary', level: 1, name: 'connect', alias: 'connector', bound_name: 'connector' },
        { kind: 'import', module: 'neutral_transport.api', name: null, alias: 'transport', bound_name: 'transport' }];
    const prompt = render({ code: current, file_imports, calls: ['connector', 'transport.fetch'] }, current);
    const facts = setup(prompt);
    assert.equal(facts.imports[0].sourceSpelling, 'from .boundary import connect as connector');
    assert.equal(facts.imports[1].sourceSpelling, 'import neutral_transport.api as transport');
    facts.imports.forEach((item: any, index: number) => {
        const { sourceSpelling: _spelling, ...original } = item; assert.deepEqual(original, file_imports[index]);
        assert.equal(prompt.split(item.sourceSpelling).length - 1, 1);
    });
    assert.match(prompt, /"imports":\{"same_complete_setup_as":"SOURCE SETUP.imports"\}/);
    assert.match(prompt, /No patch list was supplied/); assert.match(prompt, /source imports alone do not prove a patch is allowed/);
});

test('constructor, inheritance and property source snippets keep complete metadata without synthesizing constructor execution', () => {
    const assigned = 'self.client = client\n';
    const getter = '@property\ndef item(self):\n    return self.client.value\n';
    const context = { class_name: 'Holder', class_context: { name: 'Holder', bases: ['Base'],
        class_attrs: [{ name: 'MODE', code: 'MODE = "neutral"\n' }],
        init: { params: ['client'], required_params: ['client'], signature: [{ name: 'client', required: true }],
            assigns: [{ name: 'client', code: assigned }], unknown_state: 'unresolved constructor branch' },
        inherited_context: [{ name: 'Base', init: { params: ['client'], assigns: [{ name: 'client', code: assigned }] } }],
        effective_init: { defined_on: 'Base', params: ['client'], assigns: [{ name: 'client', code: assigned }] } },
        property_context: { name: 'item', getter: { code: getter, signature: [], is_async: false }, setter: null, deleter: null } };
    const before = JSON.stringify(context), prompt = render(context), facts = setup(prompt);
    const requiredSetup = prompt.split('FIXTURE CHECK:')[0];
    assert.equal(requiredSetup.split(assigned).length - 1, 1); assert.equal(requiredSetup.split(getter).length - 1, 1);
    assert.deepEqual(facts.constructor.init.signature, context.class_context.init.signature);
    assert.equal(facts.constructor.init.unknown_state, 'unresolved constructor branch');
    assert.equal(facts.constructor.effective_init.defined_on, 'Base'); assert.equal(facts.property.setter, null);
    assert.match(prompt, /not proof of a complete constructor body or executed state/);
    assert.doesNotMatch(requiredSetup, /def __init__/); assert.equal(JSON.stringify(context), before);
});

test('large retrieved helpers remain complete with each identity and one exact body even across same named sources', () => {
    const helper = 'def helper(value):\n' + '    # complete retained helper body\n'.repeat(900) + '    return value\n# HELPER_TAIL\n';
    const second = helper + '# DISTINCT_VERSION\n';
    const dependencies = [helper, second, second].map((code, index) => ({ name: 'helper', code, sourceHash: String(index + 1).repeat(64),
        referenced_globals: [{ name: 'DB_NAME', code: 'DB_NAME = "neutral.db"\n' }], retrieval: { status: 'resolved', unresolved: ['unknown call'] } }));
    const context = { dependencyContexts: dependencies }, before = JSON.stringify(context);
    const prompt = render(context);
    assert.equal(prompt.split(second).length - 1, 1); assert.ok(prompt.includes(helper));
    dependencies.forEach(dep => assert.ok(prompt.includes(dep.sourceHash)));
    assert.match(prompt, /Complete source is identical to RETRIEVED DEPENDENCY helper \[2\]/);
    assert.match(prompt, /unknown call/); assert.equal(JSON.stringify(context), before);
    assert.equal(promptFits('', prompt, 6000), false);
});

test('nonassertable and blocked diagnostics never appear under verified target or dependency observations', () => {
    const observations = trace(), before = JSON.stringify(observations);
    const prompt = render({ traceResult: observations, dependencyContexts: [{ name: 'helper', code: 'def helper(): return 1\n',
        sourceHash: 'b'.repeat(64), traceResult: observations }] });
    const verified = section(prompt, 'VERIFIED OBSERVATIONS'), dependencies = section(prompt, 'VERIFIED DEPENDENCY OBSERVATIONS');
    const diagnostics = section(prompt, 'DIAGNOSTICS');
    assert.deepEqual(verified.examples.map((item: any) => item.case_ids), [['return']]);
    assert.deepEqual(verified.errors.map((item: any) => item.case_ids), [['error']]);
    assert.doesNotMatch(JSON.stringify([verified, dependencies]), /private tool representation|TraceSafetyError|ambient|non_assertable/);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private tool representation|"result_type":"non_assertable"/);
    for (const reason of ['artifact-only; non-assertable return', 'uncontrolled-ambient-read', 'TraceSafetyError']) {
        assert.ok(JSON.stringify(diagnostics).includes(reason), reason);
    }
    assert.deepEqual(diagnostics.target.blocked_operations, ['network connection']);
    assert.equal(diagnostics.dependencies[0].dependencyIndex, 1); assert.equal(diagnostics.dependencies[0].sourceHash, 'b'.repeat(64));
    assert.match(prompt, /never expected values, expected exceptions, fixture returns or fixture types/);
    assert.equal(JSON.stringify(observations), before);
});

test('opaque return diagnostics cannot become model fixture values or types while original evidence stays intact', () => {
    const observations = trace();
    observations.examples[1] = { case_id: 'opaque-a', args: [], result: '<non_assertable: OpaqueHandleA>',
        result_type: 'OpaqueHandleA', result_assertable: false, call_assertable: true };
    observations.examples.push({ ...observations.examples[1], case_id: 'opaque-b',
        result: '<non_assertable: OpaqueHandleB>', result_type: 'OpaqueHandleB' });
    observations.examples.push({ ...observations.examples[1], case_id: 'opaque-a-repeat' });
    const before = JSON.stringify(observations);
    const projected = observationsForPrompt(observations) as any;
    assert.deepEqual(projected.examples[0], { args: ['1'], result: '7', call_assertable: true,
        result_assertable: true, case_ids: ['return'] });
    assert.equal(projected.examples.length, 3, 'different opaque outcomes remain distinct; only identical facts group');
    assert.deepEqual(projected.examples.slice(1).map((item: any) => item.case_ids),
        [['opaque-a', 'opaque-a-repeat'], ['opaque-b']]);
    projected.examples.slice(1).forEach((item: any) => {
        assert.equal(Object.hasOwn(item, 'result'), false);
        assert.equal(Object.hasOwn(item, 'result_type'), false);
        assert.equal(item.result_assertable, false);
        assert.equal(item.call_assertable, true);
        assert.equal(item.resultDetails, 'artifact-only; non-assertable return');
    });
    const dependency = { name: 'helper', code: 'def helper(): return connector()\n',
        sourceHash: 'b'.repeat(64), traceResult: observations };
    const context = { traceResult: observations, dependencyContexts: [dependency] };
    const prompts = [render(context), buildWriterRevisionContext({ module: 'sample', name: 'load', source, context, evidence }),
        getSemanticAnalyzerUserPrompt({ schemaVersion: 'analysis-evidence-v2',
            target: { moduleName: 'sample', functionName: 'load', source, sourceHash: 'a'.repeat(64) }, callSites: [],
            initialTargetObservations: observations, dependencies: [{ ...dependency, observations }] }),
        JSON.stringify(dependencyContextsForPrompt([dependency]))];
    prompts.forEach(prompt => {
        assert.doesNotMatch(prompt, /OpaqueHandleA|OpaqueHandleB/);
        assert.match(prompt, /opaque-a-repeat/);
        assert.match(prompt, /"result_assertable":false/);
        assert.match(prompt, /artifact-only; non-assertable return/);
    });
    const split = partitionWriterObservations(observations);
    assert.deepEqual((split.observations!.examples as any[]).map(item => item.case_ids), [['return']]);
    assert.equal((split.diagnostics!.examples as any[]).length, 2);
    assert.equal(JSON.stringify(observations), before);
});

test('assertable literal sentinel text stays exact; explicit unavailable returns keep their safety reasons', () => {
    const observations = trace();
    observations.examples = [{ args: [], result: "'<non_assertable: ordinary string>'", result_type: 'str',
        result_assertable: true, call_assertable: true }];
    const literal = observationsForPrompt(observations) as any;
    assert.equal(literal.examples[0].result, observations.examples[0].result);
    assert.equal(literal.examples[0].result_type, 'str');
    for (const flags of [{ result_assertable: false }, { call_assertable: false }, { result_truncated: true },
        { oracle_reason: 'uncontrolled-ambient-read' as const }, { non_deterministic_operations: ['clock'] }]) {
        const current = { ...observations, examples: [{ ...observations.examples[0], ...flags }] };
        const before = JSON.stringify(current), result = (observationsForPrompt(current) as any).examples[0];
        assert.equal(Object.hasOwn(result, 'result'), false);
        assert.equal(Object.hasOwn(result, 'result_type'), false);
        for (const [key, value] of Object.entries(flags)) { assert.deepEqual(result[key], value); }
        assert.equal(JSON.stringify(current), before);
    }
});

test('observation partition is lossless for producer safety flags and complete phase metadata', () => {
    const observations = trace();
    (observations.examples[1] as any).unknown_safety_detail = { reason: 'do not erase this diagnostic', flag: null };
    const original = observationsForPrompt(observations) as any, split = partitionWriterObservations(observations);
    const { observationRunId: _run, ...metadata } = split.diagnostics as any;
    const combined = { ...metadata, examples: [...split.observations!.examples as any[], ...metadata.examples],
        errors: [...split.observations!.errors as any[], ...metadata.errors] };
    assert.deepEqual(combined, original);
    assert.equal((split.diagnostics!.examples as any[])[0].result_assertable, false);
    assert.deepEqual((split.diagnostics!.examples as any[])[0].unknown_safety_detail,
        { reason: 'do not erase this diagnostic', flag: null });
    for (const flag of [false, undefined]) {
        const incomplete = partitionWriterObservations({ ...observations, complete: flag });
        assert.equal((incomplete.observations!.examples as any[]).length, 0);
        assert.equal((incomplete.diagnostics!.examples as any[]).length, observations.examples.length);
    }
    for (const field of ['call_assertable', 'result_assertable', 'result_truncated']) {
        for (const flag of [null, 'true', 0, {}]) {
            const uncertain = trace(); (uncertain.examples[0] as any)[field] = flag;
            const split = partitionWriterObservations(uncertain);
            assert.equal((split.observations!.examples as any[]).length, 0, `${field}=${JSON.stringify(flag)}`);
            assert.deepEqual((split.diagnostics!.examples as any[])[0][field], flag, 'unknown producer flags stay intact in diagnostics');
        }
    }
});

test('initial case selection remains exact while revisions retain all observations and diagnostics', () => {
    const observations = trace();
    const input = { module: 'sample', name: 'load', source, context: { traceResult: observations }, evidence,
        scenarioCaseIds: ['ambient'], budgetTokens: 6000 };
    const initial = buildCompactWriterContext(input), revised = buildWriterRevisionContext(input);
    assert.equal(section(initial, 'VERIFIED OBSERVATIONS').examples.length, 0);
    assert.deepEqual(section(initial, 'DIAGNOSTICS').target.examples[0].case_ids, ['ambient']);
    assert.doesNotMatch(initial, /"case_ids":\["return"\]|"case_ids":\["error"\]/);
    assert.match(initial, /Other cases remain in the artifact/);
    for (const id of ['return', 'ambient', 'error', 'blocked']) { assert.ok(revised.includes(`"${id}"`)); }
    assert.doesNotMatch(revised, /SCENARIO SELECTION: exact case IDs/);
});

test('existing private resource aliases are rendered verbatim without expanding or computing original locations', () => {
    const declaration = 'DB_PATH = RESOURCE_ALIAS_1\n';
    const prompt = render({ referenced_globals: [{ name: 'DB_PATH', code: declaration, resourceAlias: 'RESOURCE_ALIAS_1', addressStatus: 'unknown' }] });
    assert.equal(prompt.split(declaration).length - 1, 1);
    assert.equal(setup(prompt).globals[0].resourceAlias, 'RESOURCE_ALIAS_1');
    assert.equal(setup(prompt).globals[0].addressStatus, 'unknown');
    assert.doesNotMatch(prompt, /C:\\Users|\/\/private-server|resolvedValue/);
});

test('different setup owners share only identical source snippets, reducing real repetition without collapsing metadata', () => {
    const constructor = 'def __init__(self, client):\n' + '    # complete neutral setup source\n'.repeat(450) + '    self.client = client\n';
    const classes = Array.from({ length: 4 }, (_, index) => ({ name: `Holder${index}`, init: { code: constructor, params: ['client'] },
        unknown: `OWNER_SPECIFIC_${index}` }));
    const dependencies = classes.slice(1).map((class_context, index) => ({ name: `helper${index}`, sourceHash: String(index + 1).repeat(64),
        code: `def helper${index}(): return ${index}\n`, class_context }));
    const prompt = render({ class_context: classes[0], dependencyContexts: dependencies });
    const formerRepeatedFields = JSON.stringify({ constructor: classes[0], dependencies });
    assert.equal(prompt.split(constructor).length - 1, 1);
    classes.forEach((item, index) => { assert.ok(prompt.includes(item.name)); assert.ok(prompt.includes(`OWNER_SPECIFIC_${index}`)); });
    assert.ok(estimatePromptTokens(prompt) < estimatePromptTokens(formerRepeatedFields) * 0.5,
        'source snippets are deduplicated even when their enclosing class metadata differs');
});
