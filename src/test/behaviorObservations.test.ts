import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseBehaviorObservations, recoverBehaviorProgress, mergeBehaviorObservations } from '../pipeline/behaviorObservations';
import { BehaviorObservations, ProbeCaseObservation, TraceInputSnapshot, TraceValue } from '../pipeline/evidenceContracts';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';
import { InputPlanSummary } from '../pipeline/inputPlanning';
import { AnalysisStageError } from '../utils/executionFailureCategory';

// Exact snapshot_call([1], {}, [], {}) wire structure; live Python tests below
// also exercise the real producer, including every supported tagged value.
const snapshot = (): TraceInputSnapshot => {
    const fields: Record<string, TraceValue> = { args: { type: 'list', items: [{ type: 'int', value: '1' }] },
        kwargs: { type: 'dict', items: [] }, constructor_args: { type: 'list', items: [] }, constructor_kwargs: { type: 'dict', items: [] } };
    const wrap = (value: TraceValue) => ({ schema_version: 'trace-value-v1' as const, replayable: true,
        value: JSON.parse(JSON.stringify(value)) as TraceValue });
    return { replayable: true,
        call_graph: wrap({ type: 'dict', items: Object.entries(fields).map(([key, value]) => ({ key: { type: 'str', value: key }, value })) }),
        args: wrap(fields.args), kwargs: wrap(fields.kwargs),
        constructor_args: wrap(fields.constructor_args), constructor_kwargs: wrap(fields.constructor_kwargs) };
};

const caseRecord = (id: string): ProbeCaseObservation => ({ case_id: id, status: 'returned',
    source: { kind: 'caller_literals' }, input_before: snapshot(), input_after: snapshot(), duration_ms: 1 });
const result = (): BehaviorObservations => ({ schema_version: 'behavior-observations-v2', run_id: 'run', func_name: 'target',
    args: ['value'], examples: [{ case_id: 'a', args: ['1'], result: '2', result_assertable: true }],
    errors: [], cases: [caseRecord('a')], load_error: null, isolation: 'fresh-process-per-case', complete: true });

test('malformed Trace contracts have stable tool-owned failure categories rather than module import failures', () => {
    const inputs: Array<[unknown, string]> = [
        ['{invalid', 'invalid-json'],
        [{ ...result(), schema_version: 'legacy' }, 'invalid-observation-contract'],
        [{ ...result(), input_plan: {} }, 'invalid-input-plan'],
        [{ ...result(), input_deduplication: {} }, 'invalid-probe-case-plan'],
        [{ ...result(), load_diagnostic: {} }, 'invalid-load-diagnostic'],
        [{ ...result(), cases: [caseRecord('a'), caseRecord('a')] }, 'duplicate-case-identity'],
        [{ ...result(), examples: [{ ...result().examples[0], case_id: 'not-executed' }] }, 'missing-completed-execution'],
        [{ ...result(), examples: [{ ...result().examples[0], result: undefined }] }, 'outcome-mismatch'],
        [{ ...result(), examples: [{ ...result().examples[0], input_before: {} }] }, 'input-snapshot-mismatch']
    ];
    for (const [input, reasonCode] of inputs) {
        assert.throws(() => parseBehaviorObservations(input, 'target'), error => {
            assert.ok(error instanceof AnalysisStageError);
            assert.equal(error.category, 'ast-trace');
            assert.equal(error.stage, 'trace-contract');
            assert.deepEqual(error.diagnostic, { schemaVersion: 'trace-contract-diagnostic-v1', reasonCode });
            return true;
        });
    }
});

