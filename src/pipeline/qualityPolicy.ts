import { createHash } from 'node:crypto';
import { MutationContext, MutationScope, readStoredMutationRun } from '../mutation/mutationResult';
import { TargetCoverageAssessment } from '../mutation/targetCoverage';

// Static require lets the production bundler embed the same portable definition
// that the Python scorecard reads; no deployment-relative filesystem lookup.
const definition = require('../../contracts/quality-policy-v1.json') as {
    schemaVersion: 'quality-policy-v1'; assessmentVersion: 'quality-assessment-v1';
    policyIds: Record<'strict100' | 'fixture', string>; fixed: Record<string, string>;
    strictThresholds: { lineThreshold: ExactRatio; mutationThreshold: ExactRatio }; coverageVersion: string;
};

export interface ExactRatio { numerator: number; denominator: number }
export interface QualityPolicySnapshot {
    schemaVersion: 'quality-policy-v1'; policyId: string; mode: 'strict100' | 'fixture'; policyHash: string;
    lineThreshold: ExactRatio; mutationThreshold: ExactRatio;
    scopeVersion: string; branchPolicy: string; mutationPolicy: string; noCandidatePolicy: string;
    reviewPolicy: string; baselinePolicy: string; timeoutPolicy: string;
    fixture?: { fixtureId: string; manifestHash: string };
}
export interface QualityEvidenceIdentity extends MutationContext { policyHash: string }
export interface QualityCoverageEvidence {
    sourceHash: string; testHash: string; targetScope: MutationScope; assessment: TargetCoverageAssessment;
}
export interface QualityEvidenceInput {
    identity: QualityEvidenceIdentity;
    executionPassed: boolean;
    coverage: QualityCoverageEvidence;
    mutation: unknown;
    reviewStatus: string;
    generationMode?: string | null;
    /** Additional validated blockers; mutation survivors belong in MutationRun. */
    qualityGaps: readonly string[];
}
export interface QualityAssessment {
    schemaVersion: 'quality-assessment-v1'; policyHash: string | null;
    evidenceIdentity: QualityEvidenceIdentity | null;
    measurementStatus: 'complete' | 'partial' | 'unavailable' | 'not-applicable';
    policyStatus: 'met' | 'below-threshold' | 'unassessable';
    reviewStatus: string; toolsSatisfied: boolean; fullyPassed: boolean; reasons: string[];
    counts: { lines: { executed: number; total: number } | null;
        mutation: { killed: number; total: number; available: number | null } | null };
}
export type QualityPolicyValidation = { ok: true; policy: QualityPolicySnapshot } | { ok: false; reason: string };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value);
const keysAre = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join('\n') === keys.sort().join('\n');
const ratio = (value: unknown): value is ExactRatio => object(value) && keysAre(value, ['numerator', 'denominator'])
    && integer(value.numerator) && integer(value.denominator) && value.denominator > 0
    && value.numerator <= value.denominator;

