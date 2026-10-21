import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCompletedOllamaText, readOutputShapeDiagnostic } from '../llm/ollamaResponse';
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
                const diagnostic = error.diagnostic as any;
                assert.equal(diagnostic.reasonCode, 'output-token-limit');
                assert.equal(diagnostic.outputTokenLimit, 1024);
                assert.ok(readOutputShapeDiagnostic(diagnostic.responseShape));
                assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_PREFIX/);
                return true;
            });
        }
    } finally { setLanguage(previous); }
});

test('unknown or invalid output limits remain unknown instead of becoming a guessed context limit', () => {
    for (const cap of [undefined, 0, -1, 1.5, Infinity, NaN]) {
        assert.throws(() => getCompletedOllamaText({ done_reason: 'length', response: 'PRIVATE_PREFIX' }, cap), error => {
            assert.ok(error instanceof AnalysisStageError);
            assert.equal((error.diagnostic as any).reasonCode, 'output-token-limit');
            assert.equal((error.diagnostic as any).outputTokenLimit, undefined);
            assert.doesNotMatch(error.message, /num_predict=|PRIVATE_PREFIX/);
            return true;
        });
    }
});

test('truncated output diagnostics distinguish repetition and code shape without accepting even a valid prefix', () => {
    const prefix = '```python\nimport unittest\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(target(7), 19)\n```\n';
    const repeated = prefix + '# PRIVATE_SECRET_MARKER\n'.repeat(3000);
    assert.throws(() => getCompletedOllamaText({ done_reason: 'length', response: repeated }, 1536), error => {
        const shape = readOutputShapeDiagnostic((error as AnalysisStageError).diagnostic && ((error as AnalysisStageError).diagnostic as any).responseShape)!;
        assert.equal(shape.testMethods, 1);
        assert.equal(shape.assertionCalls, 1);
        assert.ok(shape.repeatedLines > 100);
        assert.equal(shape.sampleComplete, false);
        assert.doesNotMatch(JSON.stringify(shape), /PRIVATE|assertEqual|target\(/);
        assert.equal(readOutputShapeDiagnostic({ ...shape, responseHash: 'private-url' }), undefined);
        assert.equal(readOutputShapeDiagnostic({ ...shape, sampledCharacters: -1 }), undefined);
        assert.doesNotMatch(JSON.stringify(readOutputShapeDiagnostic({ ...shape, raw: 'PRIVATE_SECRET_MARKER' })), /PRIVATE|raw/);
        return true;
    });
});
