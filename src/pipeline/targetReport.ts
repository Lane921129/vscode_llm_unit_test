import { functionReportDirectory, resultArtifactPath, roundDirectory } from './resultLayout';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { localize } from '../i18n/core';
import { evidenceHash } from './analysisJournal';
import { evaluateQuality, validateQualityPolicy } from './qualityPolicy';
import { presentOutcome, presentSummaryOutcome, withOutcomeHeader } from './resultPresentation';
import { formatTierHistory } from './tierHistory';
import { readStoredMutationRun, readMutationCodeChange, MutationRun } from '../mutation/mutationResult';

export interface ReportIdentity {
    schemaVersion: 'target-report-v1'; sourcePath: string; sourceFile: string;
    target: string; modelIdentity: string; requestedTier: string;
    requestedMutationEngine?: string; mutationWorkers?: number;
}
export interface TargetReportSummary {
    included: boolean; outcome: string; reason: string; coverage: string; mutation: string;
    testFile?: string; code?: string; mutants?: MutationRun['mutants'];
    summaryOutcome?: string; summaryReason?: string;
    mutationEngine?: string; mutationOperatorSet?: string; mutationElapsedMs?: number;
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
        const target = resultArtifactPath(directory, file);
        if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== path.resolve(target)) { return undefined; }
        const code = fs.readFileSync(target, 'utf8');
        return evidenceHash(code) === hash
            ? { testFile: path.relative(functionReportDirectory(directory), target).replace(/\\/g, '/'), code } : undefined;
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
    const publicReason = state.failure || state.reason || [state.terminalStatus === 'execution-passed-review-incomplete'
        ? localize('未完成：缺少完整通過證據') : outcome.label,
        ...(Array.isArray(state.qualityGaps) ? state.qualityGaps.filter((v: unknown) => typeof v === 'string') : [])].join('；');
    const result: TargetReportSummary = { included: !isReportExcluded(state.terminalStatus), outcome: outcome.label,
        reason, summaryReason: ['passed', 'executed'].includes(outcome.kind) ? reason : publicReason, coverage: `N/A (${unavailable})`, mutation: `N/A (${unavailable})` };
    const incomplete = (): TargetReportSummary => {
        if (outcome.kind === 'passed' || outcome.kind === 'executed') {
            result.outcome = localize('未完成：缺少完整通過證據');
            result.reason = localize('目標、保留測資或量測證據無法核對。');
            result.summaryReason = result.reason;
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
        result.mutationEngine = measured.run.engine;
        result.mutationOperatorSet = measured.run.operatorSetVersion || undefined;
        result.mutationElapsedMs = measured.run.elapsedMs;
        const { counts, status, scoreAvailable } = measured.run;
        let thresholdMet = false;
        const policy = validateQualityPolicy(state.qualityPolicy);
        if (status === 'complete' && scoreAvailable && counts.selected > 0) {
            result.mutation = `${(counts.killed / counts.selected * 100).toFixed(2)}% (${counts.killed}/${counts.selected})`;
            if (policy.ok) {
                const threshold = policy.policy.mutationThreshold;
                thresholdMet = BigInt(counts.killed) * BigInt(threshold.denominator)
                    >= BigInt(counts.selected) * BigInt(threshold.numerator);
                result.mutation += localize('；門檻 ≥ {0}%', 100 * threshold.numerator / threshold.denominator);
            }
        } else if (status === 'no-candidates') { result.mutation = localize('N/A（沒有突變候選）'); }
        if (counts.survived && outcome.kind !== 'passed' && !thresholdMet) {
            result.reason += '；' + localize('仍有 {0} 個存活突變。', counts.survived);
            result.summaryReason += '；' + localize('仍有 {0} 個存活突變。', counts.survived);
        }
    }
    if (result.coverage.startsWith('N/A') || result.mutation.startsWith('N/A')) { return incomplete(); }
    const presentation = presentSummaryOutcome(state);
    if (presentation.label !== outcome.label && state.qualityAssessment?.toolsSatisfied === true) {
        const targetScope = { kind: 'function' as const, qualifiedName: identity.target };
        const assessment = evaluateQuality(state.qualityPolicy, {
            identity: { sourcePath: identity.sourcePath, sourceHash, testHash: state.acceptedCodeHash,
                targetScope, policyHash: state.qualityPolicy?.policyHash },
            executionPassed: Boolean(state.execution),
            coverage: { sourceHash, testHash: state.acceptedCodeHash, targetScope, assessment: retained.coverage?.assessment },
            mutation: retained.mutation, reviewStatus: state.reviewStatus, qualityGaps: state.qualityGaps,
            generationMode: state.generationMode
        });
        if (assessment.toolsSatisfied) { result.summaryOutcome = presentation.label; }
    }
    return result;
}