/** Canonical UTF-8 JSON for this contract's strings, booleans and safe integers. */
export function canonicalQualityJson(value: unknown): string {
    if (Array.isArray(value)) { return '[' + value.map(canonicalQualityJson).join(',') + ']'; }
    if (object(value)) {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalQualityJson(value[key])).join(',') + '}';
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || integer(value)) { return JSON.stringify(value); }
    throw new Error('Unsupported canonical quality value');
}
export function qualityPolicyHash(value: Omit<QualityPolicySnapshot, 'policyHash'> | Record<string, unknown>): string {
    const { policyHash: _ignored, ...snapshot } = value as Record<string, unknown>;
    return createHash('sha256').update(canonicalQualityJson(snapshot), 'utf8').digest('hex');
}
function freezePolicy(value: QualityPolicySnapshot): QualityPolicySnapshot {
    Object.freeze(value.lineThreshold); Object.freeze(value.mutationThreshold);
    if (value.fixture) { Object.freeze(value.fixture); }
    return Object.freeze(value);
}
function createPolicy(mode: 'strict100' | 'fixture', thresholds: { lineThreshold: ExactRatio; mutationThreshold: ExactRatio },
    fixture?: QualityPolicySnapshot['fixture']): QualityPolicySnapshot {
    const value = { schemaVersion: definition.schemaVersion, policyId: definition.policyIds[mode], mode,
        ...definition.fixed, ...thresholds, ...(fixture ? { fixture } : {}) };
    const result = validateQualityPolicy({ ...value, policyHash: qualityPolicyHash(value) });
    if (!result.ok) { throw new Error(result.reason); }
    return result.policy;
}
export function createStrictQualityPolicy(): QualityPolicySnapshot {
    return createPolicy('strict100', JSON.parse(JSON.stringify(definition.strictThresholds)));
}
export function createFixtureQualityPolicy(input: {
    fixtureId: string; manifestHash: string; minLineCoverage: number; minMutationScore: number;
}): QualityPolicySnapshot {
    if (![input.minLineCoverage, input.minMutationScore].every(value => integer(value) && value <= 100)) {
        throw new Error('Fixture thresholds must be integer percentages between 0 and 100');
    }
    return createPolicy('fixture', { lineThreshold: { numerator: input.minLineCoverage, denominator: 100 },
        mutationThreshold: { numerator: input.minMutationScore, denominator: 100 } },
    { fixtureId: input.fixtureId, manifestHash: input.manifestHash });
}
export function validateQualityPolicy(raw: unknown): QualityPolicyValidation {
    const fail = (): QualityPolicyValidation => ({ ok: false, reason: 'invalid-quality-policy' });
    if (!object(raw) || (raw.mode !== 'strict100' && raw.mode !== 'fixture') || !digest(raw.policyHash)
        || raw.schemaVersion !== definition.schemaVersion || raw.policyId !== definition.policyIds[raw.mode as 'strict100' | 'fixture']
        || !ratio(raw.lineThreshold) || !ratio(raw.mutationThreshold)) { return fail(); }
    const expectedKeys = ['schemaVersion', 'policyId', 'mode', 'policyHash', 'lineThreshold', 'mutationThreshold', ...Object.keys(definition.fixed)];
    if (Object.entries(definition.fixed).some(([key, value]) => raw[key] !== value)) { return fail(); }
    if (raw.mode === 'fixture') {
        expectedKeys.push('fixture');
        if (!object(raw.fixture) || !keysAre(raw.fixture, ['fixtureId', 'manifestHash'])
            || !safeId(raw.fixture.fixtureId) || !digest(raw.fixture.manifestHash)) { return fail(); }
    } else if (canonicalQualityJson({ lineThreshold: raw.lineThreshold, mutationThreshold: raw.mutationThreshold })
        !== canonicalQualityJson(definition.strictThresholds)) { return fail(); }
    if (!keysAre(raw, expectedKeys) || qualityPolicyHash(raw) !== raw.policyHash) { return fail(); }
    return { ok: true, policy: freezePolicy(JSON.parse(JSON.stringify(raw)) as QualityPolicySnapshot) };
}

function validScope(value: unknown): value is MutationScope {
    return object(value) && value.kind === 'function' && typeof value.qualifiedName === 'string' && Boolean(value.qualifiedName.trim())
        && ['startLine', 'endLine'].every(key => value[key] === undefined || (integer(value[key]) && value[key] > 0))
        && !(typeof value.startLine === 'number' && typeof value.endLine === 'number' && value.startLine > value.endLine);
}
function sameScope(value: unknown, expected: MutationScope): boolean {
    return validScope(value) && value.kind === expected.kind && value.qualifiedName === expected.qualifiedName
        && ['startLine', 'endLine'].every(key => (value as unknown as Record<string, unknown>)[key]
            === (expected as unknown as Record<string, unknown>)[key]);
}
function lineSet(value: unknown): value is number[] {
    return Array.isArray(value) && value.every(line => integer(line) && line > 0) && new Set(value).size === value.length;
}
function validBranch(value: unknown, lines: number[]): boolean {
    if (typeof value !== 'string' || !/^\d+->-?\d+$/.test(value)) { return false; }
    const [from, to] = value.split('->').map(Number);
    return Number.isSafeInteger(from) && lines.includes(from) && Number.isSafeInteger(to) && to !== 0;
}
function meets(executed: number, total: number, threshold: ExactRatio): boolean {
    return total > 0 && BigInt(executed) * BigInt(threshold.denominator) >= BigInt(total) * BigInt(threshold.numerator);
}

/** Pure evaluation of one saved candidate. Termination and batching stay with
 * the caller: a good retained baseline never turns a cancelled run successful. */
