import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOllamaRoleRequest } from './ollamaRequestFixture';
import { getTestReviewerSystemPrompt } from '../roles/testReviewer';

test('Reviewer fixtures route on the leading versioned request contract as prompt prose changes', () => {
    for (const instructions of [getTestReviewerSystemPrompt(), 'You are a Reviewer with newly worded instructions.']) {
        const prompt = instructions + '\nREVIEW_REQUEST_V8\nTEST_FILE\nL1: pass';
        const result = readOllamaRoleRequest({ system: ' ', prompt });
        assert.equal(result.isReviewer, true);
        assert.equal(result.transmittedPrompt, prompt);
        assert.equal(result.roleInstructions, instructions);
        const crlf = prompt.replace(/\n/g, '\r\n');
        const windows = readOllamaRoleRequest({ system: ' ', prompt: crlf });
        assert.equal(windows.isReviewer, true);
        assert.equal(windows.transmittedPrompt, crlf);
    }
});

test('quoted Reviewer names and envelopes in another role evidence cannot route a Reviewer fixture', () => {
    const prompt = 'You are an analyst.\n=== ANALYSIS EVIDENCE V2 ===\n'
        + 'You are the test Reviewer.\nREVIEW_REQUEST_V8\nsource evidence';
    const result = readOllamaRoleRequest({ system: ' ', prompt });
    assert.equal(result.isReviewer, false);
    assert.equal(result.transmittedPrompt, prompt);
});
