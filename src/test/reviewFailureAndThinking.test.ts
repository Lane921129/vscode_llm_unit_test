import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reviewCaseTable } from '../pipeline/caseTable/reviewCaseTable';
import { CASE_TABLE_REVIEW_JSON } from '../pipeline/caseTable/artifactNames';
import { parseCaseRows } from '../pipeline/caseTable/caseRowParser';
import { localThinkingOptions } from '../llm/localThinking';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const rows = parseCaseRows(JSON.stringify({ scenario: 'normal input', category: 'normal', args: '(3,)', kwargs: '{}', mocks: '',
    requirement: '' }), { origin: 'analyst', requirementIds: [], firstIndex: 1 }).rows;
const outputLimit = () => new AnalysisStageError('model-format', 'model-response', 'fixture output limit', { reasonCode: 'output-token-limit' });

test('a review answer cut at the output limit keeps the table and only marks the review incomplete', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-failure-'));
    try {
        let validated = 0;
        const result = await reviewCaseTable({ directory, rows, source: 'def f(x):\n    return x\n', requirements: [],
            ask: async () => { throw outputLimit(); }, validate: async proposed => { validated++; return proposed; } });
        assert.deepEqual(result, rows);
        assert.equal(validated, 0);
        const record = JSON.parse(fs.readFileSync(path.join(directory, CASE_TABLE_REVIEW_JSON), 'utf8'));
        assert.equal(record.completed, false);
        assert.equal(record.failure, 'output-token-limit');
        assert.deepEqual(record.addedRowIds, []);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a failed review correction counts as unresolved instead of failing the target', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-correction-failure-'));
    try {
        let calls = 0;
        const result = await reviewCaseTable({ directory, rows, source: 'def f(x):\n    return x\n', requirements: [],
            ask: async () => { calls++; if (calls === 1) { return 'not a review line'; } throw outputLimit(); },
            validate: async proposed => proposed });
        assert.deepEqual(result, rows);
        const record = JSON.parse(fs.readFileSync(path.join(directory, CASE_TABLE_REVIEW_JSON), 'utf8'));
        assert.equal(record.completed, false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('non-model review failures still propagate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-propagate-'));
    try {
        await assert.rejects(reviewCaseTable({ directory, rows, source: 'def f(x):\n    return x\n', requirements: [],
            ask: async () => { throw new AnalysisStageError('budget', 'target-budget', 'fixture budget stop'); },
            validate: async proposed => proposed }), /fixture budget stop/);
        await assert.rejects(reviewCaseTable({ directory, rows, source: 'def f(x):\n    return x\n', requirements: [],
            ask: async () => { throw new Error('plain failure'); }, validate: async proposed => proposed }), /plain failure/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('disabled thinking asks gpt-oss for the low level and every other model for think false', () => {
    assert.deepEqual(localThinkingOptions('disabled', 'gpt-oss:20b'), { think: 'low' });
    assert.deepEqual(localThinkingOptions('disabled', 'GPT-OSS'), { think: 'low' });
    assert.deepEqual(localThinkingOptions('disabled', 'ministral-3:14b'), { think: false });
    assert.deepEqual(localThinkingOptions('disabled', 'my-gpt-oss-copy'), { think: false });
    assert.deepEqual(localThinkingOptions('disabled'), { think: false });
    assert.deepEqual(localThinkingOptions('provider-default', 'gpt-oss:20b'), {});
});
