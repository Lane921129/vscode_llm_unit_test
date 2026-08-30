import * as assert from 'assert';
import { test } from 'node:test';
import { buildTier1TestMethods } from '../tier1TestBuilder';

test('builds exact value and exception assertions without asking an LLM', () => {
    const methods = buildTier1TestMethods('login_user', [
        { args: ["'1234567890'"], result: "'Welcome User (ID: 12345)'", result_type: 'str' }
    ], [
        { args: ["''"], exception: 'ValueError' }
    ]);

    assert.deepStrictEqual(methods, [
        '    def test_case_1(self):\n        result = login_user(\'1234567890\')\n        self.assertEqual(result, \'Welcome User (ID: 12345)\')',
        '    def test_case_2(self):\n        with self.assertRaises(ValueError):\n            login_user(\'\')'
    ]);
});
