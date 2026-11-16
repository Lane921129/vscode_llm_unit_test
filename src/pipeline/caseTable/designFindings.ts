import { DESIGN_FINDINGS_JSON, DESIGN_FINDINGS_MD } from './artifactNames';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaseRow } from './caseTable';
import { reportCell } from './coverageReports';

/** Only proposed rows with an actual dual-capture result can support a finding. */
export interface SurvivorRowEvidence {
    mutantId: string;
    rowId: string;
    line: number;
    original: string;
    mutated: string;
}

export function collectDesignFindings(evidence: SurvivorRowEvidence[], rows: CaseRow[]) {
    const groups = new Map<string, SurvivorRowEvidence[]>();
    for (const item of evidence) { groups.set(item.mutantId, [...(groups.get(item.mutantId) ?? []), item]); }
    return [...groups.values()].filter(items => items.length > 0 && items.every(item =>
        rows.find(row => row.id === item.rowId)?.reason === 'survivor-row-indistinguishable'))
        .map(items => ({ mutantId: items[0].mutantId, line: items[0].line,
            original: items[0].original, mutated: items[0].mutated, rowIds: items.map(item => item.rowId),
            reason: 'possibly-redundant-condition-or-dead-code' as const }));
}

export function writeDesignFindings(directory: string, target: string, evidence: SurvivorRowEvidence[], rows: CaseRow[]) {
    const findings = collectDesignFindings(evidence, rows);
    fs.writeFileSync(path.join(directory, DESIGN_FINDINGS_JSON), JSON.stringify({ version: 'design-findings-v1', target, findings }, null, 2) + '\n', 'utf8');
    const lines = ['# 設計疑點 / Design findings', '',
        '僅是本輪候選輸入無法區分的觀察，不是等價突變或死碼的證明。', '',
        '| 位置 | 原始程式行 | 突變後程式行 | 案例列 | 疑點 |', '| --- | --- | --- | --- | --- |',
        ...findings.map(item => `| L${item.line} (${reportCell(item.mutantId)}) | ${reportCell(item.original)} | ${reportCell(item.mutated)} | ${item.rowIds.join(', ')} | 可能是多餘條件或死碼 |`)];
    fs.writeFileSync(path.join(directory, DESIGN_FINDINGS_MD), lines.join('\n') + '\n', 'utf8');
    return findings;
}