export function evaluateQuality(policyRaw: unknown, evidence: QualityEvidenceInput): QualityAssessment {
    const validated = validateQualityPolicy(policyRaw);
    const result: QualityAssessment = { schemaVersion: definition.assessmentVersion,
        policyHash: validated.ok ? validated.policy.policyHash : null, evidenceIdentity: null,
        measurementStatus: 'unavailable', policyStatus: 'unassessable',
        reviewStatus: typeof evidence?.reviewStatus === 'string' ? evidence.reviewStatus : 'unknown',
        toolsSatisfied: false, fullyPassed: false, reasons: [], counts: { lines: null, mutation: null } };
    const fail = (reason: string): QualityAssessment => { result.reasons.push(reason); return result; };
    if (!validated.ok) { return fail(validated.reason); }
    const policy = validated.policy, identity = evidence?.identity;
    if (!object(identity) || typeof identity.sourcePath !== 'string' || !identity.sourcePath
        || !digest(identity.sourceHash) || !digest(identity.testHash) || !validScope(identity.targetScope)
        || identity.policyHash !== policy.policyHash
        || (identity.stageTimeoutSeconds !== undefined && (typeof identity.stageTimeoutSeconds !== 'number'
            || !Number.isFinite(identity.stageTimeoutSeconds) || identity.stageTimeoutSeconds <= 0))) { return fail('quality-identity-mismatch'); }
    result.evidenceIdentity = JSON.parse(JSON.stringify(identity));
    if (evidence.executionPassed !== true) { return fail('execution-not-passed'); }
    if (!Array.isArray(evidence.qualityGaps) || !evidence.qualityGaps.every(item => typeof item === 'string')) { return fail('invalid-quality-gaps'); }
    const coverage = evidence.coverage;
    if (!object(coverage) || coverage.sourceHash !== identity.sourceHash || coverage.testHash !== identity.testHash
        || !sameScope(coverage.targetScope, identity.targetScope) || !object(coverage.assessment)) { return fail('coverage-identity-mismatch'); }
    const measured = coverage.assessment;
    if (measured.available !== true || measured.evidenceVersion !== definition.coverageVersion || measured.scopeStatus !== 'verified'
        || !object(measured.invocationEvidence) || measured.invocationEvidence.testHash !== identity.testHash
        || typeof measured.invocationEvidence.testRunId !== 'string' || !measured.invocationEvidence.testRunId
        || typeof measured.invocationEvidence.observed !== 'boolean' || measured.targetExecuted !== measured.invocationEvidence.observed
        || !lineSet(measured.executableTargetLines) || measured.executableTargetLines.length === 0
        || !lineSet(measured.missingTargetLines) || !measured.missingTargetLines.every(line => measured.executableTargetLines!.includes(line))
        || measured.targetFullyCovered !== (measured.targetExecuted === true && measured.missingTargetLines.length === 0)
        || typeof measured.targetBranchesCovered !== 'boolean' || !Array.isArray(measured.missingTargetBranches)
        || !measured.missingTargetBranches.every(item => validBranch(item, measured.executableTargetLines!))
        || new Set(measured.missingTargetBranches).size !== measured.missingTargetBranches.length
        || measured.targetBranchesCovered !== (measured.missingTargetBranches.length === 0)) { return fail('invalid-coverage-evidence'); }
    result.counts.lines = { total: measured.executableTargetLines.length,
        executed: measured.targetExecuted ? measured.executableTargetLines.length - measured.missingTargetLines.length : 0 };
    const mutation = readStoredMutationRun(evidence.mutation, identity);
    if (!mutation.ok) { return fail('invalid-mutation-evidence'); }
    const run = mutation.run;
    result.counts.mutation = { killed: run.counts.killed, total: run.counts.selected, available: run.counts.available };
    if (run.status === 'no-candidates') { result.measurementStatus = 'not-applicable'; return fail('no-mutation-candidates'); }
    if (run.status === 'partial') { result.measurementStatus = 'partial'; return fail('mutation-incomplete'); }
    if (run.status !== 'complete' || !run.scoreAvailable || !run.baselinePassed) { return fail('mutation-unavailable'); }
    result.measurementStatus = 'complete';
    const reasons = result.reasons;
    if (!measured.targetExecuted) { reasons.push('target-not-executed'); }
    if (!meets(result.counts.lines.executed, result.counts.lines.total, policy.lineThreshold)) { reasons.push('line-threshold-not-met'); }
    if (!measured.targetBranchesCovered) { reasons.push('branches-not-covered'); }
    if (!meets(run.counts.killed, run.counts.selected, policy.mutationThreshold)) { reasons.push('mutation-threshold-not-met'); }
    if (evidence.qualityGaps.length) { reasons.push('additional-quality-gaps'); }
    result.toolsSatisfied = reasons.length === 0;
    result.policyStatus = result.toolsSatisfied ? 'met' : 'below-threshold';
    const reviewComplete = evidence.reviewStatus === 'completed'
        || (evidence.reviewStatus === 'not-required' && evidence.generationMode === 'deterministic-fallback');
    if (!reviewComplete) { reasons.push(evidence.reviewStatus === 'incomplete' ? 'review-incomplete' : 'review-provenance-missing'); }
    result.fullyPassed = result.toolsSatisfied && reviewComplete;
    return result;
}
