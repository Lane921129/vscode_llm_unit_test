import * as assert from 'assert';
import { test } from 'node:test';
import { addOutputContract, buildCustomChatCompletionBody, getCustomChatCompletionText, isStructuredResponseUsable, shouldRetryStructuredOutputAsText } from '../llm/customApi';

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

test('detects malformed successful structured responses before they reach a Tier', () => {
    assert.ok(!isStructuredResponseUsable('{', 'json'));
    assert.ok(!isStructuredResponseUsable('{}', 'json'));
    assert.ok(!isStructuredResponseUsable('{}', 'test-code-json'));
    assert.ok(isStructuredResponseUsable('{"required_skills": []}', 'json'));
    assert.ok(isStructuredResponseUsable('{"code":"import unittest"}', 'test-code-json'));
    assert.ok(isStructuredResponseUsable('import unittest', 'test-code-json'));
});

test('retries known structured-output rejections as plain text without hiding account failures', () => {
    for (const status of [400, 415, 422, 501]) {
        assert.ok(shouldRetryStructuredOutputAsText(status, 'json'));
        assert.ok(shouldRetryStructuredOutputAsText(status, 'test-code-json'));
    }
    assert.ok(!shouldRetryStructuredOutputAsText(422, 'text'));
    for (const status of [401, 403, 404, 408, 429, 500, 503]) {
        assert.ok(!shouldRetryStructuredOutputAsText(status, 'json'));
    }
});

test('extracts Custom assistant text without trusting malformed payloads', () => {
    assert.strictEqual(
        getCustomChatCompletionText({ choices: [{ message: { content: '{"ok":true}' } }] }),
        '{"ok":true}'
    );
    assert.strictEqual(getCustomChatCompletionText({ choices: [{ message: {} }] }), undefined);
    assert.strictEqual(getCustomChatCompletionText({ choices: [] }), undefined);
});
