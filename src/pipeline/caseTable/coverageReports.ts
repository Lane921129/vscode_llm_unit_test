import { REQUIREMENTS_COVERAGE_JSON, REQUIREMENTS_COVERAGE_MD } from './artifactNames';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaseRow } from './caseTable';
import { RequirementEntry } from './requirements';

export interface RequirementsCoverage {
    version: 'requirements-coverage-v1';
    target: string;
    hasRequirementsFile: boolean;
    total: number;
    covered: number;
    rate: number | null;
    requirements: Array<RequirementEntry & {
        rows: Array<{ id: string; status: string; oracleStatus: string | null }>;
        hasPassingRow: boolean;
    }>;
}

export const reportCell = (value: string): string => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function writeRequirementsCoverage(directory: string, target: string, entries: RequirementEntry[],
    rows: CaseRow[], hasRequirementsFile: boolean): RequirementsCoverage {
    const requirements = entries.map(entry => {
        const matching = rows.filter(row => row.requirementId === entry.id);
        return { ...entry, rows: matching.map(row => ({ id: row.id,
            status: row.oracleStatus === 'spec-mismatch' ? 'spec-mismatch' : row.status,
            oracleStatus: row.oracleStatus ?? null })),
        hasPassingRow: matching.some(row => row.status === 'test-passed' && row.oracleStatus !== 'spec-mismatch') };
    });
    const covered = requirements.filter(entry => entry.hasPassingRow).length;
    const report: RequirementsCoverage = { version: 'requirements-coverage-v1', target, hasRequirementsFile,
        total: requirements.length, covered, rate: requirements.length ? covered / requirements.length : null, requirements };
    fs.writeFileSync(path.join(directory, REQUIREMENTS_COVERAGE_JSON), JSON.stringify(report, null, 2) + '\n', 'utf8');
    const lines = ['# 需求涵蓋表 / Requirements coverage', '',
        hasRequirementsFile ? `需求涵蓋率：${covered}/${report.total}` : '無需求檔 / No requirements file', '',
        '| 需求 | 說明 | 案例列與狀態 | 至少一列通過 |', '| --- | --- | --- | --- |',
        ...requirements.map(entry => `| ${entry.id} | ${reportCell(entry.text)} | ${entry.rows.map(row => `${row.id}: ${row.status}`).join(', ') || '—'} | ${entry.hasPassingRow ? 'yes' : 'no'} |`)];
    fs.writeFileSync(path.join(directory, REQUIREMENTS_COVERAGE_MD), lines.join('\n') + '\n', 'utf8');
    return report;
}
