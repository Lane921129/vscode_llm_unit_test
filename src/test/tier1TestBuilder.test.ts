import * as assert from 'assert';
import { test } from 'node:test';
import { buildTier1PropertyTestMethods, buildTier1TestMethods } from '../tier1TestBuilder';

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

test('builds property getter assertions without calling the descriptor as a function', () => {
    const methods = buildTier1PropertyTestMethods('enabled', [
        { args: [], result: 'True', result_type: 'bool' }
    ], []);
    assert.ok(methods[0].includes('result = self._instance.enabled'));
    assert.ok(!methods[0].includes('enabled('));
});
