import { localize } from '../i18n/core';
import { canRepairTestMethod, getBugFixerSystemPrompt, mergeBugFixReplacement } from '../roles/bugFixer';
import { getTestReviewerSystemPrompt, numberReviewLines, parseTestReviewDetailed, reviewableLineIds } from '../roles/testReviewer';
import { assessIsolatedProbeCode, runIsolatedProbe } from './modelProbeExecution';

export type RoleQualificationState = 'verified' | 'unverified' | 'not-run';

export interface RoleQualificationStatus {
    state: RoleQualificationState;
    reason: string;
    /** Codes and counts only; never retain model replies or generated source. */
    diagnostics?: RoleQualificationDiagnostics;
}

export interface RoleQualificationResponseShape {
    characters: number;
    pythonFenceCount: number;
    jsonObject: boolean;
    findingsCount?: number;
    legacyBlockingCount?: number;
    legacyQualityCount?: number;
}

export interface RoleQualificationDiagnostics {
    contractVersion: 'writer-probe-v8' | 'review-v7' | 'bug-fixer-probe-v8';
    reasonCode: string;
    reasonCodes: string[];
    failureKind: 'none' | 'contract' | 'execution' | 'unavailable';
    executionState: 'passed' | 'failed' | 'not-run' | 'unavailable';
    responseShape: RoleQualificationResponseShape;
}

