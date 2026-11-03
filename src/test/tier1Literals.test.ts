import * as assert from 'assert';
import { test } from 'node:test';
import { toPythonAssertionLiteral } from '../tier/tier1Literals';

test('preserves a traced Python string repr without adding nested quotes', () => {
    assert.strictEqual(toPythonAssertionLiteral("'Input rejected'", 'str'), "'Input rejected'");
});

test('preserves traced composite Python literals', () => {
    assert.strictEqual(toPythonAssertionLiteral("{'valid': True}", 'dict'), "{'valid': True}");
});

test('preserves traced Python set, frozenset, bytes, and bytearray literals', () => {
    assert.strictEqual(toPythonAssertionLiteral("set()", 'set'), "set()");
    assert.strictEqual(toPythonAssertionLiteral("{1, 2, 3}", 'set'), "{1, 2, 3}");
    assert.strictEqual(toPythonAssertionLiteral("b'hello'", 'bytes'), "b'hello'");
    assert.strictEqual(toPythonAssertionLiteral("frozenset({1, 2})", 'frozenset'), "frozenset({1, 2})");
    assert.strictEqual(toPythonAssertionLiteral("bytearray(b'abc')", 'bytearray'), "bytearray(b'abc')");
});
