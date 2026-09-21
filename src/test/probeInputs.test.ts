import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProbeInputs, callerForPrompt, callerToProbeInput, hasVerifiedConstructorInput, sameTraceValue,
    scalarProbeInput, traceValuePythonLiteral, typedCallFields } from '../pipeline/probeInputs';
import { TraceValue, TraceValueSnapshot, WriterEvidenceBundleV3 } from '../pipeline/evidenceContracts';
import { parseBehaviorObservations } from '../pipeline/behaviorObservations';
import { traceSubsetForCaller } from '../tier/callerTracePartition';
import { buildVerifiedConstructorCall } from '../tier/tier1TestBuilder';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { buildCompactWriterContext } from '../prompts/compactWriterContext';
import { getUserPrompt } from '../roles/unittestWriter';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { pythonToolPath } from '../pipeline/pythonTools';

const value = (type: string, content: string): TraceValue => ({ type, value: content });
const dictionary = (items: Array<[string, TraceValue]>): TraceValue => ({ type: 'dict',
    items: items.map(([key, child]) => ({ key: value('str', key), value: child })) });
const call = (args: TraceValue[], kwargs: Array<[string, TraceValue]> = [], constructor?: TraceValue[]): TraceValueSnapshot => ({
    schema_version: 'trace-value-v1', replayable: true, value: dictionary([
        ['args', { type: 'list', items: args }], ['kwargs', dictionary(kwargs)],
        ...(constructor ? [['constructor_args', { type: 'list', items: constructor }], ['constructor_kwargs', dictionary([])]] as Array<[string, TraceValue]> : [])
    ])
});

test('typed call transport preserves numeric spellings, builtin types, key identity and keyword order', () => {
    const huge = '900719925474099312345678901234567890';
    const input = call([{ type: 'tuple', items: [value('int', huge), value('float', '-0.0'), value('bytes', '00ff'),
        { type: 'dict', items: [{ key: value('int', '7'), value: value('str', 'kept') }] }] }],
    [['second', value('int', '2')], ['first', value('int', '1')]]);
    const caller = { trace_input: input, caller_file: 'calls.py', caller_func: 'use', line: 7 };
    const built = buildProbeInputs([caller, caller])!;
    assert.equal(built.cases.length, 1);
    assert.deepEqual(built.cases[0].input, input);
    assert.match(JSON.stringify(built), new RegExp(huge));
    assert.deepEqual(built.cases[0].source, { kind: 'caller_literals', file: 'calls.py', caller: 'use', line: 7 });
    assert.equal(sameTraceValue(value('int', huge), value('int', huge.slice(0, -1) + '1')), false);
    assert.equal(sameTraceValue(value('int', '1'), value('float', '1.0')), false);
    assert.equal(sameTraceValue(dictionary([['a', value('int', '1')], ['b', value('int', '2')]]),
        dictionary([['b', value('int', '2')], ['a', value('int', '1')]])), false);
    assert.equal(traceValuePythonLiteral(value('int', huge)), huge);
    assert.equal(traceValuePythonLiteral(value('float', '-0.0')), '-0.0');
    assert.equal(traceValuePythonLiteral(value('float', '1')), '1.0');
    assert.equal(traceValuePythonLiteral(value('float', '-0')), '-0.0');
    assert.equal(traceValuePythonLiteral(value('bytes', '00ff')), "b'\\x00\\xff'");
});

