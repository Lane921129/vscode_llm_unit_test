import * as fs from 'node:fs';
import * as path from 'node:path';
import { localize } from '../i18n/core';
import { ImportCheck, ImportCheckRow } from './projectImportCheck';

export type ImportSetupReason = 'initial-check' | 'recheck-ready' | 'recheck-unchanged'
    | 'recheck-new-blockers' | 'recheck-diagnostic-incomplete' | 'proposal-declined' | 'configuration-pending' | 'no-targets' | 'interrupted' | 'error';

type BlockerChange = 'unchanged' | 'new-blocker' | 'diagnostic-incomplete' | 'diagnostic-changed' | 'loaded';

function hasObservedBlocker(row: ImportCheckRow): boolean {
    return row.stage !== 'module-preflight' && !row.diagnostic?.reasonCode && !!row.issue
        && (row.issue.kind !== 'other' || !!row.diagnostic || !!row.issue.origin || !!row.suggestion);
}

function blockerKey(row: ImportCheckRow, directory: string): string {
    const diagnostic = row.diagnostic && { ...row.diagnostic,
        message: row.diagnostic.message.split(directory).join('<preflight-output>') };
    return JSON.stringify([row.file, row.stage, row.issue?.kind, row.issue?.issue, row.issue?.origin,
        diagnostic, row.suggestion && [row.suggestion.file, row.suggestion.line, row.suggestion.operation]]);
}

function compareBlocker(previous: ImportCheckRow | undefined, row: ImportCheckRow,
    beforeDirectory: string, afterDirectory: string): BlockerChange {
    if (row.status === 'loaded') { return 'loaded'; }
    if (!hasObservedBlocker(row)) { return 'diagnostic-incomplete'; }
    if (previous?.stage === 'initialization-plan') { return 'new-blocker'; }
    if (!previous || previous.status !== 'blocked') { return 'new-blocker'; }
    if (!hasObservedBlocker(previous)) { return 'diagnostic-changed'; }
    // A different observed operation/type or a different known source location
    // is evidence of a new blocker. Lost metadata alone is not that evidence.
    if (JSON.stringify([previous.stage, previous.issue?.kind, previous.issue?.issue])
        !== JSON.stringify([row.stage, row.issue?.kind, row.issue?.issue])) { return 'new-blocker'; }
    if (previous.issue?.origin && row.issue?.origin
        && JSON.stringify(previous.issue.origin) !== JSON.stringify(row.issue.origin)) { return 'new-blocker'; }
    if (previous.suggestion && row.suggestion
        && JSON.stringify([previous.suggestion.file, previous.suggestion.line, previous.suggestion.operation])
        !== JSON.stringify([row.suggestion.file, row.suggestion.line, row.suggestion.operation])) { return 'new-blocker'; }
    if (previous.issue?.origin && !row.issue?.origin || previous.diagnostic && !row.diagnostic
        || previous.suggestion && !row.suggestion) { return 'diagnostic-incomplete'; }
    return blockerKey(previous, beforeDirectory) === blockerKey(row, afterDirectory) ? 'unchanged' : 'diagnostic-changed';
}

function compareChecks(before: ImportCheck, after: ImportCheck): Array<{ file: string; change: BlockerChange }> {
    const previous = new Map(before.rows.map(row => [row.file, row]));
    return after.rows.map(row => ({ file: row.file,
        change: compareBlocker(previous.get(row.file), row, before.directory, after.directory) }));
}

/** Compare observed blockers, not a changed fixture ID or an unchanged total count. */
export function recheckReason(before: ImportCheck, after: ImportCheck): ImportSetupReason {
    const remaining = after.rows.filter(row => row.status === 'blocked');
    if (!remaining.length) {
        return !after.rows.length ? 'no-targets' : after.proposedPlan ? 'configuration-pending' : 'recheck-ready';
    }
    const changes = compareChecks(before, after);
    if (changes.some(row => row.change === 'diagnostic-incomplete' || row.change === 'diagnostic-changed')) {
        return 'recheck-diagnostic-incomplete';
    }
    return changes.some(row => row.change === 'new-blocker') ? 'recheck-new-blockers' : 'recheck-unchanged';
}