function identityLines(identity: ReportIdentity): string {
    return localize('- **目標檔案**: {0}\n- **測試函式**: {1}\n- **模型識別**: {2}\n',
        reportCell(identity.sourceFile), reportCell(identity.target), reportCell(identity.modelIdentity));
}
function fence(code: string): string {
    const delimiter = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
    return `${delimiter}python\n${code.trimEnd()}\n${delimiter}\n`;
}

function codeTableCell(code: string): string {
    return code.split(/\r\n|\r|\n/).map(line => {
        const text = line.trim();
        if (!text) { return ''; }
        const delimiter = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
        const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
        return delimiter + padding + text.replace(/\|/g, '\\|') + padding + delimiter;
    }).join(' ↵ ');
}

/** Keep the compact table intact; show each recorded variant separately underneath. */
export function renderMutationCodeTable(mutants: NonNullable<TargetReportSummary['mutants']>): string {
    if (!mutants.length) { return ''; }
    return '\n' + localize('### 突變程式碼逐項對照\n\n')
        + localize('每列對應上表同一筆突變，顯示修改處的程式碼；空白與排版經整理，測試案例沿用上方測資。\n\n')
        + [localize('| 位置 | 突變 | 修改前程式碼 | 修改後程式碼 | 結果 |'), '| --- | --- | --- | --- | --- |',
            ...mutants.map(m => {
                const change = readMutationCodeChange(m.codeChange);
                const unavailable = localize('此筆紀錄未保存程式碼');
                return `| ${m.line}:${m.column} | ${reportCell(m.from)} → ${reportCell(m.to)} | ${change ? codeTableCell(change.before) : unavailable} | ${change ? codeTableCell(change.after) : unavailable} | ${m.status} |`;
            }), ''].join('\n');
}

/** Attribution comes only from the guarded runner's structured unittest result. */
export function renderMutationDiagnostics(mutants: MutationRun['mutants'], elapsedMs?: number): string {
    if (!mutants.some(m => m.elapsedMs !== undefined || m.killedBy?.length)) { return ''; }
    return '\n' + localize('### 突變執行診斷\n\n')
        + (elapsedMs !== undefined ? localize('本輪量測耗時：{0} 秒。\n\n', (elapsedMs / 1000).toFixed(2)) : '')
        + [localize('| 位置 | 突變 | 觸發失敗的測試 | 耗時（毫秒） |'), '| --- | --- | --- | --- |',
            ...mutants.map(m => `| ${m.line}:${m.column} | ${reportCell(m.from)} → ${reportCell(m.to)} | ${m.killedBy?.length ? m.killedBy.map(reportCell).join('; ') : '—'} | ${m.elapsedMs ?? '—'} |`), ''].join('\n');
}

