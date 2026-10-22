import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModelOutputPreview, readModelOutputPreview, diagnoseModelOutput, writerOutputFormatCorrection } from '../llm/modelOutputDiagnostics';
import { getCompletedOllamaText } from '../llm/ollamaResponse';
import { AnalysisStageError } from '../utils/executionFailureCategory';
import { renderModelOutputDiagnostics } from '../pipeline/modelOutputDiagnosticsPresentation';
import { getLanguage, setLanguage } from '../i18n/core';

function failure(response: string, privacy?: Parameters<typeof buildModelOutputPreview>[1]) {
    try { getCompletedOllamaText({ response, done: true, done_reason: 'length', privateProviderField: 'ENVELOPE_NOT_SAVED' }, 4096, privacy); }
    catch (error) { assert.ok(error instanceof AnalysisStageError); return error.diagnostic as any; }
    throw Error('Length-stopped response must fail');
}

test('recovery distinguishes complete repetitive output from code progress and incomplete samples', () => {
    const repetitive = failure('Repeating the same instructions\n'.repeat(40));
    assert.equal(diagnoseModelOutput(repetitive.responseShape), 'repetitive-without-tests');
    const code = failure('class Tests(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(real_target(1), 2)\n'
        + '# filler\n'.repeat(40));
    assert.equal(diagnoseModelOutput(code.responseShape), 'test-structure-present');
    assert.equal(diagnoseModelOutput({ ...repetitive.responseShape, sampleComplete: false }), 'unknown');
    assert.equal(diagnoseModelOutput({ ...repetitive.responseShape, repeatedLines: 100 }), 'unknown');
    assert.equal(diagnoseModelOutput(failure('short incomplete preamble').responseShape), 'no-test-structure');
    assert.equal(repetitive.responsePreview, undefined, 'low-level callers must opt into privacy-bound excerpts');
    assert.doesNotMatch(writerOutputFormatCorrection(true), /Repeating the same/);
});

test('excerpts preserve useful repetition while excluding complete replies, prompt echoes, locations and credentials', () => {
    const response = 'Repeated explanatory line\n'.repeat(100);
    const preview = buildModelOutputPreview(response, {});
    assert.equal(preview.executable, false); assert.equal(preview.complete, false);
    assert.equal(preview.samples[0].repetitions, 100);
    assert.equal(preview.samples[0].text, 'Repeated explanatory line');
    assert.ok(JSON.stringify(preview).length < response.length);
    const privateSource = 'def confidential_helper(private_value):';
    const hidden = buildModelOutputPreview((privateSource + '\nhttps://private.invalid/internal\nC:\\private\\secret.py\n').repeat(20),
        { excludedTexts: ['READ ONLY SOURCE\n' + privateSource] });
    assert.doesNotMatch(JSON.stringify(hidden), /confidential_helper|private\.invalid|secret\.py/);
    const credential = 'fixture-' + 'credential-987654321';
    const sensitive = buildModelOutputPreview(('before ' + credential + '\nafter\n').repeat(20), { knownSecrets: [credential] });
    assert.doesNotMatch(JSON.stringify(sensitive), /credential-987654321|before/);
    assert.match(JSON.stringify(sensitive), /withheld-sensitive-content/);
    const short = buildModelOutputPreview('small reply', {});
    assert.notEqual(short.samples[0].text, 'small reply');
    for (const text of ['a', 'ab', 'abc', 'a\nb\nc']) {
        assert.ok(buildModelOutputPreview(text, {}).samples.reduce((sum, item) => sum + item.text.length, 0) < text.length);
    }
    assert.equal(readModelOutputPreview({ ...preview, executable: true }), undefined);
    assert.equal(readModelOutputPreview({ ...preview, samples: [{ ...preview.samples[0], text: 'x'.repeat(242) }] }), undefined);
    assert.doesNotMatch(JSON.stringify(readModelOutputPreview({ ...preview, raw: 'ENVELOPE_NOT_SAVED' })), /ENVELOPE_NOT_SAVED/);
});

test('formal length errors include a bounded diagnostic excerpt without provider envelopes or executable content', () => {
    const diagnostic = failure('Repeated diagnostic phrase\n'.repeat(40), {});
    assert.equal(diagnostic.reasonCode, 'output-token-limit');
    assert.equal(diagnostic.outputDiagnosis, 'repetitive-without-tests');
    assert.ok(readModelOutputPreview(diagnostic.responsePreview));
    assert.doesNotMatch(JSON.stringify(diagnostic), /ENVELOPE_NOT_SAVED|privateProviderField/);
});

test('failure diagnostics show each attempt, exact timing, recovery and excerpts in both languages', () => {
    const diagnostic = failure('Repeated diagnostic phrase\n'.repeat(40), {});
    const events = [
        { sequence: 1, stage: 'model-request', status: 'requested', detail: { role: 'writer' } },
        { sequence: 2, stage: 'model-request', status: 'timing', detail: { role: 'writer', kind: 'transport',
            elapsedMs: 106066, httpStatus: 200, ollama: { promptEvalCount: 3014, evalCount: 4096, loadDurationMs: 14, evalDurationMs: 99211 } } },
        { sequence: 3, stage: 'model-request', status: 'error', detail: { role: 'writer', contextWindow: 8192, ...diagnostic } },
        { sequence: 4, stage: 'model-request', status: 'output-format-retry', detail: { role: 'writer' } },
        { sequence: 5, stage: 'model-request', status: 'requested', detail: { role: 'writer' } },
        { sequence: 6, stage: 'model-request', status: 'error', detail: { role: 'writer', contextWindow: 8192, ...diagnostic, responsePreview: undefined } }
    ];
    const language = getLanguage();
    try {
        for (const selected of ['en', 'zh-tw']) {
            setLanguage(selected);
            const report = renderModelOutputDiagnostics(events);
            assert.match(report, /3014/); assert.match(report, /4096/); assert.match(report, /106\.066/);
            assert.match(report, /Repeated diagnostic phrase/);
            assert.match(report, /output-token-limit/);
            if (selected === 'en') {
                assert.doesNotMatch(report, /[\u3400-\u9fff]/);
                assert.match(report, /One format correction/);
                assert.match(report, /cannot reconstruct/);
                assert.equal((report.match(/\| HTTP \| 200/g) || []).length, 1, 'second attempt must not borrow prior transport');
            }
        }
    } finally { setLanguage(language); }
});
