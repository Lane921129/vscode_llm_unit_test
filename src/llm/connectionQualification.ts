import { localize } from '../i18n/core';
import { QUALIFICATION_VERSION, LOCAL_RUNTIME_QUALIFICATION_VERSION } from './modelQualification';
import { assessIsolatedProbeCode } from './modelProbeExecution';
import { assessTestGenerationProbe, extractQualificationProbeCode, PLAIN_TEST_GENERATION_PROBE_PROMPT } from './testGenerationQualification';
import { assessReviewerQualification, assessBugFixerQualification, REVIEWER_QUALIFICATION_PROMPT,
    BUG_FIXER_QUALIFICATION_PROMPT, BUG_FIXER_QUALIFICATION_TEST_FILE, ROLE_QUALIFICATION_FAILURE,
    RoleQualificationProfile, RoleQualificationStatus, qualificationResponseShape } from './roleQualification';
import { mergeBugFixReplacement } from '../roles/bugFixer';
import { LocalRuntimeRequalificationResult, RuntimeQualificationProbeExecution } from './localRuntimeRequalification';
import { AnalysisStageError } from '../utils/executionFailureCategory';

export type ProbeRole = 'writer' | 'reviewer' | 'bugFixer';
export const CONNECTION_PROBE_OUTPUT_TOKEN_LIMIT = 1024;
export type ProbeFailure = 'timeout' | 'cancelled' | 'http' | 'output-limit' | 'response-format' | 'transport' | 'execution-unavailable';
export class QualificationRequestError extends Error {
    constructor(readonly reasonCode: ProbeFailure, readonly httpStatus?: number) { super('Qualification request unavailable: ' + reasonCode); }
}
export interface ConnectionProbeEvent {
    role: ProbeRole; status: 'requested' | 'completed' | 'unavailable'; timeoutMs: number;
    elapsedMs: number; reasonCode?: string; reason?: string; httpStatus?: number; roleState?: RoleQualificationStatus['state'];
    contextTokens?: number; outputTokenLimit?: number;
}
export function unprobedLocalQualification(numCtx: number): LocalRuntimeRequalificationResult {
    if (!Number.isSafeInteger(numCtx) || numCtx <= 0) { throw new TypeError('Invalid runtime context'); }
    const pending = (): RoleQualificationStatus => ({ state: 'not-run', reason: localize('尚未執行事先角色資格測試。') });
    return { qualificationVersion: QUALIFICATION_VERSION,
        qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx },
        testGenerationReady: false, testGenerationMode: 'plain', testGenerationReason: pending().reason,
        roleQualification: { writer: pending(), reviewer: pending(), bugFixer: pending() } };
}
const contractVersion = (role: ProbeRole) => role === 'reviewer' ? 'review-v7' as const
    : role === 'writer' ? 'writer-probe-v8' as const : 'bug-fixer-probe-v8' as const;
function unavailable(reason: ProbeFailure, role: ProbeRole): RoleQualificationStatus {
    return { state: 'not-run', reason: localize('角色探針未完成：{0}；模型能力尚未判定。', reason),
        diagnostics: { contractVersion: contractVersion(role), reasonCode: reason, reasonCodes: [reason],
            failureKind: 'unavailable', executionState: 'not-run', responseShape: qualificationResponseShape(undefined) } };
}
/** Stop at the first unavailable or failed role; roles not reached stay not-run.
 * Each successful role still requires its own contract and execution evidence. */
