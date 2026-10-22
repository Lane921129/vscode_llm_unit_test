import { createHash } from 'crypto';
import { LocalRuntimeRequalificationResult } from './localRuntimeRequalification';
import { RoleQualificationProfile, RoleQualificationStatus } from './roleQualification';
import { LOCAL_RUNTIME_QUALIFICATION_VERSION } from './modelQualification';

/** All identities are bound by the caller to the current batch's verified runtime. */
export interface RuntimeQualificationIdentity {
    /** A digest of the exact provider endpoint; never an API key or URL containing credentials. */
    endpointKey: string;
    modelName: string;
    numCtx: number;
    qualificationVersion: string;
    /** Selected interpreter + interpreter/environment fingerprint, not just 'python'. */
    pythonIdentity: string;
    /** Verified project/source/import-fixture scope fingerprint for this batch. */
    scopeIdentity: string;
}

function identityKey(identity: RuntimeQualificationIdentity): string | undefined {
    if (!Number.isSafeInteger(identity.numCtx) || identity.numCtx <= 0
        || [identity.endpointKey, identity.modelName, identity.qualificationVersion,
            identity.pythonIdentity, identity.scopeIdentity].some(value => typeof value !== 'string' || !value.trim())) {
        return undefined;
    }
    // No normalization can accidentally combine different endpoints or models.
    return createHash('sha256').update(JSON.stringify([identity.endpointKey, identity.modelName, identity.numCtx,
        identity.qualificationVersion, identity.pythonIdentity, identity.scopeIdentity])).digest('hex');
}

function completedEvidence(status: RoleQualificationStatus): boolean {
    if (status.state === 'verified') { return status.diagnostics?.failureKind !== 'unavailable'; }
    return status.state === 'unverified'
        && (status.diagnostics?.failureKind === 'contract'
            || status.diagnostics?.failureKind === 'execution' && status.diagnostics.executionState === 'failed');
}

/** Pick the public assessment fields rather than cloning arbitrary profile extensions. */
function copyResult(result: LocalRuntimeRequalificationResult): LocalRuntimeRequalificationResult {
    const role = (value: RoleQualificationStatus): RoleQualificationStatus => {
        const diagnostics = value.diagnostics;
        return { state: value.state, reason: value.reason, ...(diagnostics ? { diagnostics: {
            contractVersion: diagnostics.contractVersion, reasonCode: diagnostics.reasonCode,
            reasonCodes: [...diagnostics.reasonCodes], failureKind: diagnostics.failureKind,
            executionState: diagnostics.executionState, responseShape: {
                characters: diagnostics.responseShape.characters,
                pythonFenceCount: diagnostics.responseShape.pythonFenceCount,
                jsonObject: diagnostics.responseShape.jsonObject,
                ...(diagnostics.responseShape.findingsCount === undefined ? {}
                    : { findingsCount: diagnostics.responseShape.findingsCount }),
                ...(diagnostics.responseShape.legacyBlockingCount === undefined ? {}
                    : { legacyBlockingCount: diagnostics.responseShape.legacyBlockingCount }),
                ...(diagnostics.responseShape.legacyQualityCount === undefined ? {}
                    : { legacyQualityCount: diagnostics.responseShape.legacyQualityCount })
            }
        } } : {}) };
    };
    return { qualificationRuntime: { version: result.qualificationRuntime.version, numCtx: result.qualificationRuntime.numCtx },
        qualificationVersion: result.qualificationVersion,
        roleQualification: { writer: role(result.roleQualification.writer), reviewer: role(result.roleQualification.reviewer),
            bugFixer: role(result.roleQualification.bugFixer) },
        testGenerationReady: result.testGenerationReady, testGenerationMode: result.testGenerationMode,
        testGenerationReason: result.testGenerationReason };
}

