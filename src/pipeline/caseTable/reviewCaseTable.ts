import { CASE_TABLE_REVIEW_JSON } from './artifactNames';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaseRow, nextCaseRowIndex } from './caseTable';
import { RequirementEntry } from './requirements';
import { getCaseTableReviewPrompt, getCaseTableReviewCorrectionPrompt, parseCaseTableReview, CaseTableReviewAction } from '../../roles/caseTableReviewer';
import { reportCell } from './coverageReports';
import { AnalysisStageError } from '../../utils/executionFailureCategory';
import { isExecutionCancelled } from '../executionContext';

/** The review is optional: a failed model answer (e.g. output-token-limit, model API error) leaves the
 * table as it was and only blocks quality-passed. Cancellation, budget and every non-model failure still propagate. */
function reviewRequestFailure(error: unknown): string | undefined {
    if (isExecutionCancelled() || !(error instanceof AnalysisStageError)) { return undefined; }
    if (error.category !== 'model-api' && error.category !== 'model-format' && error.category !== 'timeout') { return undefined; }
    const reasonCode = (error.diagnostic as { reasonCode?: unknown } | undefined)?.reasonCode;
    return typeof reasonCode === 'string' && reasonCode ? reasonCode : error.category;
}

export async function reviewCaseTable(input: {
    directory: string; rows: CaseRow[]; source: string; requirements: RequirementEntry[];
    ask: (system: string, user: string, options: { role: 'case-table-review' | 'case-table-review-correction' }) => Promise<string>;
    validate: (rows: CaseRow[]) => Promise<CaseRow[]>;
}): Promise<CaseRow[]> {
    const promptInput = { source: input.source, requirements: input.requirements,
        table: ['| id | scenario | category | args | kwargs | mocks | requirement | status |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |',
            ...input.rows.map(row => `| ${row.id} | ${reportCell(row.scenario)} | ${row.category} | ${'args' in row.call ? row.call.args : row.call.needsSetup} | ${'kwargs' in row.call ? row.call.kwargs : ''} | ${JSON.stringify(row.mocks)} | ${row.requirementId ?? ''} | ${row.status} |`)].join('\n') };
    const prompt = getCaseTableReviewPrompt(promptInput);
    const ids = input.requirements.map(item => item.id);
    let reply: string;
    try { reply = await input.ask(prompt.system, prompt.user, { role: 'case-table-review' }); } catch (error) {
        const failure = reviewRequestFailure(error);
        if (!failure) { throw error; }
        fs.writeFileSync(path.join(input.directory, CASE_TABLE_REVIEW_JSON), JSON.stringify({ version: 'case-table-review-v1', completed: false,
            failure, addedRowIds: [], flags: [], rejected: [] }, null, 2) + '\n', 'utf8');
        return input.rows;
    }
    const parsed = parseCaseTableReview(reply, input.rows, ids);
    const actions: CaseTableReviewAction[] = [...parsed.actions];
    const rejected = [...parsed.rejected];
    let unresolved = 0;
    for (const item of parsed.rejected) {
        if (item.reason === 'review-limit' || actions.length >= 3) { unresolved++; continue; }
        const correction = getCaseTableReviewCorrectionPrompt(promptInput, item.raw, item.reason);
        let correctionReply: string;
        try { correctionReply = await input.ask(correction.system, correction.user, { role: 'case-table-review-correction' }); } catch (error) {
            if (!reviewRequestFailure(error)) { throw error; }
            unresolved++;
            continue;
        }
        const result = parseCaseTableReview(correctionReply,
            input.rows, ids, nextCaseRowIndex([...input.rows, ...actions.flatMap(action => action.row ? [action.row] : [])]));
        if (result.actions.length) { actions.push(result.actions[0]); }
        else { rejected.push(...result.rejected); }
        if (result.actions.length !== 1 || result.rejected.length) { unresolved++; }
    }
    const added = await input.validate(actions.flatMap(action => action.row ? [action.row] : []));
    const flags = actions.flatMap(action => action.flag ? [action.flag] : []);
    const rows = [...input.rows, ...added].map(row => {
        const reasons = flags.filter(flag => flag.id === row.id).map(flag => flag.reason);
        return reasons.length ? { ...row, reviewFlags: [...new Set([...(row.reviewFlags ?? []), ...reasons])] } : row;
    });
    fs.writeFileSync(path.join(input.directory, CASE_TABLE_REVIEW_JSON), JSON.stringify({ version: 'case-table-review-v1', completed: unresolved === 0,
        addedRowIds: added.map(row => row.id), flags, rejected }, null, 2) + '\n', 'utf8');
    return rows;
}

export function appendCaseTableReviewReport(directory: string, rows: CaseRow[]): void {
    const flagged = rows.filter(row => row.reviewFlags?.length);
    const lines = ['\n## 案例表審查 / Case table review', '',
        `${flagged.length} rows have unresolved review flags (recorded for human review).`, '',
        ...flagged.map(row => `- ${row.id}: ${row.reviewFlags!.map(reportCell).join('; ')}`), ''];
    fs.appendFileSync(path.join(directory, 'final_report.md'), lines.join('\n'), 'utf8');
}
