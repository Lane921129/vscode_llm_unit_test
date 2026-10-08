import * as fs from 'node:fs';
import * as path from 'node:path';
import { localize } from '../i18n/core';
import { ImportCheck, ImportCheckRow } from './projectImportCheck';

export type ImportSetupReason = 'initial-check' | 'recheck-ready' | 'recheck-unchanged'
    | 'recheck-new-blockers' | 'proposal-declined' | 'configuration-pending' | 'no-targets' | 'interrupted' | 'error';

function blockerKey(row: ImportCheckRow, directory: string): string {
    const diagnostic = row.diagnostic && { ...row.diagnostic,
        message: row.diagnostic.message.split(directory).join('<preflight-output>') };
    return JSON.stringify([row.file, row.stage, row.issue?.kind, row.issue?.issue, row.issue?.origin,
        diagnostic, row.suggestion && [row.suggestion.file, row.suggestion.line, row.suggestion.operation]]);
}

/** Compare observed blockers, not a changed fixture ID or an unchanged total count. */
export function recheckReason(before: ImportCheck, after: ImportCheck): ImportSetupReason {
    const remaining = after.rows.filter(row => row.status === 'blocked');
    if (!remaining.length) {
        return !after.rows.length ? 'no-targets' : after.proposedPlan ? 'configuration-pending' : 'recheck-ready';
    }
    const previous = new Set(before.rows.filter(row => row.status === 'blocked').map(row => blockerKey(row, before.directory)));
    return remaining.some(row => !previous.has(blockerKey(row, after.directory))) ? 'recheck-new-blockers' : 'recheck-unchanged';
}

export function importSetupMessage(reason: ImportSetupReason, check?: ImportCheck): string {
    const count = check?.rows.length || 0;
    const blocked = check?.rows.filter(row => row.status === 'blocked').length || 0;
    const summary = localize('模組預檢：{0} 個模組，{1} 個受阻；尚未執行函式測試。', count, blocked);
    switch (reason) {
        case 'no-targets': return localize('此範圍沒有可預檢的受測函式；未執行模組載入或函式測試。');
        case 'recheck-ready': return summary + ' ' + localize('重新預檢完成，模組已可載入。請按「開始測試」執行函式測試。');
        case 'recheck-unchanged': return summary + ' ' + localize('重新預檢完成，仍有原先的障礙；已停止重複初始化，請依報告處理原因。');
        case 'recheck-new-blockers': return summary + ' ' + localize('重新預檢發現下一個載入障礙，詳見報告；本次已結束，未自動套用下一份設定。');
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
        blocked: check.rows.filter(row => row.status === 'blocked').length,
        loaded: check.rows.filter(row => row.status === 'loaded').length }));
    fs.writeFileSync(path.join(directory, 'import_setup.json'), JSON.stringify({ schemaVersion: 'import-setup-session-v1',
        status, reason, applied, nextSetupAvailable, checks: rounds }, null, 2));
    const report = path.join(directory, 'import_setup.md');
    fs.writeFileSync(report, [localize('# 模組預檢結果'), '', message, '',
        ...rounds.map((round, index) => localize('- 第 {0} 次檢查：{1} 個可載入、{2} 個受阻。', index + 1, round.loaded, round.blocked)
            + ` [${localize('逐模組診斷')}](${round.directory}/import_check.md)`), '',
        ...(nextSetupAvailable ? [localize('報告包含新的初始化建議。確認原因後，可再次按「檢查模組載入／初始化設定」預覽並決定是否套用。'), ''] : []),
        localize('每次操作最多套用一份已確認清單並重新預檢一次；不會自動重啟生成或反覆要求初始化。'),
        localize('模組可載入不代表函式測試、審查或突變測試已通過。'), ''].join('\n'));
    return report;
}
