import { MutationRecord } from '../mutation/mutationResult';
import { evidenceHash } from './analysisJournal';
import { pythonToolPath } from './pythonTools';
import { runSpawn } from '../utils/processRunner';
import { validTraceValueSnapshot } from './traceValues';
import { containsCredential, redactCredentialStrings } from './artifactSafety';
import { TraceValueSnapshot } from './evidenceContracts';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface QualityExperimentFocus {
    id: string;
    kind: 'coverage' | 'survivor';
    evidence: string;
    line?: number;
    mutant?: MutationRecord;
}
export interface QualityExperimentContext {
    sourceRoot: string; sourcePath: string; module: string; importFixturePlanHash: string;
}
export interface QualityExperimentOutcome {
    fingerprint: string;
    status: 'observed' | 'unavailable';
    reason?: string;
    evidenceHash?: string;
    evidence?: {
        schemaVersion: 'quality-experiment-evidence-v2';
        sourceHash: string; target: string; gapId: string; fingerprint: string;
        constructor: TraceValueSnapshot; calls: TraceValueSnapshot[]; initialState: TraceValueSnapshot;
        observe: { instanceAttributes: string[]; exceptionArgs: true };
        context: QualityExperimentContext;
        isolation: 'fresh-process-per-case';
        steps: Array<{ input: TraceValueSnapshot; before: TraceValueSnapshot; after: TraceValueSnapshot; status: 'returned' | 'raised';
            result?: TraceValueSnapshot; exception?: string; exceptionArgs?: TraceValueSnapshot }>;
    };
}
export interface QualityExperimentResult {
    schemaVersion: 'quality-experiment-result-v2';
    status: 'observed' | 'unsupported' | 'duplicate' | 'unavailable';
    sourceHash: string; target: string; gapId: string;
    context?: QualityExperimentContext;
    reason?: string;
    experiments: QualityExperimentOutcome[];
    assertionOracle: false;
}
export interface QualityExperimentInput {
    sourcePath: string; source: string; target: string; module: string;
    /** Only pass the retained, successfully executed candidate. */
    testCode: string; focus: QualityExperimentFocus; python: string;
    triedFingerprints?: readonly string[];
    knownSecrets?: readonly string[];
    env?: NodeJS.ProcessEnv; timeoutMs?: number;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).sort().join('|') === keys.sort().join('|');
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(v);
const reason = (v: unknown): boolean => v === undefined || typeof v === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,179}$/.test(v);
const replayable = (v: unknown): v is TraceValueSnapshot => {
    if (!validTraceValueSnapshot(v) || !v.replayable || !exactKeys(v as unknown as Record<string, unknown>, ['schema_version', 'replayable', 'value'])) { return false; }
    const exactValue = (node: any): boolean => {
        if (['dict', 'list', 'tuple', 'set', 'frozenset'].includes(node.type)) {
            return exactKeys(node, ['type', 'items']) && node.items.every((item: any) => node.type === 'dict'
                ? exactKeys(item, ['key', 'value']) && exactValue(item.key) && exactValue(item.value) : exactValue(item));
        }
        return exactKeys(node, node.type === 'none' ? ['type'] : ['type', 'value']);
    };
    return exactValue(v.value);
};