export function importSetupMessage(reason: ImportSetupReason, check?: ImportCheck): string {
    const count = check?.rows.length || 0;
    const blocked = check?.rows.filter(row => row.status === 'blocked').length || 0;
    const summary = check?.planningSources
        ? localize('初始化規劃：{0} 個模組等待確認；尚未核准新設定或執行函式測試。', count)
        : localize('模組預檢：{0} 個模組，{1} 個受阻；尚未執行函式測試。', count, blocked);
    switch (reason) {
        case 'no-targets': return localize('此範圍沒有可預檢的受測函式；未執行模組載入或函式測試。');
        case 'recheck-ready': return summary + ' ' + localize('重新預檢完成，模組已可載入。請按「開始測試」執行函式測試。');
        case 'recheck-unchanged': return summary + ' ' + localize('重新預檢完成，仍有原先的障礙；已停止重複初始化，請依報告處理原因。');
        case 'recheck-new-blockers': return summary + ' ' + localize('重新預檢發現下一個載入障礙，詳見報告；本次已結束，未自動套用下一份設定。');
        case 'recheck-diagnostic-incomplete': return summary + ' ' + localize('仍有載入障礙，但診斷不完整或無法確認障礙是否改變；請對照各輪報告，前次原因不代表本次已確認的原因。');
        case 'proposal-declined': return summary + ' ' + localize('未套用初始化替身；本次預檢已結束。');
        case 'configuration-pending': return summary + ' ' + localize('模組在預覽設定下可載入，但尚有設定未確認保存；正式測試環境尚未就緒。');
        case 'interrupted': return localize('已中止模組預檢。');
        case 'error': return localize('模組載入預檢未完成。');
        default: return summary;
    }
}

/** A stable session index links each real check; it never labels saved settings as readiness. */
export function saveImportSetupSession(directory: string, checks: ImportCheck[], applied: boolean,
    reason: ImportSetupReason, message: string): string {
    const latest = checks.at(-1);
    const blocked = latest?.rows.filter(row => row.status === 'blocked').length || 0;
    const status = reason === 'interrupted' ? 'cancelled'
        : reason === 'error' || reason === 'no-targets' || !latest?.rows.length ? 'incomplete'
        : blocked ? 'blocked' : latest.proposedPlan ? 'incomplete' : 'ready';
    const nextSetupAvailable = (status === 'blocked' || reason === 'configuration-pending' || reason === 'proposal-declined')
        && !!latest?.proposedPlan && reason !== 'recheck-unchanged';
    const rounds = checks.map(check => ({ directory: path.relative(directory, check.directory).replace(/\\/g, '/'),
        ...(check.planningSources ? { phase: 'planning', planned: check.rows.length } : {}),
        blocked: check.planningSources ? 0 : check.rows.filter(row => row.status === 'blocked').length,
        loaded: check.rows.filter(row => row.status === 'loaded').length }));
    const comparisons = checks.slice(1).map((check, index) => ({
        before: `${rounds[index].directory}/import_check.json`,
        after: `${rounds[index + 1].directory}/import_check.json`,
        rows: compareChecks(checks[index], check)
    }));
    fs.writeFileSync(path.join(directory, 'import_setup.json'), JSON.stringify({ schemaVersion: 'import-setup-session-v1',
        status, reason, applied, nextSetupAvailable, checks: rounds, comparisons }, null, 2));
    const report = path.join(directory, 'import_setup.md');
    fs.writeFileSync(report, [localize('# 模組預檢結果'), '', message, '',
        ...rounds.map((round, index) => (round.phase === 'planning'
            ? localize('- 第 {0} 次規劃：{1} 個模組等待初始化清單確認；實際診斷另列。', index + 1, round.planned)
            : localize('- 第 {0} 次檢查：{1} 個可載入、{2} 個受阻。', index + 1, round.loaded, round.blocked))
            + ` [${localize('逐模組診斷')}](${round.directory}/import_check.md)`), '',
        ...(nextSetupAvailable ? [localize('報告包含新的初始化建議。確認原因後，可再次按「檢查模組載入／初始化設定」預覽並決定是否套用。'), ''] : []),
        localize('每次操作最多套用一份已確認清單並重新預檢一次；不會自動重啟生成或反覆要求初始化。'),
        localize('模組可載入不代表函式測試、審查或突變測試已通過。'), ''].join('\n'));
    return report;
}