export function renderFinalReport(identity: ReportIdentity, summary: TargetReportSummary, hasFailures: boolean): string {
    return localize('## 最終結果：{0}\n\n', summary.summaryOutcome || (summary.outcome === localize('未完成：執行達標，審查未完成')
        ? localize('未完成：缺少完整通過證據') : summary.outcome)) + identityLines(identity)
        + (summary.summaryOutcome
            ? localize('- **覆蓋率**: {0}\n- **突變分數**: {1}\n', summary.coverage, summary.mutation)
            : localize('- **失敗原因**: {0}\n- **覆蓋率**: {1}\n- **突變分數**: {2}\n',
                reportCell(conciseReason(summary.summaryReason || summary.reason)), summary.coverage, summary.mutation))
        + (summary.mutationEngine ? localize('- **突變引擎／規則版本**: {0} / {1}\n',
            reportCell(summary.mutationEngine), reportCell(summary.mutationOperatorSet))
            : identity.requestedMutationEngine ? localize('- **指定突變引擎**: {0}（尚無可核對量測）\n', reportCell(identity.requestedMutationEngine)) : '')
        + (hasFailures ? localize('- [失敗報告與完整流程](failure_report.md)\n') : '')
        + '\n' + localize('### 測資\n\n')
        + (summary.testFile ? `[${reportCell(summary.testFile)}](${reportLink(summary.testFile)})\n\n${fence(summary.code!)}`
            : localize('尚無已驗證且保留的測資。\n'))
        + '\n' + localize('### 突變測資\n\n')
        + (summary.mutants?.length ? [localize('| 位置 | 突變前 | 突變後 | 結果 |'), '| --- | --- | --- | --- |',
            ...summary.mutants.map(m => `| ${m.line}:${m.column} | ${reportCell(m.from)} | ${reportCell(m.to)} | ${m.status} |`), ''].join('\n')
            : localize('沒有已完成且綁定上述測資的突變案例。\n'))
        + renderMutationCodeTable(summary.mutants || [])
        + renderMutationDiagnostics(summary.mutants || [], summary.mutationElapsedMs);
}

