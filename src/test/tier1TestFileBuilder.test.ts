import * as assert from 'assert';
import { test } from 'node:test';
import { buildTier1TestFile } from '../tier/tier1TestFileBuilder';

test('Tier 1 file builder creates a portable module unittest from verified trace facts', () => {
    const result = buildTier1TestFile({
        moduleName: 'sample',
        functionName: 'double',
        examples: [{ args: ['2'], result: '4', result_type: 'int' }],
        errors: [],
    });

    assert.strictEqual(result.methodCount, 1);
    assert.match(result.code || '', /from sample import \*/);
    assert.match(result.code || '', /result = double\(2\)/);
    assert.match(result.code || '', /self\.assertEqual\(result, 4\)/);
});

test('Tier 1 file builder uses verified constructor literals and preserves method arguments', () => {
    const result = buildTier1TestFile({
        moduleName: 'worker',
        functionName: 'render',
        examples: [{ args: ["'value'"], result: "'prefix:value'", result_type: 'str' }],
        errors: [],
        className: 'Service',
        methodKind: 'instance',
        constructorParams: ['prefix'],
        callerContexts: [{
            trace_constructor_args: ['prefix:'],
            trace_constructor_kwargs: {},
            constructor_args: ["'prefix:'"],
            constructor_kwargs: {},
        }],
    });

    assert.match(result.code || '', /self\._instance = Service\('prefix:'\)/);
    assert.match(result.code || '', /self\._instance\.render\('value'\)/);
    assert.ok(!result.missingConstructorFacts);
});

test('Tier 1 file builder refuses an instance requiring unverified constructor facts', () => {
    const result = buildTier1TestFile({
        moduleName: 'worker',
        functionName: 'render',
        examples: [{ args: ["'value'"], result: "'x'", result_type: 'str' }],
        errors: [],
        className: 'Service',
        methodKind: 'instance',
        constructorParams: ['prefix'],
    });

    assert.deepStrictEqual(result.missingConstructorFacts, ['prefix']);
    assert.strictEqual(result.code, undefined);
});

test('Tier 1 file builder reads a property without adding call parentheses', () => {
    const result = buildTier1TestFile({
        moduleName: 'temperature',
        functionName: 'value',
        examples: [{ args: [], result: '0', result_type: 'int' }],
        errors: [],
        className: 'Temperature',
        methodKind: 'property',
    });

    assert.match(result.code || '', /self\._instance = Temperature\(\)/);
    assert.match(result.code || '', /result = self\._instance\.value/);
    assert.doesNotMatch(result.code || '', /self\._instance\.value\(\)/);
});
