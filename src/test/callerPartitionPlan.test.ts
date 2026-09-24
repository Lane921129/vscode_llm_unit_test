import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCallerPartitions } from '../tier/callerPartitionPlan';

const caller = (value: number, origin = 'caller') => ({ caller_func: origin,
    args: [String(value)], kwargs: {}, trace_args: [value], trace_kwargs: {} });

test('repeated exact call inputs do not multiply Writer requests', () => {
    const calls = Array.from({ length: 33 }, (_, index) => caller(1, `caller_${index}`));
    const plan = planCallerPartitions(calls);
    assert.equal(plan.mode, 'single-pass');
    assert.equal(plan.distinctInputs, 1);
    assert.equal(calls.length, 33, 'original source context is retained');
    const grouped = planCallerPartitions([...calls, caller(2)]);
    assert.equal(grouped.mode, 'partitioned');
    assert.equal(grouped.callers.length, 2);
});

test('unknown or excessive caller groups use the full single-pass context', () => {
    assert.equal(planCallerPartitions([caller(1), { args: ['unknown'], trace_args: null }]).reason, 'unresolved-inputs');
    assert.equal(planCallerPartitions(Array.from({ length: 5 }, (_, i) => caller(i))).reason, 'partition-limit');
    assert.equal(planCallerPartitions([]).mode, 'single-pass');
    assert.equal(planCallerPartitions([caller(1), { ...caller(2), trace_constructor_diagnostic: { reason: 'non-literal-constructor' } }]).reason, 'unresolved-inputs');
    assert.equal(planCallerPartitions([caller(1), { ...caller(2), constructor_args: ['variable'], constructor_kwargs: {} }]).reason, 'unresolved-inputs');
});

test('different constructor states and numeric types never share a partition', () => {
    const input = caller(1);
    const withConstructor = (prefix: string) => ({ ...input, constructor_args: [JSON.stringify(prefix)], constructor_kwargs: {},
        trace_constructor_args: [prefix], trace_constructor_kwargs: {} });
    assert.equal(planCallerPartitions([withConstructor('a'), withConstructor('b')]).distinctInputs, 2);
    assert.equal(planCallerPartitions([input, { ...input, args: ['1.0'] }]).distinctInputs, 2);
});
