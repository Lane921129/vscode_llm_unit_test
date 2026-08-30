import * as assert from 'assert';
import { test } from 'node:test';
import { buildTier1TestMethods } from '../tier1TestBuilder';

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
