import * as assert from 'assert';
import { test } from 'node:test';
import { addOutputContract, buildCustomChatCompletionBody } from '../customApi';

test('custom API requests JSON mode only when the caller needs a structured result', () => {
    const textRequest = buildCustomChatCompletionBody('model-a', 'system', 'user', 'text');
    const jsonRequest = buildCustomChatCompletionBody('model-a', 'system', 'user', 'test-code-json');

    assert.strictEqual(textRequest.response_format, undefined);
    assert.deepStrictEqual(jsonRequest.response_format, { type: 'json_object' });
});

test('structured output contracts are generic and describe the expected envelope', () => {
    const codeContract = addOutputContract('base', 'test-code-json');
    const jsonContract = addOutputContract('base', 'json');

    assert.ok(codeContract.includes('"code"'));
    assert.ok(codeContract.includes('Python unittest'));
    assert.ok(jsonContract.includes('valid JSON object'));
    assert.strictEqual(addOutputContract('base', 'text'), 'base');
});