/** Match Python's canonical JSON for identity hashes; Unicode stays lossless. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) { return `[${value.map(canonical).join(',')}]`; }
    if (object(value)) { return `{${Object.keys(value).sort().map(key => `${canonical(key)}:${canonical(value[key])}`).join(',')}}`; }
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const sensitive = (value: unknown, knownSecrets: readonly string[] = []): boolean => containsCredential(JSON.stringify(value), knownSecrets)
    || !same(value, redactCredentialStrings(value, knownSecrets));

function validCall(value: unknown): value is TraceValueSnapshot {
    if (!replayable(value) || value.value.type !== 'dict' || value.value.items?.length !== 2) { return false; }
    const items = value.value.items as Array<{ key: { type: string; value?: unknown }; value: { type: string; items?: unknown[] } }>;
    const fields = new Map(items.map(item => [item.key.type === 'str' ? item.key.value : undefined, item.value]));
    return fields.size === 2 && fields.get('args')?.type === 'list' && fields.get('kwargs')?.type === 'dict'
        && (fields.get('args')!.items?.length ?? 7) <= 6
        && (fields.get('kwargs')!.items?.length ?? 7) <= 6
        && fields.get('kwargs')!.items!.every(item => object(item) && item.key?.type === 'str' && identifier(item.key.value));
}

function validState(value: unknown, attributes: string[]): value is TraceValueSnapshot {
    if (!replayable(value) || value.value.type !== 'dict') { return false; }
    const items = value.value.items as Array<{ key: { type: string; value?: unknown } }>;
    return items.length === attributes.length && same(items.map(item => item.key.type === 'str' ? item.key.value : null).sort(), [...attributes].sort());
}

/** Validate the complete source/context/call identity before any prompt projection. */
export function validateQualityExperimentResult(value: unknown): asserts value is QualityExperimentResult {
    if (!object(value) || value.schemaVersion !== 'quality-experiment-result-v2'
        || !['observed', 'unsupported', 'duplicate', 'unavailable'].includes(value.status)
        || value.assertionOracle !== false || !digest(value.sourceHash) || typeof value.target !== 'string'
        || value.target.length > 512 || !value.target.split('.').every(identifier) || typeof value.gapId !== 'string'
        || value.gapId.length > 512 || !Array.isArray(value.experiments) || value.experiments.length > 6
        || !reason(value.reason) || !exactKeys(value, ['schemaVersion', 'status', 'sourceHash', 'target', 'gapId', 'experiments',
            'assertionOracle', ...(value.context === undefined ? [] : ['context']), ...(value.reason === undefined ? [] : ['reason'])])) {
        throw new Error('Invalid quality experiment identity.');
    }
    const context = value.context;
    if (context !== undefined && (!object(context) || !exactKeys(context, ['sourceRoot', 'sourcePath', 'module', 'importFixturePlanHash'])
        || typeof context.sourceRoot !== 'string' || typeof context.sourcePath !== 'string'
        || typeof context.module !== 'string' || !context.module.split('.').every(identifier)
        || !digest(context.importFixturePlanHash))) { throw new Error('Invalid quality execution context.'); }
    const seen = new Set<string>();
    for (const item of value.experiments) {
        if (!object(item) || !digest(item.fingerprint) || seen.has(item.fingerprint)
            || !['observed', 'unavailable'].includes(item.status) || !reason(item.reason)
            || !exactKeys(item, item.status === 'observed' ? ['fingerprint', 'status', 'evidence', 'evidenceHash']
                : ['fingerprint', 'status', ...(item.reason === undefined ? [] : ['reason'])])) { throw new Error('Invalid quality experiment outcome.'); }
        seen.add(item.fingerprint);
        if (item.status !== 'observed') {
            if (item.evidence !== undefined || item.evidenceHash !== undefined) { throw new Error('Unavailable quality experiment contains evidence.'); }
            continue;
        }
        const e = item.evidence;
        if (!object(e) || e.schemaVersion !== 'quality-experiment-evidence-v2' || e.sourceHash !== value.sourceHash
            || !exactKeys(e, ['schemaVersion', 'sourceHash', 'target', 'gapId', 'fingerprint', 'constructor', 'calls', 'observe',
                'initialState', 'steps', 'context', 'isolation'])
            || e.target !== value.target || e.gapId !== value.gapId || e.fingerprint !== item.fingerprint
            || e.isolation !== 'fresh-process-per-case' || !context || !same(e.context, context)
            || !validCall(e.constructor) || !Array.isArray(e.calls) || e.calls.length < 1 || e.calls.length > 2 || !e.calls.every(validCall)
            || !object(e.observe) || !exactKeys(e.observe, ['instanceAttributes', 'exceptionArgs']) || e.observe.exceptionArgs !== true
            || !Array.isArray(e.observe.instanceAttributes) || e.observe.instanceAttributes.length < 1 || e.observe.instanceAttributes.length > 4
            || !e.observe.instanceAttributes.every((name: unknown) => identifier(name) && !name.startsWith('__'))
            || new Set(e.observe.instanceAttributes).size !== e.observe.instanceAttributes.length
            || !validState(e.initialState, e.observe.instanceAttributes) || !Array.isArray(e.steps)
            || e.steps.length < 1 || e.steps.length > e.calls.length) { throw new Error('Invalid completed quality observation.'); }
        const calculatedFingerprint = evidenceHash(canonical({ schemaVersion: 'quality-experiment-v2', sourceHash: e.sourceHash,
            target: e.target, constructor: e.constructor, calls: e.calls, observe: e.observe, context: e.context }));
        if (calculatedFingerprint !== item.fingerprint || item.evidenceHash !== evidenceHash(canonical(e))) {
            throw new Error('Quality observation hash mismatch.');
        }
        let previous = e.initialState;
        for (const [index, step] of e.steps.entries()) {
            if (!object(step) || !validCall(step.input) || !same(step.input, e.calls[index])
                || !exactKeys(step, ['input', 'before', 'after', 'status', ...(step.status === 'returned' ? ['result'] : ['exception', 'exceptionArgs'])])
                || !validState(step.before, e.observe.instanceAttributes) || !validState(step.after, e.observe.instanceAttributes)
                || !same(previous, step.before)
                || (step.status === 'returned' ? !replayable(step.result) || step.exception !== undefined || step.exceptionArgs !== undefined
                    : step.status !== 'raised' || !identifier(step.exception) || step.result !== undefined
                        || !replayable(step.exceptionArgs) || step.exceptionArgs.value.type !== 'tuple' || index !== e.steps.length - 1)) {
                throw new Error('Invalid quality observation sequence.');
            }
            previous = step.after;
        }
        if (e.steps.length !== e.calls.length && e.steps.at(-1).status !== 'raised') { throw new Error('Incomplete quality observation sequence.'); }
    }
    const observed = value.experiments.some((item: QualityExperimentOutcome) => item.status === 'observed');
    if (observed !== (value.status === 'observed')) { throw new Error('Quality experiment status has no matching observation.'); }
}

