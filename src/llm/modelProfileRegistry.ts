import { ModelQualificationProfile, ModelQualificationRequest, qualificationForRequest, qualificationEndpointKey, QUALIFICATION_VERSION } from './modelQualification';

export interface StoredModelProfile extends ModelQualificationProfile {
    envType: 'local' | 'cloud' | 'custom';
    modelName: string;
    paramSize: string;
    contextLength: number;
}

const MAX_STORED_PROFILES = 50;

/** A stable identity for non-secret model capability metadata. */
export function modelProfileKey(request: ModelQualificationRequest): string {
    // Google may expose the same model with or without the resource prefix.
    // Only a non-secret endpoint digest is stored; credentials are never identity.
    const model = request.modelName.trim().replace(/^models\//i, '').toLowerCase();
    return `${request.envType}:${request.endpointKey || qualificationEndpointKey(request.envType)}:${model}`;
}

function invalidateOldQualification(profile: StoredModelProfile): StoredModelProfile {
    if (profile.testGenerationReady === undefined || profile.qualificationVersion === QUALIFICATION_VERSION) { return profile; }
    return { ...profile, testGenerationReady: false,
        testGenerationReason: `舊探針結果已過期（原格式：${profile.testGenerationMode || '未知'}）；請重新執行測試連線。` };
}

export function isStoredModelProfile(value: unknown): value is StoredModelProfile {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const profile = value as Partial<StoredModelProfile>;
    return (
        (profile.envType === 'local' || profile.envType === 'cloud' || profile.envType === 'custom')
        && typeof profile.modelName === 'string' && profile.modelName.trim().length > 0
        && typeof profile.paramSize === 'string'
        && typeof profile.contextLength === 'number' && Number.isFinite(profile.contextLength)
    );
}

/** Safely discard malformed persisted entries from older extension versions. */
export function restoreModelProfiles(value: unknown): StoredModelProfile[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter(isStoredModelProfile).slice(-MAX_STORED_PROFILES).map(invalidateOldQualification);
}

/** Replace only the matching provider/model entry and retain other probes. */
export function upsertModelProfile(
    profiles: StoredModelProfile[],
    profile: StoredModelProfile
): StoredModelProfile[] {
    const key = modelProfileKey(profile);
    return [
        ...profiles.filter(existing => modelProfileKey(existing) !== key),
        profile
    ].slice(-MAX_STORED_PROFILES);
}

/** Return qualification and context metadata for the model selected in this run. */
export function findModelProfile(
    profiles: StoredModelProfile[],
    request: ModelQualificationRequest
): StoredModelProfile | undefined {
    const key = modelProfileKey(request);
    const found = profiles.find(profile => modelProfileKey(profile) === key);
    return found ? invalidateOldQualification(found) : undefined;
}

/**
 * Unknown is only neutral before any probe has happened. Once a different
 * model has a probe result, an unknown selected model must not inherit it.
 */
export function qualificationForSelectedProfile(
    profiles: StoredModelProfile[],
    request: ModelQualificationRequest,
    hasProbeInCurrentSession: boolean
): boolean | undefined {
    const profile = findModelProfile(profiles, request);
    if (profile) {
        return qualificationForRequest(profile, request);
    }
    return hasProbeInCurrentSession ? false : undefined;
}
