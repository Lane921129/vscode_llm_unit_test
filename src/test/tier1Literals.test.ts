import * as assert from 'assert';
import { test } from 'node:test';
import { toPythonAssertionLiteral } from '../tier1Literals';

test('preserves a traced Python string repr without adding nested quotes', () => {
    assert.strictEqual(toPythonAssertionLiteral("'Input rejected'", 'str'), "'Input rejected'");
});

test('preserves traced composite Python literals', () => {
    assert.strictEqual(toPythonAssertionLiteral("{'valid': True}", 'dict'), "{'valid': True}");
});
