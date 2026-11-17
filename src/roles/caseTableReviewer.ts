import { CaseRow, nextCaseRowIndex } from '../pipeline/caseTable/caseTable';
import { RequirementEntry } from '../pipeline/caseTable/requirements';
import { parseCaseRows } from './semanticAnalyzer';

export interface CaseTableReviewInput { table: string; source: string; requirements: RequirementEntry[] }
export interface CaseTableReviewAction { row?: CaseRow; flag?: { id: string; reason: string } }
const EXAMPLE = '{"action":"add","scenario":"lower boundary","category":"boundary","args":"(0,)","kwargs":"{}","mocks":"","requirement":""}';
const FORMAT = 'Return at most 3 JSON lines. To add an input row, use action="add" with scenario, category, args, kwargs, mocks and requirement. '
    + 'To flag an existing row, use only action="flag", id and reason. Do not write expected values or test code. '
    + 'Return no lines when there are no suggestions.\nExample:\n' + EXAMPLE + '\nOutput only the JSON lines, with no other text.';

export function getCaseTableReviewPrompt(input: CaseTableReviewInput) {
    return { system: 'Review the input scenarios in a Python case table. Suggest missing inputs or flag a questionable row. '
        + 'A flag is a request for human review, not an execution verdict.',
    user: `Source:\n${input.source}\n\nRequirements:\n${input.requirements.map(item => `${item.id}: ${item.text}`).join('\n') || '(none)'}\n\nCase table:\n${input.table}\n\n${FORMAT}` };
}

export function getCaseTableReviewCorrectionPrompt(input: CaseTableReviewInput, line: string, reason: string) {
    const prompt = getCaseTableReviewPrompt(input);
    return { system: 'Correct only the malformed case-table review line. Keep its intended input suggestion or row flag.',
        user: prompt.user.replace(FORMAT, `Malformed line:\n${line}\nProblem: ${reason}\n\n${FORMAT}`) };
}

export function parseCaseTableReview(raw: string, existing: CaseRow[], requirementIds: string[], firstIndex = nextCaseRowIndex(existing)) {
    const actions: CaseTableReviewAction[] = [];
    const rejected: Array<{ line: number; raw: string; reason: string }> = [];
    let next = firstIndex;
    raw.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) { return; }
        if (actions.length >= 3) { rejected.push({ line: index + 1, raw: line, reason: 'review-limit' }); return; }
        let value: any;
        try { value = JSON.parse(line); } catch { rejected.push({ line: index + 1, raw: line, reason: 'invalid-json' }); return; }
        if (value?.action === 'flag' && Object.keys(value).every(key => ['action', 'id', 'reason'].includes(key))
            && existing.some(row => row.id === value.id) && typeof value.reason === 'string' && value.reason.trim()) {
            actions.push({ flag: { id: value.id, reason: value.reason.trim() } }); return;
        }
        if (value?.action === 'add') {
            const { action: _action, ...fields } = value;
            const parsed = parseCaseRows(JSON.stringify(fields), { origin: 'reviewer', requirementIds, firstIndex: next, limit: 1 });
            if (parsed.rows.length) { actions.push({ row: parsed.rows[0] }); next++; return; }
        }
        rejected.push({ line: index + 1, raw: line, reason: 'invalid-review-line' });
    });
    return { actions, rejected };
}
