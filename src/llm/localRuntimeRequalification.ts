import { mergeBugFixReplacement } from '../roles/bugFixer';
import {
    isLocalRuntimeQualification, LOCAL_RUNTIME_QUALIFICATION_VERSION,
    ModelQualificationProfile, QUALIFICATION_VERSION
} from './modelQualification';
import { runIsolatedProbe, verifyRunnableTestGenerationProbe } from './modelProbeExecution';
import {
    assessBugFixerQualification, assessReviewerQualification,
    BUG_FIXER_QUALIFICATION_PROMPT, BUG_FIXER_QUALIFICATION_TEST_FILE,
    REVIEWER_QUALIFICATION_PROMPT, ROLE_QUALIFICATION_FAILURE, RoleQualificationProfile
} from './roleQualification';
import { PLAIN_TEST_GENERATION_PROBE_PROMPT } from './testGenerationQualification';

export type LocalRequalificationRole = 'writer' | 'reviewer' | 'bug-fixer';

export interface LocalRuntimeRequalificationOptions {
    /** The caller must send this same validated num_ctx for every request. */
    numCtx: number;
    /** Only a previously verified Bug Fixer needs to retain that role at the new capacity. */
    includeBugFixer?: boolean;
    /** The caller owns transport, cancellation, the shared deadline and target accounting. */
    request: (role: LocalRequalificationRole, system: string, prompt: string,
        format: 'json' | 'text') => Promise<string | undefined>;
    executor?: (code: string) => Promise<boolean>;
}

export interface LocalRuntimeRequalificationResult extends ModelQualificationProfile {
    qualificationRuntime: { version: typeof LOCAL_RUNTIME_QUALIFICATION_VERSION; numCtx: number };
    qualificationVersion: typeof QUALIFICATION_VERSION;
    roleQualification: RoleQualificationProfile;
    testGenerationReady: boolean;
    testGenerationMode: 'plain';
    testGenerationReason: string;
}

/**
 * A context change invalidates all old role evidence. Re-run the existing public
 * fixtures without network or persistence here, and expose only safe assessments.
 * Request/executor exceptions deliberately propagate so cancellation or exhausted
 * target budgets cannot be mistaken for an invalid model response.
 */
export async function requalifyLocalRuntime(
    options: LocalRuntimeRequalificationOptions
): Promise<LocalRuntimeRequalificationResult> {
    const qualificationRuntime = { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: options.numCtx };
    if (!isLocalRuntimeQualification(qualificationRuntime)) { throw new Error('invalid-runtime-context'); }
    const executor = options.executor ?? runIsolatedProbe;
    const writerResponse = await options.request('writer', '', PLAIN_TEST_GENERATION_PROBE_PROMPT, 'text');
    const writerAssessment = await verifyRunnableTestGenerationProbe({ response: writerResponse }, executor);
    const roles: RoleQualificationProfile = {
        writer: { state: writerAssessment.capability, reason: writerAssessment.reason },
        reviewer: assessReviewerQualification(await options.request('reviewer', '', REVIEWER_QUALIFICATION_PROMPT, 'json')),
        bugFixer: { state: 'not-run', reason: 'Bug Fixer has no verified probe at this runtime context.' }
    };
    if (options.includeBugFixer) {
        const response = await options.request('bug-fixer', '', BUG_FIXER_QUALIFICATION_PROMPT, 'text');
        roles.bugFixer = assessBugFixerQualification(response);
        // The shared assessor proves the exact fixed edit and preserved test before execution.
        if (assessBugFixerQualification(response, true).state === 'verified' && response) {
            const code = mergeBugFixReplacement(response, BUG_FIXER_QUALIFICATION_TEST_FILE, ROLE_QUALIFICATION_FAILURE);
            if (code) { roles.bugFixer = assessBugFixerQualification(response, await executor(code)); }
        }
    }
    return {
        qualificationRuntime,
        qualificationVersion: QUALIFICATION_VERSION,
        roleQualification: roles,
        testGenerationReady: roles.writer.state === 'verified',
        testGenerationMode: 'plain',
        testGenerationReason: roles.writer.reason
    };
}