/** The host returns isolated observations only. Writer authors every test, which
 * must then pass execution, independent review and mutation gates. */
export async function prepareQualityExperiments(input: QualityExperimentInput): Promise<QualityExperimentResult> {
    const run = await runSpawn(input.python, ['-B', pythonToolPath('qualityExperiments'), '--run'], {
        input: JSON.stringify({ ...input, python: undefined, env: undefined, timeoutMs: undefined, knownSecrets: undefined,
            sourceHash: evidenceHash(input.source) }),
        timeout: Math.min(input.timeoutMs ?? 20000, 20000),
        env: { ...(input.env ?? process.env), PYTHONIOENCODING: 'utf-8' }
    });
    if (run.code !== 0) { throw new Error('Quality experiment worker failed; no observations were adopted.'); }
    if (containsCredential(run.stdout, input.knownSecrets)) { throw new Error('Sensitive quality observation was withheld.'); }
    const result: unknown = JSON.parse(run.stdout);
    if (sensitive(result, input.knownSecrets)) { throw new Error('Sensitive quality observation was withheld.'); }
    validateQualityExperimentResult(result);
    if (result.sourceHash !== evidenceHash(input.source) || result.target !== input.target || result.gapId !== input.focus.id) {
        throw new Error('Invalid quality experiment identity.');
    }
    if (result.context) {
        const sourcePath = fs.realpathSync(input.sourcePath);
        let root = path.dirname(sourcePath);
        while (fs.existsSync(path.join(root, '__init__.py'))) { root = path.dirname(root); }
        if (path.resolve(result.context.sourceRoot) !== root || path.resolve(result.context.sourcePath) !== sourcePath
            || result.context.module !== input.module
            || result.context.importFixturePlanHash !== evidenceHash((input.env ?? process.env).LLM_UNIT_TEST_IMPORT_FIXTURES ?? '')) {
            throw new Error('Quality observation execution context mismatch.');
        }
    }
    return result;
}

