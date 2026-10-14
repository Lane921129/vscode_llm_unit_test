import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCompletedOllamaText } from '../llm/ollamaResponse';
import { getLanguage, setLanguage } from '../i18n/core';
import { AnalysisStageError } from '../utils/executionFailureCategory';

test('output-limit messages identify the exact num_predict cap in both languages without provider content', () => {
    const previous = getLanguage();
    try {
        for (const language of ['zh-tw', 'en'] as const) {
            setLanguage(language);
            assert.throws(() => getCompletedOllamaText({ done_reason: 'length', response: 'PRIVATE_PREFIX' }, 1024), error => {
                assert.ok(error instanceof AnalysisStageError);
                assert.match(error.message, /num_predict=1024 tokens/);
                assert.doesNotMatch(error.message, /PRIVATE_PREFIX/);
                if (language === 'en') { assert.doesNotMatch(error.message, /[\u3400-\u9fff]/); }
                assert.deepEqual(error.diagnostic, { reasonCode: 'output-token-limit', outputTokenLimit: 1024 });
                return true;
            });
        }
    } finally { setLanguage(previous); }
});

test('unknown or invalid output limits remain unknown instead of becoming a guessed context limit', () => {
    for (const cap of [undefined, 0, -1, 1.5, Infinity, NaN]) {
        assert.throws(() => getCompletedOllamaText({ done_reason: 'length', response: 'PRIVATE_PREFIX' }, cap), error => {
            assert.ok(error instanceof AnalysisStageError);
            assert.deepEqual(error.diagnostic, { reasonCode: 'output-token-limit' });
            assert.doesNotMatch(error.message, /num_predict=|PRIVATE_PREFIX/);
            return true;
        });
    }
});
