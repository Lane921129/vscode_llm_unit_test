import * as assert from 'assert';
import { test } from 'node:test';
import { buildStubSmokeAssertion } from '../tier/stubSmokeAssertion';

test('builds exact smoke assertions for pass and safe literal returns', () => {
    assert.strictEqual(buildStubSmokeAssertion('def pending(): pass'), 'self.assertIsNone(result)');
    assert.strictEqual(buildStubSmokeAssertion('def answer():\n    return 42'), 'self.assertEqual(result, 42)');
    assert.strictEqual(buildStubSmokeAssertion("def label():\n    return 'ready'"), "self.assertEqual(result, 'ready')");
});

test('does not turn an expression into a fabricated smoke assertion', () => {
    assert.strictEqual(buildStubSmokeAssertion('def compute(value):\n    return value + 1'), null);
});
