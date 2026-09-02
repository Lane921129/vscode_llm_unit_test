import * as assert from 'assert';
import { test } from 'node:test';
import { buildTier1InstanceSetup, buildTier1PropertyTestMethods, buildTier1TestMethods, buildVerifiedConstructorCall } from '../tier1TestBuilder';

test('builds exact value and exception assertions without asking an LLM', () => {
    const methods = buildTier1TestMethods('format_value', [
        { args: ["'abcdef'"], result: "'Value: ab'", result_type: 'str' }
    ], [
        { args: ["''"], exception: 'ValueError' }
    ]);

    assert.deepStrictEqual(methods, [
        '    def test_case_1(self):\n        result = format_value(\'abcdef\')\n        self.assertEqual(result, \'Value: ab\')',
        '    def test_case_2(self):\n        with self.assertRaises(ValueError):\n            format_value(\'\')'
    ]);
});

test('preserves traced keyword arguments in deterministic calls', () => {
    const methods = buildTier1TestMethods('multiply', [
        { args: ['3'], kwargs: { factor: '2' }, result: '6', result_type: 'int' }
    ], []);

    assert.ok(methods[0].includes('result = multiply(3, factor=2)'));
});

test('builds instance setup only from verified constructor literal facts', () => {
    const setup = buildTier1InstanceSetup('Service', [{
        trace_constructor_args: ['prefix:'],
        trace_constructor_kwargs: { enabled: true },
        constructor_args: ["'prefix:'"],
        constructor_kwargs: { enabled: 'True' }
    }]);

    assert.strictEqual(setup, "    def setUp(self):\n        self._instance = Service('prefix:', enabled=True)");
    assert.strictEqual(buildVerifiedConstructorCall('Service', [{
        trace_constructor_args: ['prefix:'],
        trace_constructor_kwargs: {},
        constructor_args: ["'prefix:'"],
        constructor_kwargs: {}
    }]), "Service('prefix:')");
    assert.strictEqual(buildTier1InstanceSetup('Service', [{
        trace_constructor_args: null,
        trace_constructor_kwargs: null,
        constructor_args: ["'unsafe'"],
        constructor_kwargs: {}
    }]), null);
});

test('builds property getter assertions without calling the descriptor as a function', () => {
    const methods = buildTier1PropertyTestMethods('enabled', [
        { args: [], result: 'True', result_type: 'bool' }
    ], []);
    assert.ok(methods[0].includes('result = self._instance.enabled'));
    assert.ok(!methods[0].includes('enabled('));
});

test('does not build deterministic assertions from process-specific object repr values', () => {
    const methods = buildTier1TestMethods('build', [{
        args: [], result: '<sample.Result object at 0x1234>', result_type: 'Result', result_assertable: false
    }], []);

    assert.deepStrictEqual(methods, []);
});

test('materializes finite generators before asserting their traced values', () => {
    const methods = buildTier1TestMethods('numbers', [
        { args: ['3'], result: '[0, 2, 4]', result_type: 'generator', result_truncated: false }
    ], []);
    assert.ok(methods[0].includes('result = list(numbers(3))'));
    assert.ok(methods[0].includes('self.assertEqual(result, [0, 2, 4])'));
});

test('collects async generators in a normal unittest method', () => {
    const methods = buildTier1TestMethods('numbers', [
        { args: ['3'], result: '[0, 2, 4]', result_type: 'async_generator', result_truncated: false }
    ], []);
    assert.ok(methods[0].includes('async def collect():'));
    assert.ok(methods[0].includes('async for item in numbers(3)'));
    assert.ok(methods[0].includes("__import__('asyncio').run(collect())"));
});

test('runs ordinary coroutine targets before asserting their traced result or exception', () => {
    const methods = buildTier1TestMethods('double', [
        { args: ['3'], result: '6', result_type: 'int' }
    ], [
        { args: ['0'], exception: 'ValueError' }
    ], true);

    assert.ok(methods[0].includes("result = __import__('asyncio').run(double(3))"));
    assert.ok(methods[1].includes("__import__('asyncio').run(double(0))"));
});
