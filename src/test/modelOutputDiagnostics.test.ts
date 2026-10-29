import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModelOutputPreview, readModelOutputPreview, diagnoseModelOutput, writerOutputFormatCorrection } from '../llm/modelOutputDiagnostics';
import { getCompletedOllamaText, outputShape } from '../llm/ollamaResponse';
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

test('repeated fenced test shells do not masquerade as progress, while real assertions and a single fixture retain growth', () => {
    const wrapper = '```python\nimport unittest\nclass Tests(unittest.TestCase):\n    def test_seed(self):\n        # model has not written its test body\n```\n';
    const diagnostic = failure(wrapper.repeat(12));
    assert.equal(diagnoseModelOutput(diagnostic.responseShape), 'repetitive-test-shells');
    for (const observed of [
        { nonemptyLines: 103, repeatedLines: 87, testMethods: 7, assertionCalls: 0, pythonFences: 14 },
        { nonemptyLines: 157, repeatedLines: 141, testMethods: 10, assertionCalls: 0, pythonFences: 21 }
    ]) {
        assert.equal(diagnoseModelOutput({ version: 'output-shape-v1', sampleComplete: true, ...observed }), 'repetitive-test-shells');
    }
    const shape = diagnostic.responseShape;
    assert.equal(diagnoseModelOutput({ ...shape, assertionCalls: 1 }), 'test-structure-present');
    assert.equal(diagnoseModelOutput({ ...shape, testMethods: 1 }), 'test-structure-present');
    assert.equal(diagnoseModelOutput({ ...shape, pythonFences: 2 }), 'test-structure-present');
    assert.equal(diagnoseModelOutput({ ...shape, pythonFences: undefined }), 'test-structure-present');
    assert.equal(diagnoseModelOutput({ ...shape, repeatedLines: 0 }), 'test-structure-present');
    assert.equal(diagnoseModelOutput({ ...shape, sampleComplete: false }), 'unknown');
    const previous = getLanguage();
    try {
        for (const language of ['en', 'zh-tw']) {
            setLanguage(language);
            const report = renderModelOutputDiagnostics([{ sequence: 1, stage: 'model-request', status: 'error',
                detail: { role: 'writer', ...diagnostic } }]);
            assert.match(report, language === 'en' ? /Wrapper counts do not establish/ : /不能將外框數量/);
            if (language === 'en') { assert.doesNotMatch(report, /[\u3400-\u9fff]/); }
        }
    } finally { setLanguage(previous); }
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

test('a host-owned seed scope treats multiple method signatures as scope overrun even when assertions are present', () => {
    const shape = { version: 'output-shape-v1', sampleComplete: true, nonemptyLines: 151, repeatedLines: 135,
        pythonFences: 2, testMethods: 11, assertionCalls: 24 };
    assert.equal(diagnoseModelOutput(shape), 'test-structure-present', 'ordinary full-suite output keeps the existing route');
    assert.equal(diagnoseModelOutput(shape, { singleTestSeed: true }), 'seed-scope-overrun');
    assert.equal(diagnoseModelOutput({ ...shape, testMethods: 1 }, { singleTestSeed: true }), 'test-structure-present');
    assert.equal(diagnoseModelOutput({ ...shape, sampleComplete: false }, { singleTestSeed: true }), 'unknown');
    assert.match(writerOutputFormatCorrection(true, 'seed-scope-overrun'), /multiple test methods outside/);
    const previous = getLanguage();
    try {
        setLanguage('en');
        const diagnostic = failure('```python\nclass Cases(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(1, 1)\n'
            + '    def test_two(self):\n        self.assertEqual(2, 2)\n```');
        const report = renderModelOutputDiagnostics([{ sequence: 1, stage: 'model-request', status: 'error',
            detail: { role: 'writer', ...diagnostic, outputScope: 'single-test-seed' } }]);
        assert.match(report, /outside the single-test seed scope/);
        assert.doesNotMatch(report, /[\u3400-\u9fff]/);
    } finally { setLanguage(previous); }
});

test('formal length errors include a bounded diagnostic excerpt without provider envelopes or executable content', () => {
    const diagnostic = failure('Repeated diagnostic phrase\n'.repeat(40), {});
    assert.equal(diagnostic.reasonCode, 'output-token-limit');
    assert.equal(diagnostic.outputDiagnosis, 'repetitive-without-tests');
    assert.ok(readModelOutputPreview(diagnostic.responsePreview));
    assert.doesNotMatch(JSON.stringify(diagnostic), /ENVELOPE_NOT_SAVED|privateProviderField/);
});

test('a completed malformed reply shows safe syntax diagnostics without pretending it was length-stopped', () => {
    const raw = 'Explanation rather than Python\n'.repeat(20);
    const detail = { role: 'writer', reasonCode: 'response-python-syntax', outputTokenLimit: 2458, previewScope: 'extracted-python',
        syntax: { kind: 'SyntaxError', line: 1, column: 4 }, responseShape: outputShape(raw),
        responsePreview: buildModelOutputPreview(raw, {}) };
    const language = getLanguage();
    try {
        for (const selected of ['en', 'zh-tw']) {
            setLanguage(selected);
            const report = renderModelOutputDiagnostics([
                { sequence: 1, stage: 'model-request', status: 'timing', detail: { role: 'writer', kind: 'transport',
                    elapsedMs: 185612, httpStatus: 200, ollama: { evalCount: 733, promptEvalCount: 3176 } } },
                { sequence: 2, stage: 'model-request', status: 'format-rejected', detail },
                { sequence: 3, stage: 'model-request', status: 'output-format-retry', detail: { role: 'writer' } }
            ]);
            assert.match(report, /completed \/ response-python-syntax/);
            assert.match(report, /SyntaxError \/ 1 \/ 4/); assert.match(report, /2458 \/ 733/);
            assert.match(report, /Explanation rather than Python/);
            assert.doesNotMatch(report, /length \/ output-token-limit/);
            if (selected === 'en') { assert.doesNotMatch(report, /[\u3400-\u9fff]/); }
        }
    } finally { setLanguage(language); }
});

test('static instruction echoes stay readable while mixed source and credentials remain hidden', () => {
    const instruction = writerOutputFormatCorrection(true);
    const publicLine = instruction.trim().split('\n').pop()!;
    const privateLine = 'def internal_customer_lookup(private_record):';
    const response = (publicLine + '\n' + privateLine + '\n' + publicLine + ' ' + privateLine + '\n').repeat(20);
    const preview = buildModelOutputPreview(response, {
        excludedTexts: [instruction, privateLine], publicInstructionTexts: [instruction]
    });
    assert.match(preview.samples[0].text, /previous response reached its output cap/);
    assert.equal(preview.samples[1].text, '[withheld-prompt-content]');
    assert.equal(preview.samples[2].text, '[withheld-prompt-content]');
    assert.doesNotMatch(JSON.stringify(preview), /internal_customer_lookup|private_record/);
    const secret = 'known-' + 'secret-fixture-0123456789';
    const hidden = buildModelOutputPreview((publicLine + secret + '\n').repeat(20), {
        knownSecrets: [secret], publicInstructionTexts: [instruction]
    });
    assert.doesNotMatch(JSON.stringify(hidden), /previous response|secret-fixture/);
});

test('short symbol overlaps redact private words locally without hiding the entire diagnostic', () => {
    for (const symbol of ['refresh_state()', '套件.更新狀態()']) {
        const source = `${symbol}\ndef private_helper(db):\n    return PRIVATE_SLOT + 17\n`;
        const response = `The response discusses ${symbol} but contains prose instead of a replacement method. `
            + 'It mentions private_helper and PRIVATE_SLOT with db and 17 as unsupported setup. '
            + 'Additional neutral explanation. '.repeat(20);
        const preview = buildModelOutputPreview(response, { excludedTexts: [source] });
        assert.match(preview.samples[0].text, /prose instead of a replacement method/);
        assert.match(preview.samples[0].text, /withheld-prompt-content/);
        assert.doesNotMatch(JSON.stringify(preview), /refresh_state|更新狀態|private_helper|PRIVATE_SLOT|\bdb\b|\b17\b/);
        assert.ok(readModelOutputPreview(preview));
        assert.equal(preview.executable, false); assert.equal(preview.complete, false);
        assert.ok(preview.samples[0].text.length <= 240 && preview.samples[0].text.length < response.length);
        assert.equal(buildModelOutputPreview((symbol + '\n').repeat(20), { excludedTexts: [source] }).samples[0].text,
            '[withheld-prompt-content]', 'an exact source line still requires whole-line redaction');
    }
});

test('local echo projection hides locations and complete private tokens before display truncation', () => {
    const privateName = 'confidential_identifier_which_crosses_the_display_boundary';
    const prefix = 'Diagnostic refresh_state() ' + 'other '.repeat(30);
    assert.ok(prefix.length < 240 && prefix.length + privateName.length > 240);
    const source = `refresh_state()\n${privateName}\nhttps\nC\n`;
    const preview = buildModelOutputPreview(prefix + privateName + ' more neutral prose. '.repeat(40), { excludedTexts: [source] });
    assert.match(preview.samples[0].text, /Diagnostic/);
    assert.doesNotMatch(preview.samples[0].text, /confidential/);
    const locations = buildModelOutputPreview('Diagnostic refresh_state() https://private.invalid/item C:\\private\\secret.py '
        + 'more neutral prose. '.repeat(40), { excludedTexts: [source] });
    assert.match(locations.samples[0].text, /withheld-location/);
    assert.doesNotMatch(JSON.stringify(locations), /private\.invalid|secret\.py/);
    const secret = 'fixture-' + 'secret-0123456789';
    const hidden = buildModelOutputPreview(prefix + 'neutral '.repeat(100) + secret, {
        excludedTexts: [source], knownSecrets: [secret]
    });
    assert.doesNotMatch(JSON.stringify(hidden), /Diagnostic|neutral|secret-0123456789/);
    const assignment = buildModelOutputPreview(prefix + 'neutral '.repeat(100) + 'password = hidden', { excludedTexts: [source] });
    assert.doesNotMatch(JSON.stringify(assignment), /Diagnostic|neutral/);
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
            const continuation = events.map(event => event.status === 'output-format-retry'
                ? { ...event, detail: { ...event.detail, writerPromptMode: 'seed-code-completion-v1' } } : event);
            const completionReport = renderModelOutputDiagnostics(continuation);
            assert.match(completionReport, selected === 'en' ? /One code-completion recovery/ : /一次程式碼續寫恢復/);
            if (selected === 'en') {
                assert.doesNotMatch(report, /[\u3400-\u9fff]/);
                assert.match(report, /One format correction/);
                assert.match(report, /cannot reconstruct/);
                assert.equal((report.match(/\| HTTP \| 200/g) || []).length, 1, 'second attempt must not borrow prior transport');
            }
        }
    } finally { setLanguage(language); }
});

