import * as assert from 'assert';
import { test } from 'node:test';
import { exceptionNamesFromEvidence } from '../validation/exceptionEvidence';

test('combines explicit AST raises with assertable dynamic-trace exceptions', () => {
    assert.deepStrictEqual(exceptionNamesFromEvidence({
        raised_exceptions: ['domain.ValidationError', 'ValueError'],
        traceResult: {
            errors: [
                { exception: 'KeyError', call_assertable: true },
                { exception: 'RuntimeError', call_assertable: false },
                { exception: 'ValueError' }
            ]
        }
    }), ['KeyError', 'ValidationError', 'ValueError']);
});

test('does not turn arbitrary diagnostic text into an exception fact', () => {
    assert.deepStrictEqual(exceptionNamesFromEvidence({
        traceResult: { errors: [{ exception: 'blocked external write' }] }
    }), []);
});