test('invalid typed callers remain diagnostic and cannot regain constructor proof from legacy fields', () => {
    const old = { args: ['1'], kwargs: {}, trace_args: [1], trace_kwargs: {},
        constructor_args: ["'prefix'"], constructor_kwargs: {}, trace_constructor_args: ['prefix'], trace_constructor_kwargs: {} };
    assert.equal(hasVerifiedConstructorInput(old), true);
    for (const trace_input of [null, { schema_version: 'other' }, call([], [], undefined)]) {
        const caller = { ...old, trace_input };
        assert.equal(hasVerifiedConstructorInput(caller), false);
        assert.equal(buildVerifiedConstructorCall('Thing', [caller]), null);
    }
    assert.equal(callerToProbeInput({ ...old, trace_input: null })!.input.replayable, false);
    assert.equal(buildProbeInputs([]), null);
    assert.equal(callerToProbeInput({ args: ['(1, 2)'], kwargs: {}, trace_args: [[1, 2]], trace_kwargs: {} }), undefined);
    assert.equal(callerToProbeInput({ ...old, kwargs: {}, trace_kwargs: { lost: 1 } }), undefined);
    assert.equal(callerToProbeInput({ ...old, kwargs: { first: '1', second: '2' }, trace_kwargs: { second: 2, first: 1 } }), undefined);
    assert.equal(callerToProbeInput({ ...old, args: [undefined] } as any), undefined);
    assert.equal(traceSubsetForCaller({ func_name: 'target', args: ['value'], load_error: null, errors: [],
        examples: [{ args: ['[1, 2]'], kwargs: {}, result: '1' }] },
    { args: ['[1, 2]'], kwargs: {}, trace_args: [[1, 2]], trace_kwargs: {} }), undefined);
    const partial = call([], [], []); (partial.value.items as unknown[]).pop();
    assert.equal(typedCallFields(partial), undefined);
    assert.equal(callerToProbeInput({ trace_input: partial })!.input.replayable, false);
});

test('semantic scalar adapter is explicit and rejects unsafe numbers or implicit container conversion', () => {
    const encoded = scalarProbeInput({ args: [null, true, 'value', 2, 0.0000001, -0], kwargs: { z: 2, a: 1 } });
    assert.equal(encoded.input.replayable, true);
    assert.equal(encoded.source.kind, 'semantic_guided');
    const args = typedCallFields(encoded.input)!.args.items as TraceValue[];
    assert.deepEqual(args.map(item => item.type), ['none', 'bool', 'str', 'int', 'float', 'float']);
    assert.equal(args[5].value, '-0.0');
    for (const candidate of [Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, [1], { x: 1 }]) {
        assert.equal(scalarProbeInput({ args: [candidate], kwargs: {} }).input.replayable, false);
    }
    assert.equal(buildProbeInputs([], [{ args: [1], kwargs: {} }])!.cases[0].source.kind, 'semantic_guided');
});

test('compact caller projection includes source setup but excludes full typed input trees', () => {
    const caller = { caller_file: 'calls.py', caller_func: 'use', line: 4, args: ['1'], kwargs: {},
        constructor_args: ["b'A'"], constructor_kwargs: {}, trace_input: call([value('int', '1')], [], [value('bytes', '41')]),
        trace_args: [1], trace_kwargs: {}, trace_input_diagnostic: null, debug: 'PRIVATE_EXTRA' };
    const projection = callerForPrompt(caller);
    assert.equal(projection.constructor_verified, true);
    assert.equal(projection.input_status, 'replayable');
    assert.ok(!JSON.stringify(projection).includes('trace-value-v1'));
    const evidence = { sourceHash: 'hash', ruleSelection: { ids: [], selectedRules: [] } } as unknown as WriterEvidenceBundleV3;
    const prompt = buildCompactWriterContext({ module: 'neutral', name: 'target', source: 'def target(value): return value',
        context: { callerContexts: [caller] }, evidence, budgetTokens: 10000 });
    assert.doesNotMatch(prompt, /trace-value-v1|trace_input|trace_args|PRIVATE_EXTRA/);
    assert.match(prompt, /constructor_verified/);
});