test('syntax excerpts prioritize exact extracted coordinates without exposing source, secrets or a complete reply', () => {
    const prefix = Array.from({ length: 40 }, (_, index) => `# private source ${index}`).join('\n');
    const text = prefix + '\nnot valid Python here!\n# nearby diagnostic\n';
    const preview = buildModelOutputPreview(text, { excludedTexts: [prefix], focusLine: 41 });
    assert.equal(preview.samples[0].line, 41);
    assert.equal(preview.samples[0].text, 'not valid Python here!');
    assert.doesNotMatch(JSON.stringify(preview), /private source/);
    assert.ok(preview.samples.length <= 6 && preview.samples.reduce((n, item) => n + item.text.length, 0) <= 1200);
    assert.equal(preview.complete, false); assert.equal(preview.executable, false);
    const secret = 'fixture-' + 'secret-0123456789';
    const hidden = buildModelOutputPreview(text + secret, { knownSecrets: [secret], focusLine: 41 });
    assert.doesNotMatch(JSON.stringify(hidden), /not valid Python|secret-0123456789/);
    const repeated = buildModelOutputPreview('one line\n'.repeat(50), { focusLine: 35 });
    assert.equal(repeated.samples[0].line, 35);
    assert.equal(repeated.samples[0].repetitions, 50);
});
