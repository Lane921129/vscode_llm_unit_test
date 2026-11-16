import { CASE_TABLE_REVIEW_JSON } from './artifactNames';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaseRow, nextCaseRowIndex } from './caseTable';
import { RequirementEntry } from './requirements';
import { getCaseTableReviewPrompt, getCaseTableReviewCorrectionPrompt, parseCaseTableReview, CaseTableReviewAction } from '../../roles/caseTableReviewer';
import { reportCell } from './coverageReports';

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
    const parsed = parseCaseTableReview(await input.ask(prompt.system, prompt.user, { role: 'case-table-review' }), input.rows, ids);
    const actions: CaseTableReviewAction[] = [...parsed.actions];
    const rejected = [...parsed.rejected];
    for (const item of parsed.rejected) {
        if (item.reason === 'review-limit' || actions.length >= 3) { continue; }
        const correction = getCaseTableReviewCorrectionPrompt(promptInput, item.raw, item.reason);
        const result = parseCaseTableReview(await input.ask(correction.system, correction.user, { role: 'case-table-review-correction' }),
            input.rows, ids, nextCaseRowIndex([...input.rows, ...actions.flatMap(action => action.row ? [action.row] : [])]));
        if (result.actions.length) { actions.push(result.actions[0]); }
        else { rejected.push(...result.rejected); }
    }
    const added = await input.validate(actions.flatMap(action => action.row ? [action.row] : []));
    const flags = actions.flatMap(action => action.flag ? [action.flag] : []);
    const rows = [...input.rows, ...added].map(row => {
        const reasons = flags.filter(flag => flag.id === row.id).map(flag => flag.reason);
        return reasons.length ? { ...row, reviewFlags: [...new Set([...(row.reviewFlags ?? []), ...reasons])] } : row;
    });
    fs.writeFileSync(path.join(input.directory, CASE_TABLE_REVIEW_JSON), JSON.stringify({ version: 'case-table-review-v1',
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