test('plan-wide diagnostics preserve missing input and source budget failures in live and interrupted Trace', () => {
    const inputPlan: InputPlanSummary = { schema_version: 'input-plan-v1', type_shape_version: 'type-shape-v1',
        status: 'needs-input', generated_cases: 0,
        parameter_shapes: { page: { kind: 'unknown', reason: 'missing-annotation' } },
        diagnostics: [{ parameter: null, code: 'budget-exceeded', reason: 'source-node-budget' },
            { parameter: 'page', code: 'needs-input', reason: 'missing-annotation' }],
        limits: { max_nodes: 512 }, stats: { cases: 0, parameters: 1 } };
    const value: BehaviorObservations = { ...result(), args: ['page'], examples: [], cases: [],
        complete: false, planning: { status: 'completed' }, input_plan: inputPlan };
    const parsed = parseBehaviorObservations(value, 'target');
    assert.deepEqual(parsed.input_plan, inputPlan);
    assert.equal(parsed.load_error, null);
    assert.equal(parsed.complete, false);
    assert.deepEqual(parsed.examples, []);
    assert.deepEqual(parsed.errors, []);
    const events = [{ event: 'run_started', schema_version: value.schema_version, func_name: 'target' },
        { event: 'planning_completed', args: value.args, load_error: null,
            planning: value.planning, input_plan: inputPlan, planned_cases: [] }]
        .map(event => JSON.stringify({ run_id: 'run', ...event })).join('\n');
    const recovered = recoverBehaviorProgress(events, 'target', 'host interrupted')!;
    assert.deepEqual(recovered.input_plan, inputPlan);
    assert.equal(recovered.complete, false);
    assert.equal(recovered.load_error, null);
    assert.deepEqual(recovered.examples, []);
    assert.deepEqual(recovered.errors, []);
    for (const invalid of [undefined, 0, false, {}, []]) {
        const malformed = structuredClone(value) as any;
        malformed.input_plan.diagnostics[0].parameter = invalid;
        assert.throws(() => parseBehaviorObservations(malformed, 'target'), /input planning contract/);
        const invalidEvents = events.replace(JSON.stringify(inputPlan), JSON.stringify(malformed.input_plan));
        assert.equal(recoverBehaviorProgress(invalidEvents, 'target', 'interrupted'), undefined);
    }
});

