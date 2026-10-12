import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getLanguage, setLanguage, withLanguage } from '../i18n/core';
import { renderTraceTiming } from '../pipeline/traceTimingPresentation';
import { writeTargetReports } from '../pipeline/targetReport';
import { createResultLayout } from '../pipeline/resultLayout';

const initial = { run_id: 'trace-one', func_name: 'advance', complete: false, duration_ms: 1880,
    planning: { status: 'completed', duration_ms: 220 },
    trace_timing: { version: 'trace-startup-budget-v1', totalTimeoutSeconds: 18, planningTimeoutSeconds: 15,
        caseTimeoutSeconds: 5, outerTimeoutMs: 20000,
        requestedTraceTiming: { totalTimeoutSeconds: 60, planningTimeoutSeconds: 15, caseTimeoutSeconds: 5 } },
    cases: [{ case_id: 'case_0', status: 'returned', duration_ms: 0 },
        { case_id: 'case_1', status: 'timeout', duration_ms: 5000, reason: 'case-timeout' },
        { case_id: 'case_2', status: 'not_started', reason: 'total-budget-exhausted' }] };

test('Trace timing distinguishes measured duration, configured limits, actual allocations and unknowns in both languages', () => {
    const saved = getLanguage();
    try {
        for (const language of ['zh-tw', 'en'] as const) {
            setLanguage(language);
            const result = withLanguage(() => renderTraceTiming({ initialTargetObservations: initial }, 'advance'));
            assert.match(result, /\| case_0 \| returned \| 0 \|/);
            assert.match(result, /\| case_1 \| timeout \| 5000 \| case-timeout \|/);
            assert.match(result, language === 'en' ? /\| case_2 \| not_started \| unknown \|/ : /\| case_2 \| not_started \| 未知 \|/);
            assert.match(result, /\| (?:整體 Trace|Entire Trace) \| 60 \| 18 \|/);
            assert.match(result, /\| (?:輸入規劃|Input planning) \| completed \| 220 \|/);
            assert.match(result, language === 'en' ? /not LLM thinking time/ : /並非 LLM 思考時間/);
            if (language === 'en') { assert.doesNotMatch(result, /[\u3400-\u9fff]/); }
        }
    } finally { setLanguage(saved); }
});

test('same Trace run is shown once while unrelated qualified targets and malformed numbers are never substituted', () => {
    const additional = { ...initial, run_id: 'trace-two', duration_ms: Number.NaN,
        planning: { status: 'completed', duration_ms: '220' }, cases: [{ case_id: 'case_3', status: 'raised', duration_ms: -2 }] };
    const state = { initialTargetObservations: initial, sourceContext: { traceResult: initial },
        writerEvidenceBundle: { initialTargetObservations: initial, supplementalTargetObservations: additional } };
    const result = renderTraceTiming(state, 'advance');
    assert.equal(result.split('| case_1 |').length - 1, 1);
    assert.equal(result.split('| case_3 |').length - 1, 1);
    assert.match(result, /\| case_3 \| raised \| (?:unknown|未知) \|/);
    assert.equal(renderTraceTiming(state, 'Other.advance'), '');
    assert.doesNotMatch(result, /NaN|\| -2 \|/);
});

test('Trace projection excludes provider responses, traceback, arbitrary reason prose and unsafe Markdown', () => {
    const marker = 'opaque-provider-response-must-not-appear';
    const state = { initialTargetObservations: { ...initial, rawProviderResponse: marker, load_diagnostic: { traceback: marker },
        cases: [{ case_id: '<script>|[link]', status: 'APPROVED', duration_ms: Infinity, reason: marker + ' private path', diagnostic: marker },
            { case_id: 'Bearer ' + 'A'.repeat(32), status: 'blocked', duration_ms: 5, reason: 'blocked' }] } };
    const result = renderTraceTiming(state, 'advance');
    assert.ok(!result.includes(marker) && !result.includes('APPROVED') && !result.includes('Infinity'));
    assert.ok(!result.includes('<script>') && !result.includes('[link]') && !result.includes('A'.repeat(32)));
    assert.ok(result.includes('&#60;script&#62;&#124;&#91;link&#93;'));
    assert.ok(result.includes('withheld-sensitive-content'));
});

test('complete workflow and function failure report include Trace timing while final and unrelated round reports stay compact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-timing-report-'));
    try {
        fs.writeFileSync(path.join(root, 'target.json'), '{}');
        const data = createResultLayout(root);
        fs.mkdirSync(path.join(root, 'loop', '1'));
        const event = { runId: 'run-one', sourceHash: 'source-one', sequence: 1, time: '2026-10-12T00:00:00Z', loop: 1,
            stage: 'reviewer', status: 'unavailable', detail: { diagnostics: ['invalid-json'] } };
        fs.writeFileSync(path.join(data, 'role_events.jsonl'), JSON.stringify(event) + '\n');
        writeTargetReports(data, { schemaVersion: 'target-report-v1', sourcePath: path.join(root, 'sample.py'), sourceFile: 'sample.py',
            target: 'advance', modelIdentity: 'local/neutral', requestedTier: 'tier2' }, 'source-one', 'run-one', {
            terminalStatus: 'review-blocked', validationMode: 'full', reviewStatus: 'incomplete', failure: 'Review incomplete.',
            initialTargetObservations: initial, sourceContext: { traceResult: initial }
        }, '## 第 1 輪測試\n');
        for (const file of [path.join(data, 'workflow_report.md'), path.join(root, 'failure_report.md')]) {
            const report = fs.readFileSync(file, 'utf8');
            assert.match(report, /\| case_1 \| timeout \| 5000 \| case-timeout \|/);
            assert.equal(report.split('| case_1 |').length - 1, 1);
        }
        assert.ok(!fs.readFileSync(path.join(root, 'final_report.md'), 'utf8').includes('| case_1 |'));
        assert.ok(!fs.readFileSync(path.join(root, 'loop', '1', 'failure_report.md'), 'utf8').includes('| case_1 |'));
        assert.ok(fs.readFileSync(path.join(root, 'final_report.md'), 'utf8').includes('N/A'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