export async function qualifyLocalConnection(options: {
    numCtx: number; timeoutMs: number;
    request: (role: ProbeRole, prompt: string, format: 'text' | 'review-json') => Promise<string | undefined>;
    execute: (code: string) => Promise<RuntimeQualificationProbeExecution>;
    onEvent?: (event: ConnectionProbeEvent) => void;
}): Promise<LocalRuntimeRequalificationResult> {
    const result = unprobedLocalQualification(options.numCtx);
    const roles: RoleQualificationProfile = result.roleQualification;
    const prompts = { writer: PLAIN_TEST_GENERATION_PROBE_PROMPT, reviewer: REVIEWER_QUALIFICATION_PROMPT,
        bugFixer: BUG_FIXER_QUALIFICATION_PROMPT };
    for (const role of ['writer', 'reviewer', 'bugFixer'] as const) {
        const started = Date.now();
        options.onEvent?.({ role, status: 'requested', timeoutMs: options.timeoutMs, elapsedMs: 0,
            contextTokens: options.numCtx, outputTokenLimit: CONNECTION_PROBE_OUTPUT_TOKEN_LIMIT });
        try {
            const response = await options.request(role, prompts[role], role === 'reviewer' ? 'review-json' : 'text');
            let code: string | undefined;
            if (role === 'writer') {
                const assessment = assessTestGenerationProbe({ response });
                roles.writer = { state: assessment.capability, reason: assessment.reason,
                    diagnostics: { contractVersion: 'writer-probe-v8', reasonCode: 'writer-generation-contract',
                        reasonCodes: ['writer-generation-contract'], failureKind: 'contract', executionState: 'not-run',
                        responseShape: qualificationResponseShape(response) } };
                if (assessment.capability === 'verified') {
                    code = extractQualificationProbeCode(response ?? '');
                    if (!assessIsolatedProbeCode(code).valid) {
                        code = undefined;
                        roles.writer = { state: 'unverified', reason: localize('Writer 固定探針未通過安全契約。') };
                    }
                }
            } else if (role === 'reviewer') { roles.reviewer = assessReviewerQualification(response); }
            else {
                roles.bugFixer = assessBugFixerQualification(response);
                if (response && assessBugFixerQualification(response, true).state === 'verified') {
                    code = mergeBugFixReplacement(response, BUG_FIXER_QUALIFICATION_TEST_FILE, ROLE_QUALIFICATION_FAILURE) || undefined;
                }
            }
            if (code) {
                const execution = await options.execute(code);
                const current = roles[role];
                current.state = execution.state === 'passed' ? 'verified' : execution.state === 'failed' ? 'unverified' : 'not-run';
                current.reason = execution.state === 'passed' ? localize('固定角色探針已通過隔離執行。')
                    : localize('固定角色探針執行結果：{0}。', execution.reasonCode);
                current.diagnostics = { contractVersion: contractVersion(role), reasonCode: execution.reasonCode,
                    reasonCodes: [execution.reasonCode], failureKind: execution.state === 'passed' ? 'none'
                        : execution.state === 'failed' ? 'execution' : 'unavailable', executionState: execution.state,
                    responseShape: qualificationResponseShape(response) };
                if (execution.state === 'unavailable') {
                    options.onEvent?.({ role, status: 'unavailable', timeoutMs: options.timeoutMs,
                        elapsedMs: Date.now() - started, reasonCode: 'execution-unavailable', roleState: current.state });
                    break;
                }
            }
            options.onEvent?.({ role, status: 'completed', timeoutMs: options.timeoutMs,
                elapsedMs: Date.now() - started, roleState: roles[role].state,
                reasonCode: roles[role].diagnostics?.reasonCode, reason: roles[role].reason });
            if (roles[role].state !== 'verified') { break; }
        } catch (error) {
            const reason = error instanceof QualificationRequestError ? error.reasonCode
                : error instanceof AnalysisStageError && error.category === 'model-format' ? 'response-format' : 'transport';
            roles[role] = unavailable(reason, role);
            options.onEvent?.({ role, status: 'unavailable', timeoutMs: options.timeoutMs,
                elapsedMs: Date.now() - started, reasonCode: reason,
                ...(error instanceof QualificationRequestError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
            break;
        }
    }
    result.testGenerationReady = roles.writer.state === 'verified';
    result.testGenerationReason = roles.writer.reason;
    return result;
}