test('real Python Trace source budget diagnostics retain global scope without creating observations', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-planning-diagnostics-'));
    const python = resolvePythonExecutable('', path.resolve(__dirname, '../..'));
    const file = path.join(directory, 'neutral.py');
    const progress = path.join(directory, 'trace.jsonl');
    const script = [
        'import json, sys',
        'sys.path.insert(0, sys.argv[1])',
        'from dynamic_tracer import trace_function',
        "facts = trace_function(sys.argv[2], 'target', {'schema_version': 'invalid-probe-inputs', 'cases': [{}]}, progress_path=sys.argv[3])",
        'print(json.dumps(facts))'
    ].join('\n');
    try {
        fs.writeFileSync(file, 'def target(page, row):\n'
            + Array.from({ length: 150 }, (_, index) => `    value_${index} = ${index}\n`).join('')
            + '    raise AssertionError("unprepared target must not execute")\n');
        const run = spawnSync(python, ['-B', '-c', script, path.dirname(pythonToolPath('trace')), file, progress],
            { cwd: directory, encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        const live = parseBehaviorObservations(run.stdout, 'target');
        assert.equal(live.load_error, null);
        assert.equal(live.planning!.status, 'completed');
        assert.equal(live.complete, false);
        assert.equal(live.input_plan!.status, 'needs-input');
        assert.equal(live.input_plan!.generated_cases, 0);
        assert.ok(live.input_plan!.diagnostics.some(item => item.parameter === null
            && item.code === 'budget-exceeded' && item.reason === 'source-node-budget'));
        assert.ok(live.input_plan!.diagnostics.some(item => item.parameter === 'page' && item.code === 'needs-input'));
        assert.equal(live.examples.length + live.errors.length, 0);
        assert.ok(live.cases!.every(item => item.status === 'not_started'));
        const recovered = recoverBehaviorProgress(fs.readFileSync(progress, 'utf8'), 'target', 'host interrupted')!;
        assert.deepEqual(recovered.input_plan, live.input_plan);
        assert.equal(recovered.complete, false);
        assert.equal(recovered.load_error, null);
        assert.equal(recovered.examples.length + recovered.errors.length, 0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('deduplicated Trace planning preserves origin sites and rejects inconsistent counts', () => {
    const value = result();
    value.input_deduplication = { schema_version: 'probe-case-deduplication-v1', planned_count: 33,
        unique_count: 1, duplicate_count: 32, source_count: 33 };
    value.cases![0].source_sites = Array.from({ length: 33 }, (_, line) => ({ kind: 'caller_literals', line }));
    assert.equal(parseBehaviorObservations(value, 'target').cases![0].source_sites!.length, 33);
    const events = [{ event: 'run_started', schema_version: value.schema_version, func_name: 'target' },
        { event: 'planning_completed', args: value.args, load_error: null,
            input_deduplication: value.input_deduplication, planned_cases: value.cases }]
        .map(event => JSON.stringify({ run_id: 'run', ...event })).join('\n');
    assert.deepEqual(recoverBehaviorProgress(events, 'target', 'interrupted')!.input_deduplication, value.input_deduplication);
    value.input_deduplication.duplicate_count = 31;
    assert.throws(() => parseBehaviorObservations(value, 'target'), /planning contract/);
    value.input_deduplication.duplicate_count = 32;
    value.cases![0].source_sites = [{ kind: 'fabricated' as any }];
    assert.throws(() => parseBehaviorObservations(value, 'target'), /observation contract/);
});

test('live observation parser rejects missing execution identity and non-replayable inputs cannot be oracles', () => {
    const value = result();
    value.examples[0].case_id = 'not-executed';
    assert.throws(() => parseBehaviorObservations(value, 'target'), /completed target execution/);
    value.examples[0].case_id = 'a';
    value.cases![0].input_before.replayable = false;
    value.cases![0].input_before.call_graph!.replayable = false;
    value.cases![0].input_before.call_graph!.value.items![0] = { type: 'unavailable', reason: 'shared-reference' };
    assert.equal(parseBehaviorObservations(value, 'target').examples[0].call_assertable, false);
    assert.throws(() => parseBehaviorObservations(value, 'other'), /contract/);
});

test('live v2 rejects duplicate identities and success/exception outcome mismatches', () => {
    for (const alter of [
        (value: BehaviorObservations) => { value.cases!.push(caseRecord('a')); },
        (value: BehaviorObservations) => { value.cases![0].case_id = ''; },
        (value: BehaviorObservations) => { value.run_id = ''; },
        (value: BehaviorObservations) => { value.cases![0].status = 'raised'; },
        (value: BehaviorObservations) => { value.examples[0].exception = 'ValueError'; },
        (value: BehaviorObservations) => { delete value.examples[0].result; },
        (value: BehaviorObservations) => { value.examples.push({ ...value.examples[0] }); },
        (value: BehaviorObservations) => { value.errors = [{ case_id: 'a', args: ['1'], exception: 'ValueError' }]; value.examples = []; }
    ]) {
        const value = result(); alter(value);
        assert.throws(() => parseBehaviorObservations(value, 'target'));
    }
    const raised = result();
    raised.cases![0].status = 'raised'; raised.examples = [];
    raised.errors = [{ case_id: 'a', args: ['1'], exception: 'ValueError', exception_module: 'builtins' }];
    assert.equal(parseBehaviorObservations(raised, 'target').errors.length, 1);
});

test('live snapshot validation fails closed on missing, forged and over-budget tagged values', () => {
    const changes: Array<(input: any) => void> = [
        input => { delete input.call_graph; },
        input => { delete input.replayable; },
        input => { input.args.schema_version = 'other'; },
        input => { input.args.value = { type: 'call', value: 'target()' }; },
        input => { input.args.value = { type: 'float', value: 'nan' }; },
        input => { input.args.value = { type: 'bytes', value: 'zz' }; },
        input => { input.args.value = { type: 'dict', items: [{ key: { type: 'list', items: [] }, value: { type: 'none' } }] }; },
        input => { input.args.value = { type: 'set', items: [{ type: 'list', items: [] }] }; },
        input => { input.args.value = { type: 'int', value: '1'.repeat(4097) }; },
        input => { input.args.value = { type: 'str', value: 'x'.repeat(4097) }; },
        input => { input.args.value = { type: 'list', items: Array.from({ length: 101 }, () => ({ type: 'none' })) }; },
        input => { input.args.value = { type: 'list', items: Array.from({ length: 100 }, () =>
            ({ type: 'list', items: Array.from({ length: 6 }, () => ({ type: 'none' })) })) }; },
        input => { for (let depth = 0; depth < 10; depth++) { input.args.value = { type: 'list', items: [input.args.value] }; } },
        input => { input.args.value.items = [{ type: 'unavailable', reason: 'unsupported-type' }]; },
        input => { input.args.value.items = [{ type: 'int', value: '9' }]; }
    ];
    for (const change of changes) {
        const value = result(); change(value.cases![0].input_before);
        assert.throws(() => parseBehaviorObservations(value, 'target'), /contract/);
    }
    const missing = result(); missing.cases![0].input_before = {};
    assert.throws(() => parseBehaviorObservations(missing, 'target'), /contract/);
    const mismatch = result(); mismatch.examples[0].input_before = snapshot();
    mismatch.examples[0].input_before.args!.value = { type: 'tuple', items: [] };
    assert.throws(() => parseBehaviorObservations(mismatch, 'target'), /snapshot/);
});

test('host interruption recovers completed cases and marks active/pending cases without inventing observations', () => {
    const events = [
        { event: 'run_started', schema_version: 'behavior-observations-v2', func_name: 'target' },
        { event: 'planning_completed', args: ['value'], load_error: null,
            planning: { status: 'completed' }, planned_cases: [caseRecord('a'), caseRecord('b'), caseRecord('c')] },
        { event: 'case_started', case: caseRecord('a') },
        { event: 'case_completed', case: caseRecord('a'), examples: result().examples, errors: [], blocked_operations: [] },
        { event: 'case_started', case: caseRecord('b') }
    ].map(event => JSON.stringify({ run_id: 'run', ...event })).join('\n');
    const recovered = recoverBehaviorProgress(events + '\n{"torn":', 'target', 'stage timeout')!;
    assert.equal(recovered.complete, false);
    assert.equal(recovered.examples.length, 1);
    assert.equal(recovered.cases!.find(item => item.case_id === 'b')!.status, 'worker_error');
    assert.equal(recovered.cases!.find(item => item.case_id === 'c')!.status, 'not_started');
    assert.equal(recoverBehaviorProgress(events.replace('"run_id":"run"', '"run_id":"wrong"'), 'target', 'timeout'), undefined);
});

test('merging supplemental observations preserves diagnostics and demotes conflicting results', () => {
    const first = result();
    first.blocked_operations = ['blocked operation'];
    const second = result();
    second.examples[0] = { ...second.examples[0], result: '3' };
    second.cases!.push({ ...caseRecord('failed'), status: 'setup_error' });
    const merged = mergeBehaviorObservations(first, second);
    assert.equal(merged.examples.length, 2);
    assert.ok(merged.examples.every(item => item.call_assertable === false && item.oracle_reason === 'conflicting-observations'));
    assert.deepEqual(merged.blocked_operations, ['blocked operation']);
    assert.ok(merged.cases!.some(item => item.status === 'setup_error'));
    assert.equal(first.examples[0].call_assertable, undefined, 'the initial evidence remains immutable');
    assert.equal(new Set(merged.cases!.map(item => item.case_id)).size, merged.cases!.length);
    assert.equal(parseBehaviorObservations(merged, 'target').examples.length, 2);
});

test('keyword and constructor keyword order remain distinct Python calls', () => {
    for (const field of ['kwargs', 'constructor_kwargs'] as const) {
        const first = result(); const second = result();
        first.examples[0][field] = { a: '1', b: '2' };
        second.examples[0][field] = { b: '2', a: '1' };
        first.examples[0].result = "['a', 'b']"; second.examples[0].result = "['b', 'a']";
        const merged = mergeBehaviorObservations(first, second);
        assert.ok(merged.examples.every(item => item.call_assertable !== false));
    }
});

test('real isolated trace and codec snapshots satisfy the live parser without weakening diagnostics', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-parser-'));
    const python = resolvePythonExecutable('', path.resolve(__dirname, '../..'));
    const file = path.join(directory, 'neutral.py');
    const broken = path.join(directory, 'unavailable.py');
    const script = [
        'import json, sys',
        'sys.path.insert(0, sys.argv[1])',
        'from dynamic_tracer import trace_function',
        'from trace_value_codec import snapshot_call',
        'source = sys.argv[2]',
        "facts = trace_function(source, 'target', [{'args': [[1]], 'kwargs': {}}, {'args': [[1]], 'kwargs': {'raise_it': True}}])",
        "ordered = trace_function(source, 'ordered', [{'args': [], 'kwargs': {'a': 1, 'b': 2}}, {'args': [], 'kwargs': {'b': 2, 'a': 1}}])",
        "unsupported = trace_function(source, 'target', [{'args': [object()], 'kwargs': {}}])",
        "failed = trace_function(sys.argv[3], 'target', [{'args': [1], 'kwargs': {}}, {'args': [1], 'kwargs': {}}])",
        "typed = snapshot_call([None, True, 10**100, 1.5, '😀', b'abc', (1, 2), {3, 4}, frozenset({5}), {1: 'a'}], {}, [], {})",
        'cycle = []; cycle.append(cycle)',
        'shared = []',
        "diagnostics = [snapshot_call([value], {}, [], {}) for value in (cycle, [shared, shared], list(range(101)), 'x'*4097, float('nan'), object(), [list(range(100)) for _ in range(10)])]",
        "print(json.dumps({'facts': facts, 'ordered': ordered, 'unsupported': unsupported, 'failed': failed, 'typed': typed, 'diagnostics': diagnostics}))"
    ].join('\n');
    try {
        fs.writeFileSync(file, 'def target(values, *, raise_it=False):\n    values.append(2)\n    if raise_it:\n        raise ValueError("expected")\n    return len(values)\n\ndef ordered(**kwargs):\n    return list(kwargs)\n');
        fs.writeFileSync(broken, 'raise ValueError("planning unavailable")\ndef target(value):\n    return value\n');
        const run = spawnSync(python, ['-B', '-c', script, path.dirname(pythonToolPath('trace')), file, broken],
            { cwd: directory, encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        const live = JSON.parse(run.stdout);
        const facts = parseBehaviorObservations(live.facts, 'target');
        assert.equal(facts.examples.length, 1); assert.equal(facts.errors.length, 1);
        assert.ok(facts.cases!.every(item => item.inputs_mutated));
        const ordered = parseBehaviorObservations(live.ordered, 'ordered');
        assert.equal(ordered.examples.length, 2);
        assert.ok(ordered.examples.every(item => item.call_assertable !== false));
        const combined = parseBehaviorObservations(mergeBehaviorObservations(ordered, ordered), 'ordered');
        assert.ok(combined.examples.every(item => item.call_assertable !== false));
        assert.equal(combined.cases!.length, 4);
        const unsupported = parseBehaviorObservations(live.unsupported, 'target');
        assert.ok(unsupported.cases!.some(item => item.status === 'not_started' && item.reason === 'unsupported-input-snapshot'));
        const failed = parseBehaviorObservations(live.failed, 'target');
        assert.equal(failed.cases!.length, 2);
        assert.ok(failed.cases!.every(item => item.status === 'not_started'));
        assert.equal(new Set(failed.cases!.map(item => item.case_id)).size, 2);
        assert.equal(failed.load_diagnostic!.stage, 'module-import');
        assert.equal(failed.load_diagnostic!.exception_type, 'ValueError');
        const failedEvents = [
            { event: 'run_started', schema_version: failed.schema_version, func_name: 'target' },
            { event: 'planning_completed', args: failed.args, planning: failed.planning,
                load_error: failed.load_error, load_diagnostic: failed.load_diagnostic, planned_cases: [] }
        ].map(event => JSON.stringify({ run_id: failed.run_id, ...event })).join('\n');
        const recoveredImport = recoverBehaviorProgress(failedEvents, 'target', 'interrupted')!;
        assert.deepEqual(recoveredImport.load_diagnostic, failed.load_diagnostic);
        assert.equal(recoveredImport.load_error, failed.load_error);
        assert.equal(recoveredImport.complete, false);
        assert.equal(recoveredImport.examples.length + recoveredImport.errors.length, 0);
        const malformedEvents = failedEvents.replace(JSON.stringify(failed.load_diagnostic), '{}');
        assert.equal(recoverBehaviorProgress(malformedEvents, 'target', 'interrupted'), undefined);
        for (const [index, input] of [live.typed, ...live.diagnostics].entries()) {
            const value = result(); value.cases![0].input_before = input;
            const parsed = parseBehaviorObservations(value, 'target');
            assert.equal(parsed.examples[0].call_assertable === false, index > 0);
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
