import * as assert from 'assert';
import { test } from 'node:test';
import { shouldRetryTraceWithoutCallerInputs } from '../traceRecovery';

test('retries source-guided tracing when caller literals only cause arity TypeErrors', () => {
    assert.strictEqual(shouldRetryTraceWithoutCallerInputs({
        examples: [],
        errors: [{ exception: 'TypeError' }],
        load_error: null,
    }, 1), true);
});

test('does not discard a verified caller trace or a genuine target exception', () => {
    assert.strictEqual(shouldRetryTraceWithoutCallerInputs({
        examples: [{ args: ['1'] }], errors: [], load_error: null,
    }, 1), false);
    assert.strictEqual(shouldRetryTraceWithoutCallerInputs({
        examples: [], errors: [{ exception: 'ValueError' }], load_error: null,
    }, 1), false);
});