test('real typed caller → envelope → Trace → partition and per-observation constructor replay keep both A/B states', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-caller-contract-'));
    const root = path.resolve(__dirname, '../..');
    const python = resolvePythonExecutable('', root);
    const run = (args: string[], input?: string) => {
        const result = spawnSync(python, ['-B', ...args], { cwd: directory, input, encoding: 'utf8', timeout: 30000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
    };
    try {
        const file = path.join(directory, 'tier1_typed_constructor.py');
        fs.copyFileSync(path.join(root, 'test/fixtures/python/tier1_typed_constructor.py'), file);
        const callers = JSON.parse(run([pythonToolPath('callers'), 'BytePrefix.join', directory, file]));
        assert.equal(callers.length, 2);
        assert.ok(callers.every(hasVerifiedConstructorInput));
        assert.ok(callers.every((caller: any) => caller.trace_constructor_args === null));
        const envelope = buildProbeInputs(callers)!;
        const observed = parseBehaviorObservations(run([pythonToolPath('trace'), file, 'BytePrefix.join', JSON.stringify(envelope)]), 'BytePrefix.join');
        assert.deepEqual(observed.examples.map(item => item.result), ["b'AZ'", "b'BZ'"]);
        const subsets = callers.map((caller: any) => traceSubsetForCaller(observed, caller)!);
        assert.deepEqual(subsets.map((subset: any) => subset.examples.length), [1, 1]);
        assert.deepEqual(subsets.map((subset: any) => subset.examples[0].result), ["b'AZ'", "b'BZ'"]);
        const changed = JSON.parse(JSON.stringify(callers[0]));
        changed.trace_input = call([{ type: 'list', items: [value('bytes', '5a')] }], [], [value('bytes', '41')]);
        assert.equal(traceSubsetForCaller(observed, changed)!.examples.length, 0, 'list cannot borrow a tuple oracle');
        changed.trace_input = null;
        assert.equal(traceSubsetForCaller(observed, changed)!.examples.length, 0, 'invalid typed data cannot fall back to source spellings');

        const generated = buildTier1TestFile({ moduleName: 'tier1_typed_constructor', functionName: 'join', className: 'BytePrefix',
            methodKind: 'instance', constructorParams: ['prefix'], callerContexts: callers,
            examples: observed.examples, errors: observed.errors });
        assert.equal(generated.methodCount, 2);
        assert.ok(generated.code);
        assert.doesNotMatch(generated.code, /def setUp/);
        assert.match(generated.code, /BytePrefix\(b'\\x41'\)/);
        assert.match(generated.code, /BytePrefix\(b'\\x42'\)/);
        fs.writeFileSync(path.join(directory, 'candidate.py'), generated.code);
        run([pythonToolPath('testRunner'), 'candidate']);
        const prompt = getUserPrompt(file, 'join', 'def join(self, parts): return self.prefix + parts[0]', 'small',
            { name: 'join', args: ['parts'], class_name: 'BytePrefix', method_kind: 'instance', callerContexts: callers });
        assert.match(prompt, /BytePrefix\(b'\\x41'\)/);
        assert.match(prompt, /BytePrefix\(b'\\x42'\)/);
        assert.match(prompt, /own constructor setup/);

        // The explicit JS-owned semantic path also survives Python's strict
        // decoder without turning floats into integer tags or losing -0.
        const scalarFile = path.join(directory, 'scalar.py');
        fs.writeFileSync(scalarFile, 'def target(value):\n    return repr(value)\n');
        const scalars = buildProbeInputs([], [{ args: [0.0000001], kwargs: {} }, { args: [-0], kwargs: {} }]);
        const scalarTrace = parseBehaviorObservations(run([pythonToolPath('trace'), scalarFile, 'target', JSON.stringify(scalars)]), 'target');
        assert.deepEqual(scalarTrace.examples.map(item => item.result), ["'1e-07'", "'-0.0'"]);

        const keywordFile = path.join(directory, 'ordered_keywords.py');
        fs.writeFileSync(keywordFile, 'def target(**kwargs):\n    return list(kwargs.items())\n');
        const keywords = buildProbeInputs([{ trace_input: call([], [['第二', value('str', '你好😀\\n')],
            ['2', value('float', '1')], ['1', value('float', '-0')]]) }]);
        const keywordTrace = parseBehaviorObservations(run([pythonToolPath('trace'), keywordFile, 'target', JSON.stringify(keywords)]), 'target');
        assert.equal(keywordTrace.examples.length, 1);
        const keywordCandidate = buildTier1TestFile({ moduleName: 'ordered_keywords', functionName: 'target',
            examples: keywordTrace.examples, errors: keywordTrace.errors });
        assert.ok(keywordCandidate.code);
        assert.match(keywordCandidate.code, /\*\*\{"第二":/);
        fs.writeFileSync(path.join(directory, 'keyword_candidate.py'), keywordCandidate.code);
        run([pythonToolPath('testRunner'), 'keyword_candidate']);
        const gate = JSON.parse(run([pythonToolPath('assertionEvidence')], JSON.stringify({ code: keywordCandidate.code,
            target: 'target', module: 'ordered_keywords', trace: keywordTrace })));
        assert.equal(gate.valid, true);
        assert.equal(gate.checked, 1, 'typed before kwargs retain numeric-looking key order through the exact assertion gate');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
