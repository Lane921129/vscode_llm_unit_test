import { mergeBugFixReplacement } from '../roles/bugFixer';
import { spawn } from 'child_process';
import { MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS } from './connectionTimeout';
import {
    isLocalRuntimeQualification, LOCAL_RUNTIME_QUALIFICATION_VERSION,
    ModelQualificationProfile, QUALIFICATION_VERSION
} from './modelQualification';
import { assessIsolatedProbeCode, verifyRunnableTestGenerationProbe } from './modelProbeExecution';
import {
    assessBugFixerQualification, assessReviewerQualification,
    BUG_FIXER_QUALIFICATION_PROMPT, BUG_FIXER_QUALIFICATION_TEST_FILE,
    qualificationResponseShape, REVIEWER_QUALIFICATION_PROMPT, ROLE_QUALIFICATION_FAILURE,
    RoleQualificationDiagnostics, RoleQualificationProfile, RoleQualificationStatus
} from './roleQualification';
import { assessTestGenerationProbe, extractQualificationProbeCode,
    PLAIN_TEST_GENERATION_PROBE_PROMPT } from './testGenerationQualification';

export type LocalRequalificationRole = 'writer' | 'reviewer' | 'bug-fixer';

export interface LocalRuntimeRequalificationOptions {
    /** The caller must send this same validated num_ctx for every request. */
    numCtx: number;
    /** Only a previously verified Bug Fixer needs to retain that role at the new capacity. */
    includeBugFixer?: boolean;
    /** The caller owns transport, cancellation, the shared deadline and target accounting. */
    request: (role: LocalRequalificationRole, system: string, prompt: string,
        format: 'review-json' | 'text') => Promise<string | undefined>;
    executor?: (code: string) => Promise<boolean | RuntimeQualificationProbeExecution>;
}

export interface RuntimeQualificationProbeExecution {
    state: 'passed' | 'failed' | 'unavailable';
    reasonCode: 'probe-passed' | 'probe-execution-failed' | 'probe-timeout'
        | 'probe-environment-unavailable' | 'probe-execution-unavailable';
}

/** An original shared deadline can shorten, but never extend, the 30-second probe allowance. */
export function runtimeQualificationExecutionBudget(deadlineAt: number, now = Date.now()): number {
    if (Number.isNaN(deadlineAt) || Number.isNaN(now)) { return 0; }
    return Math.max(0, Math.min(MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS, Math.floor(deadlineAt - now)));
}

const RUNTIME_PROBE_RUNNER = [
    'import sys, types, unittest', 'code = sys.stdin.read()',
    'module = types.ModuleType("llm_unit_probe")', 'module.__file__ = "<llm_unit_probe>"',
    'fixture = "def increment(value):\\n    return value + 1\\n"',
    'exec(compile(fixture, module.__file__, "exec"), module.__dict__)',
    'exec(compile(code, module.__file__, "exec"), module.__dict__)',
    'suite = unittest.defaultTestLoader.loadTestsFromModule(module)',
    'result = unittest.TextTestRunner(verbosity=0).run(suite)',
    'raise SystemExit(0 if result.wasSuccessful() and result.testsRun > 0 else 1)'
].join('; ');

/** Preserve execution provenance instead of treating a timeout as model inability. */
export function runLocalRuntimeQualificationProbe(code: string,
    timeoutMs = MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS, pythonExecutable = 'python'
): Promise<RuntimeQualificationProbeExecution> {
    const allowance = Math.min(MODEL_QUALIFICATION_EXECUTION_TIMEOUT_MS, Math.floor(timeoutMs));
    if (!Number.isFinite(allowance) || allowance <= 0) {
        return Promise.resolve({ state: 'unavailable', reasonCode: 'probe-timeout' });
    }
    if (!assessIsolatedProbeCode(code).valid) {
        return Promise.resolve({ state: 'failed', reasonCode: 'probe-execution-failed' });
    }
    return new Promise(resolve => {
        const process = spawn(pythonExecutable, ['-I', '-c', RUNTIME_PROBE_RUNNER],
            { stdio: ['pipe', 'ignore', 'ignore'], shell: false, windowsHide: true });
        let settled = false;
        const finish = (outcome: RuntimeQualificationProbeExecution) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
        };
        const timer = setTimeout(() => {
            process.kill();
            finish({ state: 'unavailable', reasonCode: 'probe-timeout' });
        }, allowance);
        process.once('error', () => finish({ state: 'unavailable', reasonCode: 'probe-environment-unavailable' }));
        process.once('close', exitCode => finish(exitCode === 0
            ? { state: 'passed', reasonCode: 'probe-passed' }
            : typeof exitCode === 'number'
                ? { state: 'failed', reasonCode: 'probe-execution-failed' }
                : { state: 'unavailable', reasonCode: 'probe-execution-unavailable' }));
        process.stdin.on('error', () => finish({ state: 'unavailable', reasonCode: 'probe-environment-unavailable' }));
        process.stdin.end(code);
    });
}

