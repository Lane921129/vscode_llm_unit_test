import { MutationRecord } from '../mutation/mutationResult';
import { evidenceHash } from './analysisJournal';
import { pythonToolPath } from './pythonTools';
import { runSpawn } from '../utils/processRunner';
import { validTraceValueSnapshot } from './traceValues';

export interface QualityExperimentFocus {
    id: string;
    kind: 'coverage' | 'survivor';
    evidence: string;
    line?: number;
    mutant?: MutationRecord;
}
export interface QualityExperimentOutcome {
    fingerprint: string;
    status: 'observed' | 'unavailable';
    reason?: string;
    evidence?: {
        schemaVersion: 'quality-experiment-evidence-v1';
        sourceHash: string; target: string; fingerprint: string;
        constructor: unknown; initialState: unknown;
        context: { sourceRoot: string; importFixturePlanHash: string };
        isolation: 'fresh-process-per-case';
        steps: Array<{ input: unknown; before: unknown; after: unknown; status: 'returned' | 'raised';
            result?: unknown; exception?: string; exceptionArgs?: unknown }>;
    };
}
export interface QualityExperimentResult {
    schemaVersion: 'quality-experiment-result-v1';
    status: 'observed' | 'unsupported' | 'duplicate' | 'unavailable';
    sourceHash: string; target: string; gapId: string;
    context?: { sourceRoot: string; importFixturePlanHash: string };
    reason?: string;
    experiments: QualityExperimentOutcome[];
    testCode?: string; testHash?: string;
    assertionOracle: false;
}
export interface QualityExperimentInput {
    sourcePath: string; source: string; target: string; module: string;
    /** Only pass the retained, successfully executed candidate. */
    testCode: string; focus: QualityExperimentFocus; python: string;
    triedFingerprints?: readonly string[];
    env?: NodeJS.ProcessEnv; timeoutMs?: number;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const replayable = (v: unknown) => validTraceValueSnapshot(v) && v.replayable;

/** The dedicated host runner, not model text, supplies evidence and test code.
 * Callers must execute its independent baseline before merging, and then measure
 * the merged candidate with the same source/dependency/fixture identities. */
export async function prepareQualityExperiments(input: QualityExperimentInput): Promise<QualityExperimentResult> {
    const run = await runSpawn(input.python, ['-B', pythonToolPath('qualityExperiments'), '--run'], {
        input: JSON.stringify({ ...input, python: undefined, env: undefined, timeoutMs: undefined,
            sourceHash: evidenceHash(input.source) }),
        timeout: Math.min(input.timeoutMs ?? 20000, 20000),
        env: { ...(input.env ?? process.env), PYTHONIOENCODING: 'utf-8' }
    });
    if (run.code !== 0) { throw new Error('Quality experiment worker failed; no assertions were adopted.'); }
    const result: unknown = JSON.parse(run.stdout);
    if (!object(result) || result.schemaVersion !== 'quality-experiment-result-v1'
        || !['observed', 'unsupported', 'duplicate', 'unavailable'].includes(result.status)
        || result.assertionOracle !== false || result.sourceHash !== evidenceHash(input.source)
        || result.target !== input.target || result.gapId !== input.focus.id
        || !Array.isArray(result.experiments) || result.experiments.length > 6) {
        throw new Error('Invalid quality experiment identity.');
    }
    const seen = new Set<string>();
    if (result.context !== undefined && (!object(result.context) || typeof result.context.sourceRoot !== 'string'
        || !digest(result.context.importFixturePlanHash))) { throw new Error('Invalid quality execution context.'); }
    for (const item of result.experiments) {
        if (!object(item) || !digest(item.fingerprint) || seen.has(item.fingerprint)
            || !['observed', 'unavailable'].includes(item.status)) { throw new Error('Invalid quality experiment outcome.'); }
        seen.add(item.fingerprint);
        if (item.status !== 'observed') { continue; }
        const e = item.evidence;
        if (!object(e) || e.schemaVersion !== 'quality-experiment-evidence-v1' || e.sourceHash !== result.sourceHash
            || e.target !== result.target || e.fingerprint !== item.fingerprint || e.isolation !== 'fresh-process-per-case'
            || JSON.stringify(e.context) !== JSON.stringify(result.context)
            || !replayable(e.constructor) || !replayable(e.initialState) || !Array.isArray(e.steps)
            || e.steps.length < 1 || e.steps.length > 2 || e.steps.some((step: unknown) => !object(step)
                || !replayable(step.input) || !replayable(step.before) || !replayable(step.after)
                || (step.status === 'returned' ? !replayable(step.result)
                    : step.status !== 'raised' || typeof step.exception !== 'string' || !/^[A-Za-z_]\w*$/.test(step.exception)
                        || !replayable(step.exceptionArgs)))) { throw new Error('Invalid completed quality observation.'); }
    }
    const hasEvidence = result.experiments.some((item: QualityExperimentOutcome) => item.status === 'observed');
    if (result.status === 'observed' ? !hasEvidence || typeof result.testCode !== 'string'
        || result.testCode.length > 250000 || result.testHash !== evidenceHash(result.testCode)
        : hasEvidence || result.testCode !== undefined || result.testHash !== undefined) {
        throw new Error('Quality experiment tests have no matching observation.');
    }
    return result as QualityExperimentResult;
}

export interface QualityCandidateNovelty {
    schemaVersion: 'quality-novelty-v1'; novelMethods: number; previousMethods: number;
    candidateMethods: number; fingerprints: string[];
}

/** Cheap pre-measurement check: renamed/duplicated bodies are not new work. */
export async function assessQualityCandidateNovelty(previous: string, candidate: string, python: string,
    env?: NodeJS.ProcessEnv): Promise<QualityCandidateNovelty> {
    const run = await runSpawn(python, ['-B', pythonToolPath('qualityExperiments'), '--novelty'], {
        input: JSON.stringify({ previous, candidate }), timeout: 5000, env: { ...(env ?? process.env), PYTHONIOENCODING: 'utf-8' }
    });
    if (run.code !== 0) { throw new Error('Could not establish candidate novelty.'); }
    const value = JSON.parse(run.stdout);
    if (value.schemaVersion !== 'quality-novelty-v1' || !['novelMethods', 'previousMethods', 'candidateMethods']
        .every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) || !Array.isArray(value.fingerprints)
        || !value.fingerprints.every(digest)) { throw new Error('Invalid quality novelty result.'); }
    return value;
}

/** Merge only host-owned classes. Explicit restore replaces those exact class
 * names from a retained bundle; unrelated model tests are never overwritten. */
export async function mergeQualityExperimentTests(previous: string, addition: string, python: string,
    options: { restore?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: string; testHash: string; classes: string[] }> {
    const run = await runSpawn(python, ['-B', pythonToolPath('qualityExperiments'), '--merge'], {
        input: JSON.stringify({ previous, addition, restore: options.restore === true }), timeout: 5000,
        env: { ...(options.env ?? process.env), PYTHONIOENCODING: 'utf-8' }
    });
    if (run.code !== 0) { throw new Error('Host quality tests could not be merged without a binding collision.'); }
    const value = JSON.parse(run.stdout);
    if (value.schemaVersion !== 'quality-merge-v1' || typeof value.code !== 'string'
        || value.code.length > 500000 || value.testHash !== evidenceHash(value.code)
        || !Array.isArray(value.classes) || !value.classes.every((name: unknown) => typeof name === 'string'
            && /^TestVerifiedState_[a-f0-9]{16}$/.test(name))) { throw new Error('Invalid host quality merge.'); }
    return value;
}
