import type { ImportExceptionSummary, ImportIssue } from '../environment/importDiagnostics';
import { summarizeImportException } from '../environment/importDiagnostics';
import { localize } from '../i18n/core';

export interface BatchPreflightTarget { id: number; file: string; target: string }
export interface BatchPreflightRow {
    file: string;
    status: 'loaded' | 'blocked' | 'incomplete';
    stage?: string;
    issue?: ImportIssue;
    diagnostic?: ImportExceptionSummary;
}
export interface BatchPreflightBlockedTarget extends BatchPreflightTarget {
    reason: 'module-blocked' | 'not-checked' | 'diagnostic-incomplete';
    stage: string;
    environment: ImportIssue;
}
export interface BatchPreflightPartition {
    status: 'ready' | 'partial' | 'blocked' | 'invalid';
    runnableIds: number[];
    blocked: BatchPreflightBlockedTarget[];
    invalidReason?: 'cancelled' | 'identity-invalid' | 'not-observed' | 'invalid-targets';
}

/** Source identities stay relative to the one confirmed root; directories are not project boundaries. */
function sourceName(file: string): string | undefined {
    const normalized = file.replace(/\\/g, '/');
    return normalized && normalized.length <= 1000 && !/[:\u0000-\u001f\u007f]|^[\/]/.test(normalized)
        && normalized.split('/').every(part => part && part !== '.' && part !== '..') ? normalized : undefined;
}
const identity = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file;
const safeText = (text: string): string => summarizeImportException({ exception_type: 'PreflightSummary', message: text })!.message;

/** Retain only host diagnostic fields; provider output and arbitrary exception objects never enter the snapshot. */
export function safeBatchPreflightRows(rows: readonly BatchPreflightRow[]): BatchPreflightRow[] {
    return rows.flatMap(row => {
        const file = sourceName(row.file);
        if (!file) { return []; }
        const kinds: ImportIssue['kind'][] = ['import-side-effect', 'missing-dependency', 'dependency-api', 'module-resolution', 'other'];
        const issue = row.issue && kinds.includes(row.issue.kind) ? {
            kind: row.issue.kind, issue: safeText(row.issue.issue), advice: safeText(row.issue.advice),
            ...(row.issue.origin && sourceName(row.issue.origin.file) && Number.isSafeInteger(row.issue.origin.line) && row.issue.origin.line > 0
                ? { origin: { file: sourceName(row.issue.origin.file)!, line: row.issue.origin.line } } : {})
        } : undefined;
        const diagnostic = row.diagnostic ? summarizeImportException({ exception_type: row.diagnostic.exceptionType, message: row.diagnostic.message }) : undefined;
        return [{ file, status: ['loaded', 'blocked', 'incomplete'].includes(row.status) ? row.status : 'incomplete',
            ...(row.stage ? { stage: safeText(row.stage) } : {}), ...(issue ? { issue } : {}),
            ...(diagnostic ? { diagnostic: { ...diagnostic,
                ...(row.diagnostic?.reasonCode && ['timeout', 'process-failed', 'invalid-result'].includes(row.diagnostic.reasonCode)
                    ? { reasonCode: row.diagnostic.reasonCode } : {}),
                ...(row.diagnostic?.exitCode === null || Number.isSafeInteger(row.diagnostic?.exitCode) ? { exitCode: row.diagnostic?.exitCode } : {}),
                ...(row.diagnostic?.detailCode === 'missing-or-invalid-source-versions' ? { detailCode: row.diagnostic.detailCode } : {}) } } : {}) }];
    });
}

/** A real load of each source proves its import dependencies in this environment. No result is inferred from another source. */
export function partitionBatchPreflight(targets: readonly BatchPreflightTarget[], rows: readonly BatchPreflightRow[],
    options: { actualImports: boolean; identityValid: boolean; cancelled?: boolean }): BatchPreflightPartition {
    const invalid = (invalidReason: BatchPreflightPartition['invalidReason']): BatchPreflightPartition =>
        ({ status: 'invalid', runnableIds: [], blocked: [], invalidReason });
    if (options.cancelled) { return invalid('cancelled'); }
    if (!options.identityValid) { return invalid('identity-invalid'); }
    if (!options.actualImports) { return invalid('not-observed'); }
    const ids = new Set<number>();
    for (const target of targets) {
        if (!Number.isSafeInteger(target.id) || target.id < 0 || ids.has(target.id)
            || !sourceName(target.file) || !target.target.trim()) { return invalid('invalid-targets'); }
        ids.add(target.id);
    }
    const bySource = new Map<string, BatchPreflightRow[]>();
    for (const row of safeBatchPreflightRows(rows)) {
        const key = identity(row.file), entries = bySource.get(key) || [];
        entries.push(row); bySource.set(key, entries);
    }
    const runnableIds: number[] = [], blocked: BatchPreflightBlockedTarget[] = [];
    for (const target of targets) {
        const found = bySource.get(identity(sourceName(target.file)!));
        const row = found?.length === 1 ? found[0] : undefined;
        const incomplete = !!found && (!row || row.status === 'incomplete'
            || ['initialization-plan', 'module-preflight'].includes(row.stage || '') || !!row.diagnostic?.reasonCode
            || row.status === 'loaded' && !!(row.issue || row.diagnostic)
            || row.status === 'blocked' && !row.issue && !row.diagnostic);
        if (row?.status === 'loaded' && !incomplete) { runnableIds.push(target.id); continue; }
        const reason = !found ? 'not-checked' : incomplete ? 'diagnostic-incomplete' : 'module-blocked';
        const environment: ImportIssue = !incomplete && row?.issue ? row.issue : {
            kind: 'other', issue: reason === 'not-checked' ? 'preflight-not-checked' : 'preflight-diagnostic-incomplete',
            advice: localize('本次未取得完整模組診斷；請依原因碼檢查 Python 預檢程序後重新檢查。前次障礙只保留為歷史證據。')
        };
        blocked.push({ ...target, file: sourceName(target.file)!, reason,
            stage: row?.stage || 'module-preflight', environment });
    }
    return { status: !blocked.length ? 'ready' : runnableIds.length ? 'partial' : 'blocked', runnableIds, blocked };
}
