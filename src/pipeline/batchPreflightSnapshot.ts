import * as fs from 'node:fs';
import * as path from 'node:path';
import { localize } from '../i18n/core';
import { redactCredentialStrings } from './artifactSafety';
import { BatchPreflightRow, safeBatchPreflightRows } from './batchPreflightPartition';

/** Keep the final load diagnosis inside the batch, so moving one batch preserves its evidence. */
export function writeBatchPreflightSnapshot(directory: string, input: {
    rows: readonly BatchPreflightRow[]; actualImports: boolean; fixtureId: string | null;
    knownSecrets?: readonly string[];
}): string {
    const folder = path.join(directory, 'preflight');
    fs.mkdirSync(folder, { recursive: true });
    const rows = redactCredentialStrings(safeBatchPreflightRows(input.rows), input.knownSecrets || []) as BatchPreflightRow[];
    fs.writeFileSync(path.join(folder, 'final_import_check.json'), JSON.stringify({
        schemaVersion: 'batch-import-snapshot-v1', actualImports: input.actualImports,
        fixtureId: input.fixtureId, rows
    }, null, 2), 'utf8');
    const cell = (value: string) => value.replace(/[\r\n]/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const report = path.join(folder, 'final_import_check.md');
    fs.writeFileSync(report, [localize('# 本批次最後模組載入診斷'), '',
        localize('實際載入檢查：{0}；初始化設定：{1}', input.actualImports ? localize('是') : localize('否'), input.fixtureId || localize('無')), '',
        localize('| 來源 | 載入狀態 | 階段 | 原因 | 處理方式 |'), '| --- | --- | --- | --- | --- |',
        ...rows.map(row => `| ${cell(row.file)} | ${row.status} | ${cell(row.stage || '')} | ${cell(row.issue?.issue || row.diagnostic?.message || '')} | ${cell(row.issue?.advice || '')} |`), '',
        localize('載入成功僅代表可開始函式分析；受阻目標未執行測試，不計為通過。'), ''
    ].join('\n'), 'utf8');
    return report;
}