/** Only structural counts of a public fixture response are diagnostic evidence. */
export function qualificationResponseShape(response: string | undefined): RoleQualificationResponseShape {
    const shape: RoleQualificationResponseShape = { characters: response?.length ?? 0,
        pythonFenceCount: (response?.match(/```(?:python|py)\b/gi) ?? []).length, jsonObject: false };
    try {
        const value: unknown = JSON.parse(response ?? '');
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            shape.jsonObject = true;
            const record = value as Record<string, unknown>;
            if (Array.isArray(record.findings)) { shape.findingsCount = record.findings.length; }
            if (Array.isArray(record.blocking)) { shape.legacyBlockingCount = record.blocking.length; }
            if (Array.isArray(record.quality)) { shape.legacyQualityCount = record.quality.length; }
        }
    } catch { /* No reply contents are copied into diagnostics. */ }
    return shape;
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

export type RoleQualificationRequester = (prompt: string, format: 'review-json' | 'text') => Promise<string | undefined>;

export const ROLE_QUALIFICATION_TEST_FILE = `import unittest
from fixture_module import increment
class Cases(unittest.TestCase):
    def test_increment(self):
        self.assertEqual(increment(1), 2)
`;

export const ROLE_QUALIFICATION_FAILURE =
    'FAIL: test_increment (TestRepair.test_increment)\nAssertionError: 2 != 3';

export const BUG_FIXER_QUALIFICATION_TEST_FILE = `import unittest
class TestRepair(unittest.TestCase):
    def test_increment(self):
        self.assertEqual(increment(1), 3)
    def test_keep(self):
        self.assertEqual(increment(-1), 0)
`;

export const REVIEWER_QUALIFICATION_PROMPT = `${getTestReviewerSystemPrompt()}
Review this exact TEST_FILE for a concrete demonstrated test problem. It is valid to return an empty findings array.
Every finding must contain test_line, reason, and action. Target binding: module. Do not write Python or modify the target implementation.
VALID_TEST_LINE_IDS: ${reviewableLineIds(ROLE_QUALIFICATION_TEST_FILE).join(', ')}
TEST_FILE:
${numberReviewLines(ROLE_QUALIFICATION_TEST_FILE)}`;

export const BUG_FIXER_QUALIFICATION_PROMPT = `${getBugFixerSystemPrompt()}
Repair only the named failing method test_increment in the supplied TEST_FILE. Keep the method name and return one method body.
Return one Python fence; do not add a class, target source, or unrelated test.
A safe runtime provides the real increment(value), implemented as return value + 1. Do not import or redefine it. Correct the expected numeric literal in the existing direct assertEqual call; preserve its increment(1) input and test_keep.
FAILURE:
${ROLE_QUALIFICATION_FAILURE}
TEST_FILE:
${BUG_FIXER_QUALIFICATION_TEST_FILE}`;

function status(state: RoleQualificationState, reason: string,
    diagnostics?: RoleQualificationDiagnostics): RoleQualificationStatus {
    return { state, reason, ...(diagnostics ? { diagnostics } : {}) };
}

export function assessReviewerQualification(response: string | undefined): RoleQualificationStatus {
    const parsed = parseTestReviewDetailed(response ?? '', ROLE_QUALIFICATION_TEST_FILE, true,
        { target: 'increment', methodKind: 'module' });
    const reasonCodes = parsed.review ? ['review-contract-verified'] : parsed.diagnostics;
    const diagnostics: RoleQualificationDiagnostics = { contractVersion: 'review-v7',
        reasonCode: reasonCodes[0], reasonCodes, failureKind: parsed.review ? 'none' : 'contract',
        executionState: 'not-run', responseShape: qualificationResponseShape(response) };
    return parsed.review
        ? status('verified', localize("Reviewer 已通過 review-v7 分類、行號引用與欄位契約。"), diagnostics)
        : status('unverified', localize("Reviewer 回覆未通過 JSON、原文引述或 reason/action 契約。"), diagnostics);
}

function bugFixerProbeCode(response: string | undefined): string | undefined {
    if (!response?.trim()) { return undefined; }
    const code = mergeBugFixReplacement(response, BUG_FIXER_QUALIFICATION_TEST_FILE, ROLE_QUALIFICATION_FAILURE);
    // Fixed qualification fixture: prove the requested literal edit before
    // executing. This intentionally does not interpret arbitrary repair code.
    if (!code || !assessIsolatedProbeCode(code).valid) { return undefined; }
    const normalize = (value: string) => value.split(/\r?\n/).filter(line => line.trim() && !/^\s*#/.test(line))
        .map(line => line.replace(/\s/g, '')).join('\n');
    const expected = BUG_FIXER_QUALIFICATION_TEST_FILE.replace('increment(1), 3', 'increment(1), 2');
    return normalize(code) === normalize(expected) ? code : undefined;
}

export function assessBugFixerQualification(response: string | undefined, executionPassed = false): RoleQualificationStatus {
    const diagnostic = (reasonCode: string, failureKind: RoleQualificationDiagnostics['failureKind'],
        executionState: RoleQualificationDiagnostics['executionState']): RoleQualificationDiagnostics => ({
            contractVersion: 'bug-fixer-probe-v8', reasonCode, reasonCodes: [reasonCode], failureKind,
            executionState, responseShape: qualificationResponseShape(response) });
    if (!response?.trim()) { return status('unverified', localize("Bug Fixer 沒有回傳 Python 單方法替換。"),
        diagnostic('bug-fixer-empty-response', 'contract', 'not-run')); }
    if (!canRepairTestMethod(BUG_FIXER_QUALIFICATION_TEST_FILE, ROLE_QUALIFICATION_FAILURE)) {
        return status('unverified', localize("資格 fixture 沒有可唯一定位的失敗方法。"),
            diagnostic('bug-fixer-fixture-unavailable', 'unavailable', 'not-run'));
    }
    if (!bugFixerProbeCode(response)) {
        return status('unverified', localize("Bug Fixer 未正確修正固定案例的預期值，或修改了輸入、斷言／方法範圍。"),
            diagnostic('bug-fixer-replacement-contract', 'contract', 'not-run'));
    }
    return executionPassed
        ? status('verified', localize("Bug Fixer 已修正固定案例的錯誤預期值，並在隔離 Python 中保留另一通過案例。"),
            diagnostic('bug-fixer-probe-passed', 'none', 'passed'))
        : status('unverified', localize("Bug Fixer 固定案例修正格式符合；尚未通過隔離執行。"),
            diagnostic('bug-fixer-execution-unavailable', 'unavailable', 'unavailable'));
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
    request: RoleQualificationRequester,
    executor: (code: string) => Promise<boolean> = runIsolatedProbe
): Promise<RoleQualificationProfile> {
    let reviewer: string | undefined;
    let bugFixer: string | undefined;
    let reviewerUnavailable = false;
    let bugFixerUnavailable = false;
    try { reviewer = await request(REVIEWER_QUALIFICATION_PROMPT, 'review-json'); } catch { reviewerUnavailable = true; }
    try { bugFixer = await request(BUG_FIXER_QUALIFICATION_PROMPT, 'text'); } catch { bugFixerUnavailable = true; }
    const profile = buildRoleQualificationProfile(writer, reviewer, bugFixer);
    for (const role of ['reviewer', 'bugFixer'] as const) {
        if (role === 'reviewer' ? reviewerUnavailable : bugFixerUnavailable) {
            profile[role].state = 'not-run';
            profile[role].diagnostics!.reasonCode = 'probe-request-unavailable';
            profile[role].diagnostics!.reasonCodes = ['probe-request-unavailable'];
            profile[role].diagnostics!.failureKind = 'unavailable';
        }
    }
    const code = bugFixerProbeCode(bugFixer);
    if (code) {
        try { profile.bugFixer = assessBugFixerQualification(bugFixer, await executor(code)); }
        catch { profile.bugFixer = status('not-run', localize("Bug Fixer 固定案例的隔離執行未完成。"),
            { ...profile.bugFixer.diagnostics!, reasonCode: 'probe-execution-unavailable',
                reasonCodes: ['probe-execution-unavailable'], failureKind: 'unavailable', executionState: 'unavailable' }); }
    }
    return profile;
}

export function formatRoleQualificationLog(profile: RoleQualificationProfile): string {
    return localize("角色資格：Writer={0}；Reviewer={1}；Bug Fixer={2}", profile.writer.state, profile.reviewer.state, profile.bugFixer.state);
}
