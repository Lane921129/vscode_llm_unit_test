import * as fs from 'node:fs';
import * as path from 'node:path';
import { localize } from '../i18n/core';
import { evidenceHash } from './analysisJournal';
import { presentOutcome, withOutcomeHeader } from './resultPresentation';
import { formatTierHistory } from './tierHistory';
import { readStoredMutationRun, MutationRun } from '../mutation/mutationResult';

export interface ReportIdentity {
    schemaVersion: 'target-report-v1'; sourcePath: string; sourceFile: string;
    target: string; modelIdentity: string; requestedTier: string;
}
export interface TargetReportSummary {
    included: boolean; outcome: string; reason: string; coverage: string; mutation: string;
    testFile?: string; code?: string; mutants?: MutationRun['mutants'];
}
const excluded = new Set(['dummy-skipped', 'stub-skipped', 'stub-smoke-generated']);
export const isReportExcluded = (status: unknown): boolean => typeof status === 'string' && excluded.has(status);
export const reportCell = (value: unknown): string => String(value ?? '').replace(/[\r\n]+/g, ' ')
    .replace(/[&<>|`\[\]]/g, char => `&#${char.charCodeAt(0)};`);
export const reportLink = (file: string): string => file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
export const conciseReason = (reason: string): string => reason.replace(/\s+/g, ' ').slice(0, 400);

function readObject(directory: string, name: string): any {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { return undefined; }
}
function readTest(directory: string, file: unknown, hash: unknown): { testFile: string; code: string } | undefined {
    if (typeof file !== 'string' || !file || path.basename(file) !== file || /[\\/:]/.test(file)
        || typeof hash !== 'string') { return undefined; }
    try {
        const target = path.join(directory, file);
        if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== path.resolve(target)) { return undefined; }
        const code = fs.readFileSync(target, 'utf8');
        return evidenceHash(code) === hash ? { testFile: file, code } : undefined;
    } catch { return undefined; }
}

/** A presentation of the retained candidate, never a search for the highest score or newest file. */
export function summarizeTarget(directory: string, state: any, identity: ReportIdentity, sourceHash: string): TargetReportSummary {
    const outcome = presentOutcome(state);
    const unavailable = state.validationMode === 'execution' ? localize('未執行') : localize('尚未完成有效測量');
    let reason = outcome.kind === 'passed' || outcome.kind === 'executed' ? localize('無')
        : state.failure || state.reason || outcome.label;
    if (!state.failure && !['passed', 'executed', 'skipped'].includes(outcome.kind)) {
        const gaps = Array.isArray(state.qualityGaps) ? state.qualityGaps.filter((v: unknown) => typeof v === 'string') : [];
        reason = [outcome.label, ...gaps, state.reviewStatus === 'incomplete' ? localize('Reviewer 審查未完成') : ''].filter(Boolean).join('；');
    }
    const result: TargetReportSummary = { included: !isReportExcluded(state.terminalStatus), outcome: outcome.label,
        reason, coverage: `N/A (${unavailable})`, mutation: `N/A (${unavailable})` };
    const incomplete = (): TargetReportSummary => {
        if (outcome.kind === 'passed' || outcome.kind === 'executed') {
            result.outcome = localize('未完成：缺少完整通過證據');
            result.reason = localize('目標、保留測資或量測證據無法核對。');
        }
        return result;
    };
    if (state.evidenceValid === false || state.target !== identity.target) { return incomplete(); }
    let retained = state;
    let test = readTest(directory, state.acceptedTest, state.acceptedCodeHash);
    // During a run, an executable checkpoint can exist before quality measurement.
    if (!state.acceptedTest && state.executableBaseline) {
        const candidate = readObject(directory, 'executable_baseline.json');
        if (candidate?.sourceHash === sourceHash && candidate.target === identity.target
            && candidate.codeHash === state.executableBaseline.codeHash) {
            retained = { ...candidate, acceptedCodeHash: candidate.codeHash };
            test = readTest(directory, candidate.testFile, candidate.codeHash);
        }
    }
    if (!test) { return incomplete(); }
    Object.assign(result, test);
    if (state.validationMode === 'execution') { return result; }
    const selected = retained.coverage?.selectedTarget;
    const lines = selected?.executableLines, missing = selected?.missingLines;
    if (selected?.qualifiedName === identity.target && Array.isArray(lines) && lines.length
        && Array.isArray(missing) && [...lines, ...missing].every(n => Number.isSafeInteger(n) && n > 0)
        && new Set(lines).size === lines.length && new Set(missing).size === missing.length
        && missing.every(n => lines.includes(n))) {
        const covered = lines.length - missing.length;
        result.coverage = `${(covered / lines.length * 100).toFixed(2)}% (${covered}/${lines.length})`;
    }
    const measured = readStoredMutationRun(retained.mutation, { sourcePath: identity.sourcePath, sourceHash,
        testHash: retained.acceptedCodeHash, targetScope: { kind: 'function', qualifiedName: identity.target } });
    if (measured.ok) {
        result.mutants = measured.run.mutants;
        const { counts, status, scoreAvailable } = measured.run;
        if (counts.survived && outcome.kind !== 'passed') {
            result.reason += '；' + localize('仍有 {0} 個存活突變。', counts.survived);
        }
        if (status === 'complete' && scoreAvailable && counts.selected > 0) {
            result.mutation = `${(counts.killed / counts.selected * 100).toFixed(2)}% (${counts.killed}/${counts.selected})`;
        } else if (status === 'no-candidates') { result.mutation = localize('N/A（沒有突變候選）'); }
    }
    return result.coverage.startsWith('N/A') || result.mutation.startsWith('N/A') ? incomplete() : result;
}

function identityLines(identity: ReportIdentity): string {
    return localize('- **目標檔案**: {0}\n- **測試函式**: {1}\n- **模型識別**: {2}\n',
        reportCell(identity.sourceFile), reportCell(identity.target), reportCell(identity.modelIdentity));
}
function fence(code: string): string {
    const delimiter = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
    return `${delimiter}python\n${code.trimEnd()}\n${delimiter}\n`;
}

export function renderFinalReport(identity: ReportIdentity, summary: TargetReportSummary, hasFailures: boolean): string {
    return localize('## 最終結果：{0}\n\n', summary.outcome) + identityLines(identity)
        + localize('- **失敗原因**: {0}\n- **覆蓋率**: {1}\n- **突變分數**: {2}\n',
            reportCell(conciseReason(summary.reason)), summary.coverage, summary.mutation)
        + (hasFailures ? localize('- [失敗報告與完整流程](failure_report.md)\n') : '')
        + '\n' + localize('### 測資\n\n')
        + (summary.testFile ? `[${reportCell(summary.testFile)}](${reportLink(summary.testFile)})\n\n${fence(summary.code!)}`
            : localize('尚無已驗證且保留的測資。\n'))
        + '\n' + localize('### 突變測資\n\n')
        + (summary.mutants?.length ? [localize('| 位置 | 突變前 | 突變後 | 結果 |'), '| --- | --- | --- | --- |',
            ...summary.mutants.map(m => `| ${m.line}:${m.column} | ${reportCell(m.from)} | ${reportCell(m.to)} | ${m.status} |`), ''].join('\n')
            : localize('沒有已完成且綁定上述測資的突變案例。\n'));
}

/** All events are read from this run only. Large code and provider payloads stay out of the timeline. */
function eventTimeline(directory: string, runId: string, sourceHash: string): string {
    let events: any[];
    try {
        events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (events.some(event => event.runId !== runId || event.sourceHash !== sourceHash)) { throw Error('identity'); }
    } catch { return localize('事件紀錄缺少或身分不符；流程證據不完整。\n'); }
    return [localize('### 完整流程（依事件順序）'), '', localize('| 序號 | 時間 | 輪次 | 階段 | 狀態 | 摘要 |'),
        '| --- | --- | --- | --- | --- | --- |', ...events.map(event => {
            const detail = event.detail || {};
            const summary = ['role', 'category', 'reason', 'action', 'elapsedMs', 'attempt', 'score', 'testFile', 'reviewStatus']
                .filter(key => typeof detail[key] === 'string' || typeof detail[key] === 'number')
                .map(key => `${key}: ${String(detail[key]).slice(0, 600)}`).join('; ')
                + (Array.isArray(detail.diagnostics) ? '; ' + detail.diagnostics.filter((v: unknown) => typeof v === 'string').join(', ') : '');
            return `| ${event.sequence} | ${reportCell(event.time)} | ${event.loop} | ${reportCell(event.stage)} | ${reportCell(event.status)} | ${reportCell(summary)} |`;
        }), '', '[role_events.jsonl](role_events.jsonl)', ''].join('\n');
}

export function writeTargetReports(directory: string, identity: ReportIdentity, sourceHash: string,
    runId: string, state: Record<string, unknown>, processBody: string): string {
    const summary = summarizeTarget(directory, state, identity, sourceHash);
    const terminal = state.terminalStatus;
    const verifiedPresentation = summary.outcome === presentOutcome(state).label;
    const displayState = verifiedPresentation ? state : { ...state, terminalStatus: 'incomplete', executionVerified: false };
    const failed = !verifiedPresentation || Boolean(state.firstFailure || state.lastRepairFailure)
        || (!isReportExcluded(terminal) && !['running', 'passed', 'execution-passed'].includes(String(terminal)));
    const flow = withOutcomeHeader(formatTierHistory(state) + eventTimeline(directory, runId, sourceHash) + processBody, displayState);
    fs.writeFileSync(path.join(directory, 'workflow_report.md'), flow, 'utf8');
    if (failed) {
        const describeFailure = (value: unknown): string => {
            const failure = value as { stage?: string; category?: string; reason?: string } | undefined;
            return failure ? reportCell([failure.stage, failure.category, failure.reason].filter(Boolean).join(' / ')) : localize('無');
        };
        fs.writeFileSync(path.join(directory, 'failure_report.md'), localize('# 失敗報告\n\n')
            + identityLines(identity) + localize('- **失敗原因**: {0}\n', reportCell(summary.reason))
            + localize('- **首次失敗**: {0}\n- **最近失敗**: {1}\n', describeFailure(state.firstFailure), describeFailure(state.lastFailure))
            + (verifiedPresentation && ['passed', 'execution-passed'].includes(String(terminal)) ? localize('本次最終測試已通過；以下保留曾發生且已處理的失敗。\n\n') : '\n')
            + flow, 'utf8');
    }
    const final = path.join(directory, 'final_report.md');
    if (summary.included) { fs.writeFileSync(final, renderFinalReport(identity, summary, failed), 'utf8'); return final; }
    // This path belongs to the current exclusive run directory; remove only our temporary summary.
    if (fs.existsSync(final)) { fs.unlinkSync(final); }
    return path.join(directory, 'workflow_report.md');
}
