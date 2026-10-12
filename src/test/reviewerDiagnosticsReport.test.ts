import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderReviewerDiagnostics } from '../pipeline/reviewerDiagnosticsPresentation';
import { getLanguage, setLanguage, withLanguage } from '../i18n/core';
import { writeTargetReports } from '../pipeline/targetReport';
import { createResultLayout } from '../pipeline/resultLayout';

const claim = { category: 'target-binding', test_line: 'L2', reason: 'Target needs a class instance.',
    action: 'Construct an instance for the target.', excerpt: 'from sample import target' };
const rejected = { runId: 'run-one', sourceHash: 'source-one', sequence: 1, time: '2026-10-12T00:00:00Z', loop: 1,
    stage: 'reviewer', status: 'invalid-response', detail: { attempt: 0, diagnostics: ['target-binding-contradiction'], rejectedFindings: [claim] } };
const issue = { id: 'Q1', severity: 'quality', category: 'missing-scenario', testLine: 5,
    evidence: 'self.assertEqual(target(1), 2)', reason: 'The documented empty case is not exercised.', action: 'Add the documented empty case.' };
const parsed = { ...rejected, sequence: 2, status: 'parsed', detail: { attempt: 0, diagnostics: [], result: { issues: [issue] } } };

test('Reviewer report distinguishes rejected claims from valid suggestions and unknown semantics in both languages', () => {
    const initialLanguage = getLanguage();
    try {
    for (const language of ['zh-tw', 'en'] as const) {
        setLanguage(language);
        const result = withLanguage(() => renderReviewerDiagnostics([rejected, parsed]));
        assert.ok(result.includes(claim.reason) && result.includes(claim.action));
        assert.ok(result.includes(issue.reason) && result.includes(issue.action));
        assert.ok(result.includes('L2') && result.includes('L5'));
        assert.ok(result.includes('target-binding-contradiction'));
        assert.ok(result.includes(language === 'en' ? 'Assessment rejected' : 'Assessment 未採用'));
        assert.ok(result.includes(language === 'en' ? 'Unknown semantics remain model claims' : '未知語意保留為模型說法'));
        if (language === 'en') { assert.doesNotMatch(result, /[\u3400-\u9fff]/); }
    }
    } finally { setLanguage(initialLanguage); }
});

test('assessment duplicates are not repeated while separate invalid attempts remain visible; malformed replies have codes only', () => {
    const assessed = { ...parsed, sequence: 3, status: 'assessed', detail: { attempt: 2, review: { issues: [issue] } } };
    const result = renderReviewerDiagnostics([parsed, assessed, rejected, { ...rejected, sequence: 4 },
        { ...rejected, sequence: 5, detail: { diagnostics: ['invalid-json'] } }]);
    assert.equal(result.split(issue.reason).length - 1, 1);
    assert.equal(result.split(claim.reason).length - 1, 2);
    assert.ok(result.includes('invalid-json'));
    assert.ok(result.includes('沒有可安全還原的 finding 欄位'));
});

test('report finding cells are bounded, escape Markdown/HTML, and withhold generic credentials', () => {
    const result = renderReviewerDiagnostics([{ ...rejected, detail: { diagnostics: ['invalid-finding'], rejectedFindings: [{
        category: '<script>|', test_line: 'L2', reason: 'r'.repeat(1000), action: 'Bearer ' + 'A'.repeat(32),
        excerpt: '[unsafe](https://example.invalid)|<img>'
    }] } }]);
    assert.ok(result.includes('&#60;script&#62;&#124;'));
    assert.ok(!result.includes('<img>') && !result.includes('[unsafe]'));
    assert.ok(!result.includes('r'.repeat(601)) && !result.includes('A'.repeat(32)));
    assert.ok(result.includes('withheld-sensitive-content'));
});

test('organized workflow and round failure reports show findings without leaking another round or claiming mutation approval', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-diagnostic-report-'));
    try {
        fs.writeFileSync(path.join(root, 'target.json'), '{}');
        const data = createResultLayout(root);
        fs.mkdirSync(path.join(root, 'loop', '1')); fs.mkdirSync(path.join(root, 'loop', '2'));
        const second = { ...parsed, sequence: 3, loop: 2 };
        fs.writeFileSync(path.join(data, 'role_events.jsonl'), [rejected, second].map(value => JSON.stringify(value)).join('\n') + '\n');
        writeTargetReports(data, { schemaVersion: 'target-report-v1', sourcePath: path.join(root, 'sample.py'),
            sourceFile: 'sample.py', target: 'target', modelIdentity: 'local/neutral',
            requestedTier: 'tier2' }, 'source-one', 'run-one', { terminalStatus: 'review-blocked', reviewStatus: 'incomplete',
            validationMode: 'full', failure: 'Review remained incomplete.' }, '## 第 1 輪測試\n\n## 第 2 輪測試\n');
        const workflow = fs.readFileSync(path.join(data, 'workflow_report.md'), 'utf8');
        const first = fs.readFileSync(path.join(root, 'loop', '1', 'failure_report.md'), 'utf8');
        const next = fs.readFileSync(path.join(root, 'loop', '2', 'failure_report.md'), 'utf8');
        const index = fs.readFileSync(path.join(root, 'failure_report.md'), 'utf8');
        assert.ok(workflow.includes(claim.reason) && workflow.includes(issue.reason));
        assert.ok(index.includes(claim.reason) && index.includes(issue.reason));
        assert.ok(first.includes(claim.reason) && !first.includes(issue.reason));
        assert.ok(next.includes(issue.reason) && !next.includes(claim.reason));
        assert.ok(!workflow.includes('approvedCodeHash'));
        assert.ok(fs.readFileSync(path.join(root, 'final_report.md'), 'utf8').includes('N/A'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