/** All events are read from this run only. Large code and provider payloads stay out of the timeline. */
function eventTimeline(directory: string, runId: string, sourceHash: string, loop?: number): string {
    let events: any[];
    try {
        events = fs.readFileSync(path.join(directory, 'role_events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (events.some(event => event.runId !== runId || event.sourceHash !== sourceHash)) { throw Error('identity'); }
    } catch { return localize('事件紀錄缺少或身分不符；流程證據不完整。\n'); }
    if (loop !== undefined) { events = events.filter(event => event.loop === loop); }
    return [localize('### 完整流程（依事件順序）'), '', localize('| 序號 | 時間 | 輪次 | 階段 | 狀態 | 摘要 |'),
        '| --- | --- | --- | --- | --- | --- |', ...events.map(event => {
            const detail = event.detail || {};
            const summary = ['role', 'category', 'reason', 'action', 'elapsedMs', 'attempt', 'score', 'testFile', 'reviewStatus', 'codeHash', 'requested', 'actual', 'engine', 'operatorSetVersion', 'workers']
                .filter(key => typeof detail[key] === 'string' || typeof detail[key] === 'number')
                .map(key => `${key}: ${String(detail[key]).slice(0, 600)}`).join('; ')
                + (Array.isArray(detail.diagnostics) ? '; ' + detail.diagnostics.filter((v: unknown) => typeof v === 'string').join(', ') : '');
            return `| ${event.sequence} | ${reportCell(event.time)} | ${event.loop} | ${reportCell(event.stage)} | ${reportCell(event.status)} | ${reportCell(summary)} |`;
        }), '', `[role_events.jsonl](${loop === undefined ? '' : '../_run/'}role_events.jsonl)`, ''].join('\n');
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
    if (functionReportDirectory(directory) !== directory) {
        return writeOrganizedReports(directory, identity, sourceHash, runId, state, processBody, summary, failed);
    }
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


/** Round reports never inherit a later round's retained score or terminal status. */
function writeOrganizedReports(data: string, identity: ReportIdentity, sourceHash: string, runId: string,
    state: Record<string, unknown>, body: string, summary: TargetReportSummary, failed: boolean): string {
    const root = functionReportDirectory(data);
    const sections = new Map<number, string>();
    // Only framework headings outside fenced evidence delimit rounds.
    let round: number | undefined, fenceMarker: string | undefined;
    for (const line of body.split('\n')) {
        const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker && !fenceMarker) { fenceMarker = marker; }
        else if (marker && fenceMarker && marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) { fenceMarker = undefined; }
        const header = !fenceMarker && /^(?:## 第 (\d+) 輪測試|## Test round (\d+))\s*$/.exec(line);
        if (header) { round = Number(header[1] || header[2]); }
        if (round !== undefined) { sections.set(round, (sections.get(round) || '') + line + '\n'); }
    }
    const loopRoot = path.join(root, 'loop');
    const rounds = fs.readdirSync(loopRoot).filter(name => /^[1-9]\d*$/.test(name)
        && fs.lstatSync(path.join(loopRoot, name)).isDirectory()).map(Number);
    for (const number of sections.keys()) { if (!rounds.includes(number)) { rounds.push(number); } }
    let events: any[] = [];
    try {
        events = fs.readFileSync(path.join(data, 'role_events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (events.some(event => event.runId !== runId || event.sourceHash !== sourceHash)) { events = []; }
    } catch { /* eventTimeline explicitly reports missing evidence. */ }
    const links: string[] = [];
    for (const number of rounds.sort((a, b) => a - b)) {
        const directory = roundDirectory(data, number);
        fs.mkdirSync(directory, { recursive: true });
        const failures = events.filter(event => event.loop === number && /failed|rejected|invalid|unavailable|rollback|retained-baseline/.test(event.status));
        const artifacts = fs.readdirSync(directory).filter(name => !['report.md', 'failure_report.md'].includes(name));
        const title = localize('## 第 {0} 輪結果', number);
        const flow = title + '\n\n' + identityLines(identity) + '\n'
            + localize('本頁僅記錄本輪；最終保留成果請見函式的 final_report.md。\n\n')
            + ((state.tierHistory as any)?.transitions || []).filter((item: any) => item.loop === number)
                .map((item: any) => localize('第 {0} 輪 Tier {1} → {2}（{3}）', item.loop, item.from, item.to, item.reason) + '\n\n').join('')
            + eventTimeline(data, runId, sourceHash, number) + (sections.get(number) || '')
            + '\n' + localize('### 本輪檔案\n\n')
            + artifacts.map(file => `- [${reportCell(file)}](${reportLink(file)})`).join('\n') + '\n';
        fs.writeFileSync(path.join(directory, 'report.md'), flow, 'utf8');
        fs.writeFileSync(path.join(directory, 'failure_report.md'), localize('# 失敗報告\n\n')
            + (failures.length ? localize('本輪有 {0} 筆失敗或回退事件；詳情與完整流程如下。\n\n', failures.length)
                : localize('本輪沒有記錄失敗事件；不代表完整品質通過。\n\n')) + flow, 'utf8');
        links.push(`- [${reportCell(title.replace(/^## /, ''))}](loop/${number}/report.md) · [${localize('失敗報告')}](loop/${number}/failure_report.md)`);
    }
    const describe = (value: unknown): string => {
        const f = value as { stage?: string; category?: string; reason?: string } | undefined;
        return f ? reportCell(conciseReason([f.stage, f.category, f.reason].filter(Boolean).join(' / '))) : localize('無');
    };
    const index = localize('# 失敗報告\n\n') + identityLines(identity)
        + localize('- **失敗原因**: {0}\n', reportCell(conciseReason(summary.reason)))
        + localize('- **首次失敗**: {0}\n- **最近失敗**: {1}\n', describe(state.firstFailure), describe(state.lastFailure))
        + '\n' + localize('### 各輪流程\n\n') + links.join('\n') + '\n\n'
        + localize('[共用紀錄與完整稽核流程](loop/_run/workflow_report.md)\n');
    fs.writeFileSync(path.join(root, 'failure_report.md'), index, 'utf8');
    const final = path.join(root, 'final_report.md');
    if (!summary.included) {
        if (fs.existsSync(final)) { fs.unlinkSync(final); }
        return path.join(data, 'workflow_report.md');
    }
    fs.writeFileSync(final, renderFinalReport(identity, summary, failed)
        + '\n' + localize('### 各輪流程\n\n') + links.join('\n') + '\n<!-- result-layout: function-loops-v1 -->\n', 'utf8');
    return final;
}