/** Short-lived batch memory. No globalState, saved preferences, or cross-batch singleton. */
export class RuntimeQualificationSession {
    private readonly results = new Map<string, LocalRuntimeRequalificationResult>();
    constructor(readonly batchId: string) {
        if (!batchId.trim()) { throw new Error('qualification-session-requires-batch'); }
    }

    get(identity: RuntimeQualificationIdentity, includeBugFixer = false): LocalRuntimeRequalificationResult | undefined {
        const key = identityKey(identity);
        const result = key ? this.results.get(key) : undefined;
        if (!result || includeBugFixer && !completedEvidence(result.roleQualification.bugFixer)) { return undefined; }
        return copyResult(result);
    }

    /** Only complete contract/runtime verdicts can be reused. Unavailability remains retryable. */
    set(identity: RuntimeQualificationIdentity, result: LocalRuntimeRequalificationResult): boolean {
        const key = identityKey(identity);
        if (!key || result.qualificationVersion !== identity.qualificationVersion
            || result.qualificationRuntime.version !== LOCAL_RUNTIME_QUALIFICATION_VERSION
            || result.qualificationRuntime.numCtx !== identity.numCtx
            || !completedEvidence(result.roleQualification.writer) || !completedEvidence(result.roleQualification.reviewer)) { return false; }
        const copied = copyResult(result);
        if (!completedEvidence(copied.roleQualification.bugFixer)) {
            const previous = this.results.get(key);
            if (previous && completedEvidence(previous.roleQualification.bugFixer)) {
                copied.roleQualification.bugFixer = copyResult(previous).roleQualification.bugFixer;
            } else if (copied.roleQualification.bugFixer.diagnostics?.failureKind === 'unavailable') {
                // Keep W/R evidence; this is missing Fixer evidence, not a cached transport verdict.
                copied.roleQualification.bugFixer = { state: 'not-run', reason: 'Bug Fixer needs a completed runtime probe.',
                    diagnostics: { contractVersion: 'bug-fixer-probe-v8', reasonCode: 'bug-fixer-not-run',
                        reasonCodes: ['bug-fixer-not-run'], failureKind: 'unavailable', executionState: 'not-run',
                        responseShape: { characters: 0, pythonFenceCount: 0, jsonObject: false } } };
            }
        }
        this.results.set(key, copied);
        return true;
    }

    /** Runtime, environment, source, or fixture drift invalidates the owned session. */
    clear(): void { this.results.clear(); }

    get size(): number { return this.results.size; }
}

export interface RuntimeRoleAuthorizationOptions {
    policy: 'auto' | 'manual' | 'optional';
    role: keyof RoleQualificationProfile;
    qualification: RoleQualificationProfile | undefined;
    /** Must be established by exact endpoint/model/capacity/Python/scope/version binding. */
    currentIdentity: boolean;
}

/** Role availability does not approve any actual candidate or authorize mutation. */
export function runtimeRoleAuthorization(options: RuntimeRoleAuthorizationOptions): {
    allowed: boolean; reasonCode: 'runtime-identity-mismatch' | 'role-verified' | 'manual-unverified-attempt'
        | 'role-unavailable' | 'auto-role-unverified' | 'optional-unverified-attempt'; roleState: RoleQualificationStatus['state']
} {
    const status = options.qualification?.[options.role];
    const roleState = status?.state ?? 'not-run';
    if (!options.currentIdentity) { return { allowed: false, reasonCode: 'runtime-identity-mismatch', roleState }; }
    if (options.policy === 'optional') { return { allowed: true, reasonCode: roleState === 'verified'
        ? 'role-verified' : 'optional-unverified-attempt', roleState }; }
    if (status?.diagnostics?.failureKind === 'unavailable') {
        return { allowed: false, reasonCode: 'role-unavailable', roleState };
    }
    if (roleState === 'verified') { return { allowed: true, reasonCode: 'role-verified', roleState }; }
    return options.policy === 'manual'
        ? { allowed: true, reasonCode: 'manual-unverified-attempt', roleState }
        : { allowed: false, reasonCode: 'auto-role-unverified', roleState };
}