/** Omit whole cases to fit the prompt budget; never truncate a typed value or JSON. */
export function buildQualityExperimentEvidencePrompt(result: QualityExperimentResult, maxChars = 12000,
    knownSecrets: readonly string[] = [], onProjected?: (fingerprints: readonly string[]) => void): string {
    validateQualityExperimentResult(result);
    if (!Number.isSafeInteger(maxChars) || maxChars < 0) { throw new Error('Invalid quality evidence prompt budget.'); }
    const instructions = 'QUALITY_EXPERIMENT_OBSERVATIONS_V2\n'
        + 'These are controlled observations of the current implementation, not an independent specification or a test file. '
        + 'Only the complete included cases support exact assertions. Preserve constructor, ordered calls, typed inputs, before/after state, '
        + 'return or exception type and arguments. Do not infer an omitted value or summarize it into an oracle. '
        + 'gapId identifies the original observation task, which can differ from the current focus. '
        + 'Writer must author the focused unittest addition and preserve passing cases; execution, Reviewer approval and mutation measurement still follow.\n';
    const observed = result.experiments.filter(item => item.status === 'observed');
    // Identity/context and the snapshot wrapper apply to the entire envelope.
    // Each value retains the full typed tree; step.input is the executed call,
    // so planned calls need not duplicate it in the prompt.
    const projectCase = (item: QualityExperimentOutcome) => {
        const e = item.evidence!;
        return { fingerprint: item.fingerprint, evidenceHash: item.evidenceHash,
            constructor: e.constructor.value, initialState: e.initialState.value,
            steps: e.steps.map(step => ({ input: step.input.value, before: step.before.value, after: step.after.value,
                status: step.status, ...(step.status === 'returned' ? { result: step.result!.value }
                    : { exception: step.exception, exceptionArgs: step.exceptionArgs!.value }) })) };
    };
    const selected: ReturnType<typeof projectCase>[] = [];
    const render = () => instructions + JSON.stringify({ schemaVersion: 'quality-writer-evidence-v2', sourceHash: result.sourceHash,
        target: result.target, gapId: result.gapId, assertionOracle: false, context: result.context,
        isolation: 'fresh-process-per-case', valueEncoding: 'trace-value-v1', valuesReplayable: true,
        observedCases: observed.length, includedCases: selected.length, omittedCases: observed.length - selected.length,
        unavailableCases: result.experiments.length - observed.length, experiments: selected });
    const metadata = { sourceHash: result.sourceHash, target: result.target, gapId: result.gapId,
        ...(result.context ? { context: result.context } : {}) };
    if (sensitive(metadata, knownSecrets)) { return ''; }
    for (const item of observed) {
        if (sensitive(item, knownSecrets)) { continue; }
        selected.push(projectCase(item));
        if (render().length > maxChars) { selected.pop(); }
    }
    if (!selected.length) {
        const diagnostic = 'QUALITY_EXPERIMENT_DIAGNOSTIC_V2\n' + JSON.stringify({ includedCases: 0, omittedCases: observed.length,
            unavailableCases: result.experiments.length - observed.length, assertionOracle: false,
            reason: 'No complete safe observation fits this evidence budget; do not infer expected values.' });
        return diagnostic.length <= maxChars ? diagnostic : '';
    }
    const rendered = render();
    onProjected?.(selected.map(item => item.fingerprint));
    return rendered;
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
