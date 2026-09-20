import { canRepairTestMethod, getBugFixerSystemPrompt, mergeBugFixReplacement } from '../roles/bugFixer';
import { getTestReviewerSystemPrompt, numberReviewLines, parseTestReviewDetailed, reviewableLineIds } from '../roles/testReviewer';

export type RoleQualificationState = 'verified' | 'unverified' | 'not-run';

export interface RoleQualificationStatus {
    state: RoleQualificationState;
    reason: string;
}

export interface RoleQualificationProfile {
    writer: RoleQualificationStatus;
    reviewer: RoleQualificationStatus;
    bugFixer: RoleQualificationStatus;
}

/** Old Writer probes never certify Reviewer or Bug Fixer contracts. */
export function qualifiedRole(role: keyof RoleQualificationProfile, profile: RoleQualificationProfile | undefined,
    currentVersion: boolean, legacyWriterReady?: boolean): boolean {
    if (!currentVersion) { return false; }
    return profile ? profile[role]?.state === 'verified' : role === 'writer' && legacyWriterReady === true;
}

export type RoleQualificationRequester = (prompt: string, format: 'json' | 'text') => Promise<string | undefined>;

export const ROLE_QUALIFICATION_TEST_FILE = `import unittest
from fixture_module import increment
class Cases(unittest.TestCase):
    def test_increment(self):
        self.assertEqual(increment(1), 2)
`;

export const ROLE_QUALIFICATION_FAILURE =
    'FAIL: test_increment (Cases.test_increment)\nAssertionError: expected 3';

export const REVIEWER_QUALIFICATION_PROMPT = `${getTestReviewerSystemPrompt()}
Review this exact TEST_FILE for a concrete demonstrated test problem. It is valid to return an empty findings array.
Every finding must contain test_line, reason, and action. Target binding: module. Do not write Python or modify the target implementation.
VALID_TEST_LINE_IDS: ${reviewableLineIds(ROLE_QUALIFICATION_TEST_FILE).join(', ')}
TEST_FILE:
${numberReviewLines(ROLE_QUALIFICATION_TEST_FILE)}`;

export const BUG_FIXER_QUALIFICATION_PROMPT = `${getBugFixerSystemPrompt()}
Repair only the named failing method test_increment in the supplied TEST_FILE. Keep the method name and return one method body.
Return one Python fence; do not add a class, target source, or unrelated test.
FAILURE:
${ROLE_QUALIFICATION_FAILURE}
TEST_FILE:
${ROLE_QUALIFICATION_TEST_FILE}`;

function status(state: RoleQualificationState, reason: string): RoleQualificationStatus {
    return { state, reason };
}

export function assessReviewerQualification(response: string | undefined): RoleQualificationStatus {
    if (!response?.trim()) { return status('unverified', 'Reviewer 沒有回傳 JSON。'); }
    const parsed = parseTestReviewDetailed(response, ROLE_QUALIFICATION_TEST_FILE, true,
        { target: 'increment', methodKind: 'module' }).review;
    return parsed
        ? status('verified', 'Reviewer 已通過 review-v7 分類、行號引用與欄位契約。')
        : status('unverified', 'Reviewer 回覆未通過 JSON、原文引述或 reason/action 契約。');
}

export function assessBugFixerQualification(response: string | undefined): RoleQualificationStatus {
    if (!response?.trim()) { return status('unverified', 'Bug Fixer 沒有回傳 Python 單方法替換。'); }
    if (!canRepairTestMethod(ROLE_QUALIFICATION_TEST_FILE, ROLE_QUALIFICATION_FAILURE)) {
        return status('unverified', '資格 fixture 沒有可唯一定位的失敗方法。');
    }
    const merged = mergeBugFixReplacement(response, ROLE_QUALIFICATION_TEST_FILE, ROLE_QUALIFICATION_FAILURE);
    return merged
        ? status('verified', 'Bug Fixer 已通過單一方法、名稱保留與完整測試合併契約。')
        : status('unverified', 'Bug Fixer 回覆未通過單一方法替換或 imports 契約。');
}

export function buildRoleQualificationProfile(
    writer: RoleQualificationStatus,
    reviewerResponse?: string,
    bugFixerResponse?: string
): RoleQualificationProfile {
    return {
        writer,
        reviewer: assessReviewerQualification(reviewerResponse),
        bugFixer: assessBugFixerQualification(bugFixerResponse)
    };
}

/** Run the two role-specific probes after the basic Writer probe. */
export async function runRoleQualificationProbes(
    writer: RoleQualificationStatus,
    request: RoleQualificationRequester
): Promise<RoleQualificationProfile> {
    let reviewer: string | undefined;
    let bugFixer: string | undefined;
    try { reviewer = await request(REVIEWER_QUALIFICATION_PROMPT, 'json'); } catch { reviewer = undefined; }
    try { bugFixer = await request(BUG_FIXER_QUALIFICATION_PROMPT, 'text'); } catch { bugFixer = undefined; }
    return buildRoleQualificationProfile(writer, reviewer, bugFixer);
}

export function formatRoleQualificationLog(profile: RoleQualificationProfile): string {
    return `角色資格：Writer=${profile.writer.state}；Reviewer=${profile.reviewer.state}；Bug Fixer=${profile.bugFixer.state}`;
}