function applyExecution(status: RoleQualificationStatus, execution: boolean | RuntimeQualificationProbeExecution): void {
    const outcome: RuntimeQualificationProbeExecution = typeof execution === 'boolean'
        ? execution ? { state: 'passed', reasonCode: 'probe-passed' }
            : { state: 'unavailable', reasonCode: 'probe-execution-unavailable' } : execution;
    status.state = outcome.state === 'passed' ? 'verified' : outcome.state === 'unavailable' ? 'not-run' : 'unverified';
    if (outcome.state === 'unavailable') {
        status.reason = 'Qualification execution was unavailable; model capability was not determined.';
    }
    status.diagnostics = { ...status.diagnostics!, reasonCode: outcome.reasonCode, reasonCodes: [outcome.reasonCode],
        failureKind: outcome.state === 'passed' ? 'none' : outcome.state === 'failed' ? 'execution' : 'unavailable',
        executionState: outcome.state };
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
    const executor = options.executor ?? runLocalRuntimeQualificationProbe;
    const writerResponse = await options.request('writer', '', PLAIN_TEST_GENERATION_PROBE_PROMPT, 'text');
    let writerExecution: boolean | RuntimeQualificationProbeExecution | undefined;
    const writerAssessment = await verifyRunnableTestGenerationProbe({ response: writerResponse }, async code => {
        writerExecution = await executor(code);
        return typeof writerExecution === 'boolean' ? writerExecution : writerExecution.state === 'passed';
    });
    const writerContract = assessTestGenerationProbe({ response: writerResponse });
    const writerCode = extractQualificationProbeCode(writerResponse ?? '');
    const writerCodeSafe = writerContract.capability === 'verified' && assessIsolatedProbeCode(writerCode).valid;
    const writerReasonCode = writerContract.capability !== 'verified' ? 'writer-generation-contract'
        : !writerCodeSafe ? 'writer-probe-safety' : 'writer-probe-execution-unavailable';
    const writerDiagnostics: RoleQualificationDiagnostics = { contractVersion: 'writer-probe-v8',
        reasonCode: writerReasonCode, reasonCodes: [writerReasonCode],
        failureKind: writerCodeSafe ? 'unavailable' : 'contract', executionState: writerCodeSafe ? 'unavailable' : 'not-run',
        responseShape: qualificationResponseShape(writerResponse) };
    const roles: RoleQualificationProfile = {
        writer: { state: writerAssessment.capability, reason: writerAssessment.reason, diagnostics: writerDiagnostics },
        reviewer: assessReviewerQualification(await options.request('reviewer', '', REVIEWER_QUALIFICATION_PROMPT, 'review-json')),
        bugFixer: { state: 'not-run', reason: 'Bug Fixer has no verified probe at this runtime context.' }
    };
    if (writerExecution !== undefined) { applyExecution(roles.writer, writerExecution); }
    if (options.includeBugFixer) {
        const response = await options.request('bug-fixer', '', BUG_FIXER_QUALIFICATION_PROMPT, 'text');
        roles.bugFixer = assessBugFixerQualification(response);
        // The shared assessor proves the exact fixed edit and preserved test before execution.
        if (assessBugFixerQualification(response, true).state === 'verified' && response) {
            const code = mergeBugFixReplacement(response, BUG_FIXER_QUALIFICATION_TEST_FILE, ROLE_QUALIFICATION_FAILURE);
            if (code) {
                const execution = await executor(code);
                roles.bugFixer = assessBugFixerQualification(response,
                    typeof execution === 'boolean' ? execution : execution.state === 'passed');
                applyExecution(roles.bugFixer, execution);
            }
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
