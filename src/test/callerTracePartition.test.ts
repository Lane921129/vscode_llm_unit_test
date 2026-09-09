import * as assert from 'assert';
import { test } from 'node:test';
import { traceSubsetForCaller } from '../tier/callerTracePartition';

const trace = {
    func_name: 'render',
    args: ['value'],
    examples: [
        { args: ["'Alpha'"], kwargs: {}, result: "'A'" },
        { args: ["'Beta'"], kwargs: {}, result: "'B'" }
    ],
    errors: [
        { args: ["'broken'"], kwargs: {}, exception: 'ValueError' }
    ],
    load_error: null
};

test('partitions Tier 2 Trace facts to the exact literal caller', () => {
    const subset = traceSubsetForCaller(trace, {
        args: ["'Beta'"], kwargs: {}, trace_args: ['Beta'], trace_kwargs: {}
    });

    assert.ok(subset);
    assert.deepStrictEqual(subset!.examples.map(example => example.result), ["'B'"]);
    assert.deepStrictEqual(subset!.errors, []);
    assert.strictEqual(subset!.input_source, 'caller_partition');
});

test('does not use an imprecise caller or a near-matching repr as Trace evidence', () => {
    assert.strictEqual(traceSubsetForCaller(trace, {
        args: ['value'], kwargs: {}, trace_args: null, trace_kwargs: null
    }), undefined);

    const noMatch = traceSubsetForCaller(trace, {
        args: ['"Alpha"'], kwargs: {}, trace_args: ['Alpha'], trace_kwargs: {}
    });
    assert.ok(noMatch);
    assert.deepStrictEqual(noMatch!.examples, []);
});
