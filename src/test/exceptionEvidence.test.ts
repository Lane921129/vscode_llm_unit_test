import * as assert from 'assert';
import { test } from 'node:test';
import { exceptionNamesFromEvidence } from '../validation/exceptionEvidence';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

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

test('captures custom business exceptions from trace errors', () => {
    assert.deepStrictEqual(exceptionNamesFromEvidence({
        traceResult: { errors: [{ exception: 'auth.InvalidToken', call_assertable: true }] }
    }), ['InvalidToken']);
});

test('runner baseline and validation share exact traced exception names without suffix assumptions', () => {
    const errors = [{ args: ["''"], exception: 'UnsupportedProtocol', exception_module: 'transport',
        exception_qualname: 'UnsupportedProtocol', call_assertable: true }];
    const names = exceptionNamesFromEvidence({ traceResult: { errors } });
    assert.deepStrictEqual(names, ['UnsupportedProtocol']);
    const baseline = buildTier1TestFile({ moduleName: 'sample', functionName: 'target', examples: [], errors });
    assert.ok(baseline.code);
    assert.deepStrictEqual(validateUnittestStructure(baseline.code!, 'target', 'sample', 'call', names), { valid: true });
    assert.equal(validateUnittestStructure(baseline.code!, 'target', 'sample', 'call', []).valid, false);
});

test('rejects blocked traces and diagnostic text while retaining exact qualified and Unicode names', () => {
    assert.deepStrictEqual(exceptionNamesFromEvidence({
        raised_exceptions: ['Raised StopIteration here', 'package.EndOfStream', 'not a class'],
        traceResult: { errors: [
            { exception: 'StopIteration' },
            { exception: 'Unsafe', exception_qualname: 'Safety.Blocked', call_assertable: false },
            { exception: 'message mentioning ValueError: failed' },
            { exception: 'ignored', exception_qualname: 'package.完成' },
            { exception_qualname: 'package.Owner.Closed' }
        ] }
    }), ['Closed', 'EndOfStream', 'StopIteration', '完成']);
});
